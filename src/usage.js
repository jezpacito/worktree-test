// usage.js
// BEST-EFFORT usage + cost monitoring. Claude Code CLI stores per-session
// transcripts locally as JSONL under ~/.claude/projects/<encoded-project-path>/*.jsonl.
// Lines that record API responses carry a nested "usage" object with token
// counts, and (on assistant lines) a "model" string alongside it. The exact
// schema can change between CLI versions, so the parser is deliberately
// permissive: it walks every JSON object looking for a nested "usage" object
// and attributes it to the nearest enclosing "model" value.
//
// Costs are an ESTIMATE. They multiply the summed token counts by a per-model
// price map ($/1M tokens) that ships as a default and is editable in Settings.
// Unknown model ids fall back to a "default" price and the result is flagged
// as estimated.

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

// $/1M tokens. Mirrors the public Claude API price list; overridable via
// Settings (state.config.pricing). cacheWrite ~1.25x input, cacheRead ~0.1x
// input by the usual convention.
const DEFAULT_PRICING = {
  'claude-opus-5': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  'claude-sonnet-4': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-haiku-4': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  default: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 }
};

function encodeProjectPath(p) {
  return p.replace(/[\\/]/g, '-');
}

// The CLI's directory naming has varied across versions in which characters
// besides the separators get flattened to '-'. Rather than guess one rule --
// and it matters here, because the default worktrees root is a dot-directory --
// every plausible encoding is tried and only an EXACT directory match counts.
function candidateEncodings(p) {
  return [
    p.replace(/[\\/]/g, '-'),
    p.replace(/[\\/.]/g, '-'),
    p.replace(/[\\/._ ]/g, '-'),
    p.replace(/[^A-Za-z0-9]/g, '-')
  ];
}

function emptyBucket() {
  const b = {};
  for (const f of TOKEN_FIELDS) b[f] = 0;
  return b;
}

function addInto(target, src) {
  for (const f of TOKEN_FIELDS) target[f] = (target[f] || 0) + (src[f] || 0);
}

// Recursively walk an object, threading the nearest "model" string down, and
// accumulate every "usage" object we find into perModel[model].
function collectUsage(obj, perModel, contextModel) {
  if (!obj || typeof obj !== 'object') return;
  const model = typeof obj.model === 'string' ? obj.model : contextModel;

  if (obj.usage && typeof obj.usage === 'object') {
    const key = model || 'unknown';
    if (!perModel[key]) perModel[key] = emptyBucket();
    for (const f of TOKEN_FIELDS) {
      if (typeof obj.usage[f] === 'number') perModel[key][f] += obj.usage[f];
    }
  }

  for (const k of Object.keys(obj)) {
    if (k === 'usage') continue;
    const v = obj[k];
    if (v && typeof v === 'object') collectUsage(v, perModel, model);
  }
}

// Deliberately no substring or basename fallback. Matching loosely meant two
// worktrees with the same folder name under different roots collapsed onto one
// transcript directory: costs were attributed to the wrong branch, and
// transcriptExists answered about the wrong conversation, which made the
// launcher pass --session-id for an id the CLI already knew. Finding nothing is
// the honest answer -- it just reports usage as unavailable.
function findProjectLogDir(worktreePath, projectsDir = CLAUDE_PROJECTS_DIR) {
  if (!fs.existsSync(projectsDir)) return null;
  for (const encoded of new Set(candidateEncodings(worktreePath))) {
    const dir = path.join(projectsDir, encoded);
    try {
      if (fs.statSync(dir).isDirectory()) return dir;
    } catch {
      // not this encoding
    }
  }
  return null;
}

// Has this worktree's Claude session actually been written to disk? Resuming a
// session id the CLI has never seen fails with "No conversation found", so the
// launcher asks this before choosing between --session-id and --resume.
function transcriptExists(worktreePath, sessionId, projectsDir = CLAUDE_PROJECTS_DIR) {
  if (!sessionId) return false;
  const dir = findProjectLogDir(worktreePath, projectsDir);
  if (!dir) return false;
  return fs.existsSync(path.join(dir, `${sessionId}.jsonl`));
}

// Cheap re-parse guard, keyed per FILE by (path, mtime, size). The dashboard
// refreshes every 5s; keying per directory meant one appended line re-parsed
// every transcript in it, which is the expensive case in a long-lived project.
// Bounded so a machine with many projects cannot grow this without limit.
const _cache = new Map();
const CACHE_MAX = 500;

function cacheGet(key) {
  if (!_cache.has(key)) return null;
  // refresh LRU position
  const value = _cache.get(key);
  _cache.delete(key);
  _cache.set(key, value);
  return value;
}

function cacheSet(key, value) {
  _cache.set(key, value);
  while (_cache.size > CACHE_MAX) _cache.delete(_cache.keys().next().value);
}

