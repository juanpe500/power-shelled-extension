// Per-day historical usage aggregator. Where claude-usage.js tails only the
// live tracked sessions' transcripts and keeps a single running total, this
// module sweeps EVERY transcript under ~/.claude/projects (past sessions too),
// buckets each priced `usage` block by its own local calendar day + model, and
// keeps a rolling window (default 30 days) for the dashboard's history graphs
// (line chart / heatmap / budget bars).
//
// It reuses claude-usage's pricing (addUsageLine) so cost math never diverges.
// The scan runs on its own slow loop (default 20s) off the render path — the
// dashboard reads the in-memory day buckets instantly each frame. Files are
// tailed incrementally by byte offset, exactly like the live tracker, so a
// 30-day sweep never re-reads a file it has already consumed.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { addUsageLine, emptyTotals } = require('./claude-usage');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const READ_CHUNK = 4 * 1024 * 1024;   // parse at most this many bytes per event-loop turn
const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

// Local (not UTC) day key — the graphs are read against the user's wall clock,
// so a message at 00:30 local belongs to today even if it's still "yesterday" in UTC.
function localDayKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

function createHistoryAggregator(opts) {
  opts = opts || {};
  const windowDays = opts.windowDays || 30;
  const intervalMs = opts.intervalMs || 20000;

  // filePath -> { byteOffset, leftover } incremental tail state (mirrors the live tracker)
  const fileStates = new Map();
  // global dedup across ALL files — same (message.id, requestId) scheme the live tracker uses
  const seenKeys = new Set();
  // dayKey -> { totals, perModel: Map(model -> totals) }
  const days = new Map();
  let lastScanAt = 0;
  let scanning = false;

  // Local midnight of the oldest day still inside the window.
  function windowStartMs() {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    start.setDate(start.getDate() - (windowDays - 1));
    return start.getTime();
  }

  function bucketFor(key) {
    let b = days.get(key);
    if (!b) { b = { totals: emptyTotals(), perModel: new Map() }; days.set(key, b); }
    return b;
  }

  function handleLine(line, winStart) {
    let obj;
    try { obj = JSON.parse(line); } catch (_) { return; }
    if (obj.type !== 'assistant' || !obj.message || !obj.message.usage) return;
    const ts = obj.timestamp ? Date.parse(obj.timestamp) : NaN;
    if (!Number.isFinite(ts) || ts < winStart) return; // outside the window — consumed but not counted

    const msgId = obj.message.id, reqId = obj.requestId;
    if (msgId && reqId) {
      const key = msgId + ':' + reqId;
      if (seenKeys.has(key)) return;
      seenKeys.add(key);
    }
    const model = obj.message.model;
    const b = bucketFor(localDayKey(new Date(ts)));
    addUsageLine(b.totals, model, obj.message.usage);
    let pm = b.perModel.get(model);
    if (!pm) { pm = emptyTotals(); b.perModel.set(model, pm); }
    addUsageLine(pm, model, obj.message.usage);
  }

  // Chunked incremental tail of one transcript — same pattern as claude-usage.js:
  // advance byteOffset by bytes actually read, keep the partial tail in `leftover`,
  // parse only complete lines, yield to the loop between chunks.
  async function readFile(filePath, winStart) {
    let stat;
    try { stat = await fs.promises.stat(filePath); } catch (_) { return; }
    let st = fileStates.get(filePath);
    if (!st) { st = { byteOffset: 0, leftover: Buffer.alloc(0) }; fileStates.set(filePath, st); }
    if (stat.size < st.byteOffset) { st.byteOffset = 0; st.leftover = Buffer.alloc(0); } // truncated/rotated
    if (stat.size <= st.byteOffset) return;

    const targetSize = stat.size;
    let fh = null;
    try {
      fh = await fs.promises.open(filePath, 'r');
      while (st.byteOffset < targetSize) {
        const want = Math.min(READ_CHUNK, targetSize - st.byteOffset);
        const chunk = Buffer.alloc(want);
        let got = 0;
        while (got < want) {
          const { bytesRead } = await fh.read(chunk, got, want - got, st.byteOffset + got);
          if (bytesRead <= 0) break;
          got += bytesRead;
        }
        if (got === 0) break;
        const slice = got < chunk.length ? chunk.slice(0, got) : chunk;
        st.byteOffset += got;
        const combined = Buffer.concat([st.leftover, slice]);
        const lastNl = combined.lastIndexOf(0x0a);
        if (lastNl === -1) { st.leftover = combined; break; }
        st.leftover = combined.slice(lastNl + 1);
        const complete = combined.slice(0, lastNl).toString('utf8').split('\n');
        for (const raw of complete) { const l = raw.trim(); if (l) handleLine(l, winStart); }
        if (st.byteOffset < targetSize) await yieldToLoop();
      }
    } catch (_) { /* keep partial progress */ }
    finally { if (fh) { try { await fh.close(); } catch (_) {} } }
  }

  async function scan() {
    if (scanning) return;
    scanning = true;
    const winStart = windowStartMs();
    try {
      let dirents = [];
      try { dirents = await fs.promises.readdir(PROJECTS_DIR, { withFileTypes: true }); } catch (_) { dirents = []; }
      for (const de of dirents) {
        if (!de.isDirectory()) continue;
        const dir = path.join(PROJECTS_DIR, de.name);
        let names = [];
        try { names = await fs.promises.readdir(dir); } catch (_) { continue; }
        for (const name of names) {
          if (!name.endsWith('.jsonl')) continue;
          const fp = path.join(dir, name);
          // A file we've never opened whose last write predates the window can't
          // contain any in-window line — skip the read entirely. Once we're
          // tailing it, always re-check (it may have just gotten new lines).
          if (!fileStates.has(fp)) {
            try { const s = await fs.promises.stat(fp); if (s.mtimeMs < winStart) continue; } catch (_) { continue; }
          }
          await readFile(fp, winStart);
        }
      }
      // Drop day buckets that have aged out of the window.
      for (const k of [...days.keys()]) {
        const [y, m, d] = k.split('-').map(Number);
        if (new Date(y, m - 1, d).getTime() < winStart) days.delete(k);
      }
    } finally {
      scanning = false;
      lastScanAt = Date.now();
    }
  }

  // Dense series: one entry per day across the whole window, oldest first,
  // empty days filled in so the graphs have a continuous x-axis.
  function getSeries() {
    const winStart = windowStartMs();
    const start = new Date(winStart);
    const out = [];
    for (let i = 0; i < windowDays; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const b = days.get(localDayKey(d));
      out.push({
        date: d,
        totals: b ? b.totals : emptyTotals(),
        perModel: b ? b.perModel : new Map(),
      });
    }
    return out;
  }

  // Models with the most tokens across the window, most first (for chart series + legend).
  function getTopModels(n) {
    const totals = new Map();
    for (const b of days.values()) {
      for (const [model, t] of b.perModel) {
        totals.set(model, (totals.get(model) || 0) + t.inputTokens + t.outputTokens);
      }
    }
    return [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n || 3)
      .map(([m]) => m);
  }

  function getWindowTotals() {
    const agg = emptyTotals();
    for (const b of days.values()) {
      agg.inputTokens += b.totals.inputTokens;
      agg.outputTokens += b.totals.outputTokens;
      agg.cacheCreationTokens += b.totals.cacheCreationTokens;
      agg.cacheReadTokens += b.totals.cacheReadTokens;
      agg.costUsd += b.totals.costUsd;
    }
    return agg;
  }

  let stopped = false;
  function start(ms) {
    const period = ms || intervalMs;
    const loop = async () => {
      if (stopped) return;
      try { await scan(); } catch (_) {}
      if (!stopped) setTimeout(loop, period);
    };
    loop();
  }
  function stop() { stopped = true; }

  return {
    start, stop, scan,
    getSeries, getTopModels, getWindowTotals,
    getLastScanAt: () => lastScanAt,
    windowDays,
  };
}

module.exports = { createHistoryAggregator, localDayKey };
