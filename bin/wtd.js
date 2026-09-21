#!/usr/bin/env node
const { createApp } = require('../src/server');
const state = require('../src/state');
const { reconcile } = require('../src/reconcile');

const cmd = process.argv[2] || 'start';

if (cmd === 'start') {
  const s = state.load();
  // WTD_PORT wins over the stored setting, so a machine where 4999 is taken or
  // blocked can be worked around without editing state.json by hand.
  const port = Number(process.env.WTD_PORT) || s.config.dashboardPort || 4999;

  // Downgrade any "running" records left over from a previous process, and pull
  // in worktrees created outside the dashboard, before we start serving.
  Promise.resolve()
    .then(() => reconcile(s, { startup: true }))
    .then(() => state.save(s))
    .catch((e) => console.error('startup reconcile failed:', e.message))
    .finally(() => {
      const app = createApp({ dashboardPort: port });
      const server = app.listen(port, '127.0.0.1', () => {
        console.log(`\nWorktree Dashboard running at http://localhost:${port}\n`);
        if (!s.config.repoPath) {
          console.log('No project configured yet -- open the dashboard and fill in Settings (project path, dev command, port env var, .env file name).');
        } else {
          console.log(`Project: ${s.config.repoPath}`);
        }
      });
      server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          console.error(`\nPort ${port} is already in use, so the dashboard cannot start.`);
          console.error(`Free it, or pick another one:  WTD_PORT=5050 wtd start\n`);
        } else if (err.code === 'EACCES') {
          console.error(`\nNot allowed to listen on port ${port}. Try a port above 1024:  WTD_PORT=5050 wtd start\n`);
        } else {
          console.error(`\nDashboard failed to start: ${err.message}\n`);
        }
        process.exit(1);
      });
    });
} else {
  console.log('Usage: wtd start');
  process.exit(1);
}
