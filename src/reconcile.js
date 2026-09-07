// reconcile.js
// Merges what git knows (`git worktree list`) with what the dashboard has
// tracked in state.json, so worktrees created outside this tool -- or in a
// previous dashboard run -- show up and can be started.
//
// Called on every GET /api/worktrees, and once at startup with { startup: true }
// so that "running" statuses left over from a previous process (whose terminals
// are independent and unknowable) get downgraded to idle.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const wt = require('./worktrees');

const RUNNING = new Set(['session-running', 'dev-running']);

function norm(p) {
  return path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
}

// Mutates and returns `s`. opts:
//   startup  - also downgrade leftover running statuses
//   gitList  - inject a pre-parsed worktree list (tests); skips the git call
async function reconcile(s, opts = {}) {
  const repoPath = s.config && s.config.repoPath;
  if (!repoPath) return s;

  let gitList = opts.gitList;
  if (!gitList) {
    try {
      gitList = await wt.listGitWorktrees({ repoPath });
    } catch {
      gitList = [];
    }
  }

  const tracked = new Set(Object.values(s.worktrees).map((w) => norm(w.path)));
  const repoNorm = norm(repoPath);

  // 1. Insert git worktrees we don't track yet as "discovered".
  for (const g of gitList) {
    const gn = norm(g.path);
    if (gn === repoNorm || tracked.has(gn)) continue;
    const id = crypto.randomUUID();
    s.worktrees[id] = {
      id,
      branch: g.branch || (g.detached ? '(detached)' : '(unknown)'),
      path: g.path,
      port: null,
      status: 'discovered',
      tracked: false,
      adopted: false,
      nodeModules: null,
      createdAt: new Date().toISOString(),
      sessionPid: null,
      lastCommit: null
    };
    tracked.add(gn);
  }

  // 2. Flag records whose folder is gone; revive ones that came back;
  //    downgrade leftover running statuses at startup.
  const gitPaths = new Set(gitList.map((g) => norm(g.path)));
  for (const w of Object.values(s.worktrees)) {
    const present = fs.existsSync(w.path) && gitPaths.has(norm(w.path));
    if (!present) {
      w.status = 'missing';
      w.sessionPid = null;
      continue;
    }
    if (w.status === 'missing') {
      w.status = w.tracked || w.adopted ? 'idle' : 'discovered';
    }
    if (opts.startup && RUNNING.has(w.status)) {
      w.status = 'idle';
      w.sessionPid = null;
    }
  }

  return s;
}

module.exports = { reconcile, norm };
