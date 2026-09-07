#!/usr/bin/env node
const { createApp } = require('../src/server');
const state = require('../src/state');
const { reconcile } = require('../src/reconcile');

const cmd = process.argv[2] || 'start';

if (cmd === 'start') {
  const s = state.load();
  const port = s.config.dashboardPort || 4999;

  // Downgrade any "running" records left over from a previous process, and pull
  // in worktrees created outside the dashboard, before we start serving.
  Promise.resolve()
    .then(() => reconcile(s, { startup: true }))
    .then(() => state.save(s))
    .catch((e) => console.error('startup reconcile failed:', e.message))
    .finally(() => {
      const app = createApp();
      app.listen(port, '127.0.0.1', () => {
        console.log(`\nWorktree Dashboard running at http://localhost:${port}\n`);
        if (!s.config.repoPath) {
          console.log('No project configured yet -- open the dashboard and fill in Settings (project path, dev command, port env var, .env file name).');
        } else {
          console.log(`Project: ${s.config.repoPath}`);
        }
      });
    });
} else {
  console.log('Usage: wtd start');
  process.exit(1);
}
