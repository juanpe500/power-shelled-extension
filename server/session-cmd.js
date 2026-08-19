// Pure helpers for resuming a claude conversation by UUID after a server restart.
//
// A claude session's conversation is keyed by its UUID, NOT its --name (a Remote
// Control label) and NOT its cwd (--continue would collide between two sessions
// in the same folder). We PIN the UUID at spawn with --session-id so we always
// know it and can --resume the exact conversation later.
//
// This works because the extension launches claude WITHOUT the --remote-control
// flag (Remote Control is enabled on demand from inside the session via the
// /remote-control slash command). The interactive --remote-control FLAG manages
// its own session identity and ignores --session-id — that combo was the reason
// pinning failed before; without it, --session-id is honored (verified: an
// interactive `claude --session-id X` writes its transcript to X.jsonl, and
// `claude --resume X` appends to that same file with no picker).
'use strict';

const os = require('os');
const path = require('path');
const crypto = require('crypto');

function isClaudeCmd(cmd) {
  return /^\s*claude(\.[a-z]+)?(\s|$)/i.test(cmd || '');
}

// first UUID-bearing flag value (--session-id / --resume / -r), unquoted
function findUuidFlag(cmd) {
  const m = /(?:--session-id|--resume|-r)\s+("[^"]+"|'[^']+'|\S+)/i.exec(cmd || '');
  return m ? m[1].replace(/^["']|["']$/g, '') : null;
}

function hasContinueFlag(cmd) {
  return /(?:^|\s)(?:--continue|-c)(?:\s|$)/i.test(cmd || '');
}

function stripSessionFlags(cmd) {
  return (cmd || '')
    .replace(/\s*(?:--session-id|--resume|-r)\s+(?:"[^"]+"|'[^']+'|\S+)/gi, '')
    .replace(/\s*(?:--continue|-c)(?=\s|$)/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// { cmd, uuid } — the command to actually run, and the UUID to persist.
// For a plain claude launch we append `--session-id <new uuid>` so the transcript
// id is deterministic and known up front (no directory scraping). If the caller
// already pinned/resumed an id we keep it; a manual `--continue` can't be pinned
// (its target is ambiguous) so we leave it as-is with no uuid.
function resolveClaudeCmd(cmd) {
  cmd = (cmd || '').trim();
  if (!isClaudeCmd(cmd)) return { cmd, uuid: null };
  const existing = findUuidFlag(cmd);
  if (existing) return { cmd, uuid: existing };
  if (hasContinueFlag(cmd)) return { cmd, uuid: null };
  const uuid = crypto.randomUUID();
  return { cmd: cmd + ' --session-id ' + uuid, uuid };
}

// Rebuild a launch command that resumes the exact conversation by UUID.
function resumeCmd(initialCommand, uuid) {
  if (!uuid) return isClaudeCmd(initialCommand) ? (initialCommand || '').trim() : '';
  return (stripSessionFlags(initialCommand) + ' --resume ' + uuid).trim();
}

// The ~/.claude/projects directory where claude writes a <sessionId>.jsonl
// transcript for a session running in `cwd`. Claude escapes the cwd by replacing
// every non-alphanumeric char with '-' (verified: C:\Users\juanp\JP\...\chrome-
// terminal -> C--Users-juanp-JP-...-chrome-terminal).
function projectDirFor(cwd) {
  const esc = String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-');
  return path.join(os.homedir(), '.claude', 'projects', esc);
}

module.exports = {
  isClaudeCmd, findUuidFlag, hasContinueFlag, stripSessionFlags,
  resolveClaudeCmd, resumeCmd, projectDirFor,
};