function usageForWorktree(worktreePath) {
  const dir = findProjectLogDir(worktreePath);
  if (!dir) return { available: false, perModel: {}, totals: emptyBucket(), sessions: [] };

  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return { available: false, perModel: {}, totals: emptyBucket(), sessions: [] };
  }

  const perModel = {};
  const sessions = [];

  for (const f of files) {
    const full = path.join(dir, f);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }

    const key = `${full}:${st.mtimeMs}:${st.size}`;
    let session = cacheGet(key);
    if (!session) {
      let raw;
      try {
        raw = fs.readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      const sessionPerModel = {};
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          collectUsage(JSON.parse(line), sessionPerModel);
        } catch {
          // ignore malformed lines
        }
      }
      const sessionTotals = emptyBucket();
      for (const m of Object.keys(sessionPerModel)) addInto(sessionTotals, sessionPerModel[m]);
      session = { file: f, mtime: st.mtime.toISOString(), perModel: sessionPerModel, totals: sessionTotals };
      cacheSet(key, session);
    }

    for (const m of Object.keys(session.perModel)) {
      if (!perModel[m]) perModel[m] = emptyBucket();
      addInto(perModel[m], session.perModel[m]);
    }
    sessions.push(session);
  }

  sessions.sort((a, b) => (a.mtime || '').localeCompare(b.mtime || ''));

  const totals = emptyBucket();
  for (const m of Object.keys(perModel)) addInto(totals, perModel[m]);

  return { available: true, perModel, totals, sessions };
}

function totalTokens(totals) {
  return TOKEN_FIELDS.reduce((sum, f) => sum + (totals[f] || 0), 0);
}

// Pick a price row for a model id: exact match, else the longest key that is a
// prefix of the id, else "default".
function priceForModel(model, pricing) {
  if (pricing[model]) return { rate: pricing[model], exact: true };
  let best = null;
  for (const key of Object.keys(pricing)) {
    if (key === 'default') continue;
    if (model && model.startsWith(key) && (!best || key.length > best.length)) best = key;
  }
  if (best) return { rate: pricing[best], exact: true };
  return { rate: pricing.default || DEFAULT_PRICING.default, exact: false };
}

function costForBucket(bucket, rate) {
  return (
    ((bucket.input_tokens || 0) * rate.input +
      (bucket.output_tokens || 0) * rate.output +
      (bucket.cache_creation_input_tokens || 0) * rate.cacheWrite +
      (bucket.cache_read_input_tokens || 0) * rate.cacheRead) /
    1_000_000
  );
}

// perModel -> { usd, byModel: {model: usd}, estimated }
function costFor(perModel, pricing) {
  const table = { ...DEFAULT_PRICING, ...(pricing || {}) };
  let usd = 0;
  let estimated = false;
  const byModel = {};
  for (const model of Object.keys(perModel || {})) {
    const { rate, exact } = priceForModel(model, table);
    const c = costForBucket(perModel[model], rate);
    byModel[model] = c;
    usd += c;
    if (!exact || model === 'unknown') estimated = true;
  }
  return { usd, byModel, estimated };
}

// Short, plain-language tips derived from the usage shape of one worktree.
// summary: { perModel, sessionCount, usd, costThreshold }
function recommendations(summary) {
  const { perModel = {}, sessionCount = 0, usd = 0, costThreshold = 20 } = summary;
  const totals = emptyBucket();
  for (const m of Object.keys(perModel)) addInto(totals, perModel[m]);

  const inputSide =
    (totals.input_tokens || 0) +
    (totals.cache_creation_input_tokens || 0) +
    (totals.cache_read_input_tokens || 0);
  const cacheReadRatio = inputSide > 0 ? (totals.cache_read_input_tokens || 0) / inputSide : 0;

  if (inputSide === 0) return [];

  const tips = [];

  if (inputSide > 200_000 && cacheReadRatio < 0.3) {
    tips.push(
      `Low cache reuse (${Math.round(cacheReadRatio * 100)}%). Keep each session on one sub-task; ` +
        `re-reading large files from scratch is what costs the most.`
    );
  }
  if ((totals.output_tokens || 0) > 60_000) {
    tips.push(
      `Large model output (~${Math.round(totals.output_tokens / 1000)}k tokens). ` +
        `Ask for diffs/patches rather than full-file rewrites.`
    );
  }
  if (usd >= costThreshold) {
    tips.push(
      `This worktree has spent ~$${usd.toFixed(2)}. Consider splitting the task or ` +
        `clearing context (/clear) between sub-tasks.`
    );
  }
  if (sessionCount >= 5) {
    tips.push(
      `${sessionCount} sessions recorded here. Long-lived resumed context compounds cost — ` +
        `start a fresh session when you switch sub-tasks.`
    );
  }
  if (tips.length === 0) {
    tips.push('Usage looks healthy — cache reuse and output size are in a good range.');
  }
  return tips;
}

// Exposed for unit tests.
function _resetCache() {
  _cache.clear();
}

module.exports = {
  usageForWorktree,
  transcriptExists,
  totalTokens,
  costFor,
  priceForModel,
  recommendations,
  collectUsage,
  TOKEN_FIELDS,
  DEFAULT_PRICING,
  _resetCache
};
