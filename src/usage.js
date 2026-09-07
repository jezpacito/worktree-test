// usage.js
// BEST-EFFORT usage monitoring. Claude Code CLI stores per-session transcripts
// locally as JSONL under ~/.claude/projects/<encoded-project-path>/*.jsonl,
// and lines that record API responses typically carry a "usage" object with
// token counts (input_tokens, output_tokens, cache_creation_input_tokens,
// cache_read_input_tokens). The exact schema can change between CLI versions,
// so this parser is deliberately permissive: it walks every JSON object in
// every line looking for a nested "usage" object and sums whatever token
// fields it finds, rather than assuming one fixed shape.
//
// If your Claude CLI version stores things differently, this will show 0s --
// that's a signal to inspect ~/.claude/projects yourself and adjust the
// field names below, not a sign the dashboard is broken.

const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

const TOKEN_FIELDS = [
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens'
];

function encodeProjectPath(p) {
  // Claude Code encodes the project path by replacing path separators; this
  // mirrors the common convention but falls back to scanning all project
  // dirs if no exact match is found.
  return p.replace(/[\\/]/g, '-');
}

function sumUsageFromObject(obj, totals) {
  if (!obj || typeof obj !== 'object') return;
  if (obj.usage && typeof obj.usage === 'object') {
    for (const f of TOKEN_FIELDS) {
      if (typeof obj.usage[f] === 'number') totals[f] = (totals[f] || 0) + obj.usage[f];
    }
  }
  for (const key of Object.keys(obj)) {
    if (key === 'usage') continue;
    const val = obj[key];
    if (val && typeof val === 'object') sumUsageFromObject(val, totals);
  }
}

function findProjectLogDir(worktreePath) {
  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) return null;
  const encoded = encodeProjectPath(worktreePath);
  const candidates = fs.readdirSync(CLAUDE_PROJECTS_DIR);
  let match = candidates.find((c) => c === encoded || c.includes(encoded));
  if (!match) {
    // fallback: look for a dir whose name contains the worktree's basename
    const base = path.basename(worktreePath);
    match = candidates.find((c) => c.includes(base));
  }
  return match ? path.join(CLAUDE_PROJECTS_DIR, match) : null;
}

function usageForWorktree(worktreePath) {
  const totals = {};
  const dir = findProjectLogDir(worktreePath);
  if (!dir) return { available: false, totals };

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  for (const f of files) {
    const full = path.join(dir, f);
    let lines;
    try {
      lines = fs.readFileSync(full, 'utf8').split('\n');
    } catch {
      continue;
    }
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        sumUsageFromObject(obj, totals);
      } catch {
        // ignore malformed lines
      }
    }
  }
  return { available: true, totals };
}

function totalTokens(totals) {
  return TOKEN_FIELDS.reduce((sum, f) => sum + (totals[f] || 0), 0);
}

module.exports = { usageForWorktree, totalTokens, TOKEN_FIELDS };
