// Incremental cost/token tracker for sessions running `claude`. Tails each
// session's own transcript JSONL under ~/.claude/projects/<slug>/<uuid>.jsonl
// (see session-cmd.js:projectDirFor) and accumulates $ cost from `usage`
// blocks, without ever re-reading a file from byte 0 on every tick.
'use strict';

const fs = require('fs');
const path = require('path');
const { projectDirFor } = require('./session-cmd');

// $ per million tokens (input / output). Verified via the claude-api skill,
// cached 2026-06-24 — re-check platform.claude.com/docs/en/pricing if these
// go stale. Claude Sonnet 5 has a time-boxed introductory price that reverts
// to the standard $3/$15 after 2026-08-31 — update SONNET_5 (or make this
// date-aware) once that window closes.
const PRICING = {
  'claude-fable-5': { in: 10.00, out: 50.00 },
  'claude-mythos-5': { in: 10.00, out: 50.00 },
  'claude-opus-4-8': { in: 5.00, out: 25.00 },
  'claude-opus-4-7': { in: 5.00, out: 25.00 },
  'claude-opus-4-6': { in: 5.00, out: 25.00 },
  'claude-opus-4-5': { in: 5.00, out: 25.00 },
  'claude-sonnet-5': { in: 2.00, out: 10.00 },   // intro price, active through 2026-08-31
  'claude-sonnet-4-6': { in: 3.00, out: 15.00 },
  'claude-sonnet-4-5': { in: 3.00, out: 15.00 },
  'claude-haiku-4-5': { in: 1.00, out: 5.00 },
};
const CACHE_WRITE_5M_MULT = 1.25;
const CACHE_WRITE_1H_MULT = 2;
const CACHE_READ_MULT = 0.1;

function resolvePrice(modelId) {
  if (!modelId) return null;
  if (PRICING[modelId]) return PRICING[modelId];
  const stripped = modelId.replace(/-\d{8}$/, ''); // e.g. claude-haiku-4-5-20251001 -> claude-haiku-4-5
  return PRICING[stripped] || null;
}

function emptyTotals() {
  return { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 0 };
}

const READ_CHUNK = 4 * 1024 * 1024;   // parse at most this many bytes per event-loop turn
const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

// Parse a buffer of COMPLETE (newline-terminated) transcript lines into st's
// running totals. Dedups per (message.id, requestId) — see the call site note.
function applyCompleteLines(st, buf) {
  const lines = buf.toString('utf8').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch (_) { continue; } // malformed/partial line — skip
    if (obj.type !== 'assistant' || !obj.message || !obj.message.usage) continue;

    // Dedup: Claude Code writes one transcript line PER content block of an
    // assistant message, and every one repeats the FULL usage for that message
    // (verified against real transcripts — a 3-block message logs the same usage
    // 3×). Counting each line would overstate cost ~2-3×. Key on message.id +
    // requestId (same scheme ccusage uses); only skip when both are present so
    // we never drop a genuinely un-keyed line.
    const msgId = obj.message.id;
    const reqId = obj.requestId;
    if (msgId && reqId) {
      const key = msgId + ':' + reqId;
      if (st.seenKeys.has(key)) continue;
      st.seenKeys.add(key);
    }

    const model = obj.message.model;
    const usage = obj.message.usage;
    let perModel = st.perModel.get(model);
    if (!perModel) { perModel = emptyTotals(); st.perModel.set(model, perModel); }
    const priced = addUsageLine(st.totals, model, usage);
    addUsageLine(perModel, model, usage);
    if (!priced) st.unknownModelSeen = true;
  }
}

function addUsageLine(totals, model, usage) {
  const inTok = usage.input_tokens || 0;
  const outTok = usage.output_tokens || 0;
  const cw5m = (usage.cache_creation && usage.cache_creation.ephemeral_5m_input_tokens != null)
    ? usage.cache_creation.ephemeral_5m_input_tokens
    : (usage.cache_creation_input_tokens || 0);
  const cw1h = (usage.cache_creation && usage.cache_creation.ephemeral_1h_input_tokens) || 0;
  const cr = usage.cache_read_input_tokens || 0;

  totals.inputTokens += inTok;
  totals.outputTokens += outTok;
  totals.cacheCreationTokens += cw5m + cw1h;
  totals.cacheReadTokens += cr;

  if (inTok === 0 && outTok === 0 && cw5m === 0 && cw1h === 0 && cr === 0) return true; // nothing to price (e.g. <synthetic> marker lines)

  const price = resolvePrice(model);
  if (!price) return false; // unknown model — tokens counted, cost withheld
  totals.costUsd += inTok / 1e6 * price.in
    + cw5m / 1e6 * price.in * CACHE_WRITE_5M_MULT
    + cw1h / 1e6 * price.in * CACHE_WRITE_1H_MULT
    + cr / 1e6 * price.in * CACHE_READ_MULT
    + outTok / 1e6 * price.out;
  return true;
}

