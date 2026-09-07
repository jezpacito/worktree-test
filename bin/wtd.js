#!/usr/bin/env node
const { createApp } = require('../src/server');
const state = require('../src/state');

const cmd = process.argv[2] || 'start';

if (cmd === 'start') {
  const s = state.load();
  const port = s.config.dashboardPort || 4999;
  const app = createApp();
  app.listen(port, '127.0.0.1', () => {
    console.log(`\nWorktree Dashboard running at http://localhost:${port}\n`);
    if (!s.config.repoPath) {
      console.log('No project configured yet -- open the dashboard and fill in Settings (project path, dev command, port env var, .env file name).');
    } else {
      console.log(`Project: ${s.config.repoPath}`);
    }
  });
} else {
  console.log('Usage: wtd start');
  process.exit(1);
}
