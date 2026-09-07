const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const state = require('./state');
const { allocatePort } = require('./ports');
const wt = require('./worktrees');
const git = require('./git');
const session = require('./session');
const usage = require('./usage');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // ---- config ----------------------------------------------------------

  app.get('/api/config', (req, res) => {
    const s = state.load();
    res.json(s.config);
  });

  app.post('/api/config', (req, res) => {
    const s = state.load();
    const { repoPath, devCommand, portEnvVar, envFileName, startPort, worktreesRoot } = req.body;
    if (repoPath && !fs.existsSync(path.join(repoPath, '.git'))) {
      return res.status(400).json({ error: `${repoPath} does not look like a git repo root (no .git found)` });
    }
    s.config = {
      ...s.config,
      ...(repoPath ? { repoPath } : {}),
      ...(devCommand ? { devCommand } : {}),
      ...(portEnvVar ? { portEnvVar } : {}),
      ...(envFileName ? { envFileName } : {}),
      ...(startPort ? { startPort: Number(startPort) } : {}),
      worktreesRoot: worktreesRoot || (repoPath ? path.join(path.dirname(repoPath), '.worktrees') : s.config.worktreesRoot)
    };
    if (!s.nextPort || s.nextPort < s.config.startPort) s.nextPort = s.config.startPort;
    state.save(s);
    res.json(s.config);
  });

  // ---- worktrees ---------------------------------------------------------

  app.get('/api/worktrees', async (req, res) => {
    const s = state.load();
    const list = await Promise.all(Object.values(s.worktrees).map(async (w) => {
      const u = usage.usageForWorktree(w.path);
      return { ...w, usage: { ...u.totals, total: usage.totalTokens(u.totals), available: u.available } };
    }));
    res.json(list);
  });

  app.post('/api/worktrees', async (req, res) => {
    const s = state.load();
    const { repoPath, worktreesRoot, dashboardPort } = s.config;
    if (!repoPath) return res.status(400).json({ error: 'Set the project (repoPath) in Settings first.' });

    const { branch, baseRef, claudeArgs } = req.body;
    if (!branch) return res.status(400).json({ error: 'branch is required' });

    fs.mkdirSync(worktreesRoot, { recursive: true });

    try {
      const worktreePath = await wt.createWorktree({ repoPath, worktreesRoot, branch, baseRef });
      const nmResult = await wt.linkNodeModules({ repoPath, worktreePath });
      const port = await allocatePort(s);
      wt.copyAndPatchEnvFile({
        repoPath, worktreePath,
        envFileName: s.config.envFileName,
        portEnvVar: s.config.portEnvVar,
        port
      });

      const id = crypto.randomUUID();
      const record = {
        id, branch, path: worktreePath, port,
        status: 'created',
        nodeModules: nmResult,
        createdAt: new Date().toISOString(),
        sessionPid: null,
        lastCommit: null
      };
      s.worktrees[id] = record;
      state.save(s);

      const launch = await session.launchSession({
        worktreeId: id,
        worktreePath,
        port,
        portEnvVar: s.config.portEnvVar,
        devCommand: s.config.devCommand,
        dashboardPort: s.config.dashboardPort,
        claudeArgs
      });

      const s2 = state.load();
      s2.worktrees[id].status = 'session-running';
      s2.worktrees[id].sessionPid = launch.pid;
      state.save(s2);

      res.json(s2.worktrees[id]);
    } catch (e) {
      res.status(500).json({ error: e.message, detail: e.stderr || e.stdout || null });
    }
  });

  // Called by the session's PowerShell script when the Claude CLI process exits.
  app.post('/api/worktrees/:id/session/exit', async (req, res) => {
    const s = state.load();
    const w = s.worktrees[req.params.id];
    if (!w) return res.status(404).json({ error: 'unknown worktree id' });

    w.status = 'session-exited';
    state.save(s);

    try {
      const changed = await wt.hasChanges({ worktreePath: w.path });
      if (changed) {
        const result = await git.commitAll({ worktreePath: w.path, message: `WIP: ${w.branch} (auto-commit on session exit)` });
        const s2 = state.load();
        s2.worktrees[req.params.id].status = result.committed ? 'committed-pending-push' : 'session-exited';
        s2.worktrees[req.params.id].lastCommit = result.committed ? new Date().toISOString() : s2.worktrees[req.params.id].lastCommit;
        state.save(s2);
      } else {
        const s2 = state.load();
        s2.worktrees[req.params.id].status = 'no-changes';
        state.save(s2);
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Manual commit trigger (used if the auto-callback couldn't reach the dashboard).
  app.post('/api/worktrees/:id/commit', async (req, res) => {
    const s = state.load();
    const w = s.worktrees[req.params.id];
    if (!w) return res.status(404).json({ error: 'unknown worktree id' });
    try {
      const result = await git.commitAll({ worktreePath: w.path, message: req.body.message || `WIP: ${w.branch}` });
      const s2 = state.load();
      s2.worktrees[req.params.id].status = result.committed ? 'committed-pending-push' : s2.worktrees[req.params.id].status;
      state.save(s2);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Explicit user confirmation -> push + create PR. Nothing pushes without this call.
  app.post('/api/worktrees/:id/push', async (req, res) => {
    const s = state.load();
    const w = s.worktrees[req.params.id];
    if (!w) return res.status(404).json({ error: 'unknown worktree id' });
    try {
      const result = await git.pushAndCreatePr({
        worktreePath: w.path,
        branch: w.branch,
        baseRef: req.body.baseRef,
        title: req.body.title,
        body: req.body.body
      });
      const s2 = state.load();
      s2.worktrees[req.params.id].status = 'pr-created';
      s2.worktrees[req.params.id].prUrl = result.url;
      state.save(s2);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message, detail: e.stderr || e.stdout || null });
    }
  });

  app.post('/api/worktrees/:id/reinstall', async (req, res) => {
    const s = state.load();
    const w = s.worktrees[req.params.id];
    if (!w) return res.status(404).json({ error: 'unknown worktree id' });
    try {
      await wt.reinstallDeps({ worktreePath: w.path });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete('/api/worktrees/:id', async (req, res) => {
    const s = state.load();
    const w = s.worktrees[req.params.id];
    if (!w) return res.status(404).json({ error: 'unknown worktree id' });
    try {
      await wt.removeWorktree({ repoPath: s.config.repoPath, worktreePath: w.path });
      delete s.worktrees[req.params.id];
      state.save(s);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/usage/total', (req, res) => {
    const s = state.load();
    const totals = {};
    for (const w of Object.values(s.worktrees)) {
      const u = usage.usageForWorktree(w.path);
      for (const f of usage.TOKEN_FIELDS) totals[f] = (totals[f] || 0) + (u.totals[f] || 0);
    }
    res.json({ totals, total: usage.totalTokens(totals) });
  });

  return app;
}

module.exports = { createApp };