function createUsageTracker() {
  /** @type {Map<string, object>} sessionId -> tail state */
  const states = new Map();

  // One async pass over every claude session — fs.promises throughout, sessions
  // processed sequentially with awaits so we never hold many fds and never block
  // the event loop (the server keeps serving HTTP/WS/PTYs while this runs).
  async function sample(sessions) {
    // Drop tracker state for sessions that were removed (DELETE) so their cost
    // stops inflating the aggregate and "tracked X/Y" can't exceed live count.
    // A killed-but-still-listed session (exited=true, kept in the Map) is left
    // intact — its cost stays visible until it's actually removed.
    for (const id of [...states.keys()]) {
      if (!sessions.has(id)) states.delete(id);
    }
    for (const s of sessions.values()) {
      if (!s.isClaude || !s.claudeUuid) continue;
      const filePath = path.join(projectDirFor(s.cwd), s.claudeUuid + '.jsonl');
      let st = states.get(s.id);
      if (!st || st.filePath !== filePath) {
        st = {
          filePath, byteOffset: 0, leftover: Buffer.alloc(0),
          totals: emptyTotals(), perModel: new Map(), unknownModelSeen: false,
          seenKeys: new Set(),
        };
        states.set(s.id, st);
      }

      let stat;
      try { stat = await fs.promises.stat(filePath); } catch (_) { continue; } // not written yet / not a claude session
      if (stat.size < st.byteOffset) { // truncated/rotated — defensive, shouldn't normally happen
        st.byteOffset = 0; st.leftover = Buffer.alloc(0);
        st.totals = emptyTotals(); st.perModel.clear(); st.unknownModelSeen = false;
        st.seenKeys.clear();
      }
      if (stat.size <= st.byteOffset) continue;

      // Catch up in bounded chunks, yielding to the event loop between each, so a
      // huge restored transcript (tens of MB) populates in the background without
      // ever blocking the server on one giant parse. targetSize is fixed for this
      // pass; anything appended mid-pass is picked up on the next pass.
      const targetSize = stat.size;
      let fh = null;
      try {
        fh = await fs.promises.open(filePath, 'r');
        while (st.byteOffset < targetSize) {
          const want = Math.min(READ_CHUNK, targetSize - st.byteOffset);
          const chunk = Buffer.alloc(want);
          let got = 0;
          // A single read() may short-read a large range; loop until this chunk
          // is filled, advancing only by bytes actually read.
          while (got < want) {
            const { bytesRead } = await fh.read(chunk, got, want - got, st.byteOffset + got);
            if (bytesRead <= 0) break;
            got += bytesRead;
          }
          if (got === 0) break;
          const slice = got < chunk.length ? chunk.slice(0, got) : chunk;
          const readEnd = st.byteOffset + got;   // absolute position now consumed to
          const combined = Buffer.concat([st.leftover, slice]);
          const lastNl = combined.lastIndexOf(0x0a); // '\n'
          // Advance byteOffset by the FULL bytes read; keep the partial tail only
          // in memory (leftover). Never rewind past it — that would re-read the
          // tail from disk next time and duplicate it.
          st.byteOffset = readEnd;
          if (lastNl === -1) { st.leftover = combined; break; } // no complete line yet
          st.leftover = combined.slice(lastNl + 1);
          applyCompleteLines(st, combined.slice(0, lastNl));
          if (st.byteOffset < targetSize) await yieldToLoop();   // breathe between chunks
        }
      } catch (_) { /* fall through to close; partial progress is kept */ }
      finally { if (fh) { try { await fh.close(); } catch (_) {} } }  // no fd leak on error
    }
  }

  function getSummary(sessionId) {
    const st = states.get(sessionId);
    if (!st) return { hasData: false, costUsd: 0, tokens: emptyTotals(), unknownModel: false, models: [] };
    return {
      hasData: true,
      costUsd: st.totals.costUsd,
      tokens: st.totals,
      unknownModel: st.unknownModelSeen,
      models: [...st.perModel.keys()],
    };
  }

  function getAggregate() {
    const agg = emptyTotals();
    let trackedSessionCount = 0;
    for (const st of states.values()) {
      if (st.totals.inputTokens || st.totals.outputTokens || st.totals.cacheCreationTokens || st.totals.cacheReadTokens) {
        trackedSessionCount++;
      }
      agg.inputTokens += st.totals.inputTokens;
      agg.outputTokens += st.totals.outputTokens;
      agg.cacheCreationTokens += st.totals.cacheCreationTokens;
      agg.cacheReadTokens += st.totals.cacheReadTokens;
      agg.costUsd += st.totals.costUsd;
    }
    return { ...agg, trackedSessionCount };
  }

  // Self-scheduling async poll loop: schedules the NEXT pass only after the
  // current one finishes, so passes never overlap and a slow read just spaces
  // the next one out instead of piling up. Reads happen off the render path —
  // the dashboard renders from getSummary/getAggregate (in-memory, instant).
  let stopped = false;
  function start(getSessions, intervalMs) {
    const ms = intervalMs || 1000;
    const loop = async () => {
      if (stopped) return;
      try { await sample(getSessions()); } catch (_) {}
      if (!stopped) setTimeout(loop, ms);
    };
    loop();
  }
  function stop() { stopped = true; }

  return { sample, start, stop, getSummary, getAggregate };
}

module.exports = { createUsageTracker, resolvePrice, PRICING, addUsageLine, emptyTotals };
