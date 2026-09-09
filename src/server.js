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
const { reconcile } = require('./reconcile');

// What this machine can actually do, so the UI only offers real actions.
// Windows opens PowerShell; WSL opens a Windows Terminal tab back into the
// distro. A plain Linux or macOS box has no window to open.
function capabilities() {
  return { openTerminal: session.launcherKind() !== 'posix' };
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // ---- config ----------------------------------------------------------

  app.get('/api/config', (req, res) => {
    const s = state.load();
    res.json({ ...s.config, capabilities: capabilities() });
  });

  app.post('/api/config', (req, res) => {
    const s = state.load();
    const { repoPath, appDir, devCommand, portEnvVar, envFileName, startPort, worktreesRoot, pricing, costThreshold } = req.body;
    if (repoPath && !fs.existsSync(path.join(repoPath, '.git'))) {
      return res.status(400).json({ error: `${repoPath} does not look like a git repo root (no .git found)` });
    }
    // Validate the app subfolder eagerly so a bad value is rejected here rather
    // than surfacing much later as a failed worktree creation.
    if (appDir !== undefined && appDir !== '') {
      try {
        wt.resolveAppPath(repoPath || s.config.repoPath || '/', appDir);
      } catch (e) {
        return res.status(400).json({ error: e.message });
      }
    }
    let parsedPricing;
    if (pricing !== undefined && pricing !== '') {
      try {
        parsedPricing = typeof pricing === 'string' ? JSON.parse(pricing) : pricing;
      } catch (e) {
        return res.status(400).json({ error: `pricing is not valid JSON: ${e.message}` });
      }
    }
    s.config = {
      ...s.config,
      ...(repoPath ? { repoPath } : {}),
      ...(appDir !== undefined ? { appDir: String(appDir).trim().replace(/^[\\/]+|[\\/]+$/g, '') } : {}),
      ...(devCommand ? { devCommand } : {}),
      ...(portEnvVar ? { portEnvVar } : {}),
      ...(envFileName ? { envFileName } : {}),
      ...(startPort ? { startPort: Number(startPort) } : {}),
      ...(parsedPricing ? { pricing: parsedPricing } : {}),
      ...(costThreshold !== undefined && costThreshold !== '' ? { costThreshold: Number(costThreshold) } : {}),
      worktreesRoot: worktreesRoot || (repoPath ? path.join(path.dirname(repoPath), '.worktrees') : s.config.worktreesRoot)
    };
    if (!s.nextPort || s.nextPort < s.config.startPort) s.nextPort = s.config.startPort;
    state.save(s);
    res.json({ ...s.config, capabilities: capabilities() });
  });

  // ---- worktrees ---------------------------------------------------------

  app.get('/api/worktrees', async (req, res) => {
    const s = state.load();
    await reconcile(s);
    state.save(s);

    const pricing = s.config.pricing || {};
    const list = Object.values(s.worktrees).map((w) => {
      const u = usage.usageForWorktree(w.path);
      const cost = usage.costFor(u.perModel, pricing);
      return {
        ...w,
        usage: {
          total: usage.totalTokens(u.totals),
          available: u.available,
          usd: cost.usd,
          estimated: cost.estimated,
          sessionCount: u.sessions.length
        }
      };
    });
    res.json(list);
  });

  // Per-worktree cost breakdown + optimization tips (fetched when a row is expanded).
  app.get('/api/worktrees/:id/usage', (req, res) => {
    const s = state.load();
    const w = s.worktrees[req.params.id];
    if (!w) return res.status(404).json({ error: 'unknown worktree id' });

    const pricing = s.config.pricing || {};
    const u = usage.usageForWorktree(w.path);
    const cost = usage.costFor(u.perModel, pricing);
    const sessions = u.sessions.map((se) => ({
      file: se.file,
      mtime: se.mtime,
      total: usage.totalTokens(se.totals),
      usd: usage.costFor(se.perModel, pricing).usd
    }));
    const tips = usage.recommendations({
      perModel: u.perModel,
      sessionCount: u.sessions.length,
      usd: cost.usd,
      costThreshold: s.config.costThreshold || 20
    });
    res.json({
      available: u.available, usd: cost.usd, estimated: cost.estimated,
      byModel: cost.byModel, totals: u.totals, sessions, recommendations: tips
    });
  });

  app.post('/api/worktrees', async (req, res) => {
    const s = state.load();
    const { repoPath, worktreesRoot } = s.config;
    if (!repoPath) return res.status(400).json({ error: 'Set the project (repoPath) in Settings first.' });

    const { branch, baseRef, claudeArgs, withClaude } = req.body;
    if (!branch) return res.status(400).json({ error: 'branch is required' });
    const wantClaude = withClaude !== false;

    fs.mkdirSync(worktreesRoot, { recursive: true });

    try {
      const worktreePath = await wt.createWorktree({ repoPath, worktreesRoot, branch, baseRef });
      const nmResult = await wt.linkNodeModules({ repoPath, worktreePath, appDir: s.config.appDir });
      const port = await allocatePort(s);
      wt.copyAndPatchEnvFile({
        repoPath, worktreePath,
        appDir: s.config.appDir,
        envFileName: s.config.envFileName,
        portEnvVar: s.config.portEnvVar,
        port
      });

      const id = crypto.randomUUID();
      const record = {
        id, branch, path: worktreePath, port,
        baseRef: baseRef || 'HEAD',
        claudeSessionId: crypto.randomUUID(),
        status: 'created',
        tracked: true,
        adopted: true,
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
        appPath: wt.resolveAppPath(worktreePath, s.config.appDir),
        port,
        portEnvVar: s.config.portEnvVar,
        devCommand: s.config.devCommand,
        dashboardPort: s.config.dashboardPort,
        claudeArgs: session.claudeArgsFor({
          claudeSessionId: record.claudeSessionId,
          hasTranscript: usage.transcriptExists(worktreePath, record.claudeSessionId),
          extra: claudeArgs
        }),
        withClaude: wantClaude
      });

      const s2 = state.load();
      s2.worktrees[id].status = wantClaude ? 'session-running' : 'dev-running';
      s2.worktrees[id].sessionPid = launch.pid;
      state.save(s2);

      res.json(s2.worktrees[id]);
    } catch (e) {
      res.status(500).json({ error: e.message, detail: e.stderr || e.stdout || null });
    }
  });

  // Start (or restart) an already-known worktree: discovered, idle, or one left
  // over from a previous dashboard run. Heavy setup (port / env / node_modules)
  // happens here, and only for the parts that are missing.
  app.post('/api/worktrees/:id/start', async (req, res) => {
    const s = state.load();
    const w = s.worktrees[req.params.id];
    if (!w) return res.status(404).json({ error: 'unknown worktree id' });
    if (!fs.existsSync(w.path)) return res.status(400).json({ error: 'worktree folder is missing on disk' });
    if (!s.config.repoPath) return res.status(400).json({ error: 'Set the project (repoPath) in Settings first.' });

    const wantClaude = req.body.withClaude !== false;

    try {
      if (w.port == null) w.port = await allocatePort(s);

      const appPath = wt.resolveAppPath(w.path, s.config.appDir);
      if (!fs.existsSync(path.join(appPath, 'node_modules'))) {
        w.nodeModules = await wt.linkNodeModules({ repoPath: s.config.repoPath, worktreePath: w.path, appDir: s.config.appDir });
      }

      // Patch the env file only on first adoption -- later starts leave any
      // hand-edits in that worktree's env file alone.
      if (!w.adopted) {
        wt.copyAndPatchEnvFile({
          repoPath: s.config.repoPath,
          worktreePath: w.path,
          appDir: s.config.appDir,
          envFileName: s.config.envFileName,
          portEnvVar: s.config.portEnvVar,
          port: w.port
        });
        w.adopted = true;
      }
      // Worktrees created before this existed -- and discovered ones -- get an
      // id on their first Claude launch from here.
      if (wantClaude && !w.claudeSessionId) w.claudeSessionId = crypto.randomUUID();
      w.tracked = true;
      state.save(s);

      const launch = await session.launchSession({
        worktreeId: w.id,
        worktreePath: w.path,
        appPath,
        port: w.port,
        portEnvVar: s.config.portEnvVar,
        devCommand: s.config.devCommand,
        dashboardPort: s.config.dashboardPort,
        claudeArgs: session.claudeArgsFor({
          claudeSessionId: w.claudeSessionId,
          hasTranscript: usage.transcriptExists(w.path, w.claudeSessionId),
          extra: req.body.claudeArgs
        }),
        withClaude: wantClaude
      });

      const s2 = state.load();
      s2.worktrees[w.id].status = wantClaude ? 'session-running' : 'dev-running';
      s2.worktrees[w.id].sessionPid = launch.pid;
      state.save(s2);
      res.json(s2.worktrees[w.id]);
    } catch (e) {
      res.status(500).json({ error: e.message, detail: e.stderr || e.stdout || null });
    }
  });

  // Drop this worktree's Claude session id so the next Start begins a fresh
  // conversation. The old transcript is left alone -- its cost still counts.
  app.post('/api/worktrees/:id/new-session', (req, res) => {
    const s = state.load();
    const w = s.worktrees[req.params.id];
    if (!w) return res.status(404).json({ error: 'unknown worktree id' });
    w.claudeSessionId = crypto.randomUUID();
    state.save(s);
    res.json({ claudeSessionId: w.claudeSessionId });
  });

  // "I closed that terminal myself" -- reset a running record to idle.
  app.post('/api/worktrees/:id/mark-idle', (req, res) => {
    const s = state.load();
    const w = s.worktrees[req.params.id];
    if (!w) return res.status(404).json({ error: 'unknown worktree id' });
    w.status = 'idle';
    w.sessionPid = null;
    state.save(s);
    res.json(w);
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

  // Just a shell at this worktree's app folder, with the port env var preset.
  // Deliberately does not change status or allocate anything -- it is not a session.
  app.post('/api/worktrees/:id/terminal', async (req, res) => {
    const s = state.load();
    const w = s.worktrees[req.params.id];
    if (!w) return res.status(404).json({ error: 'unknown worktree id' });
    if (!fs.existsSync(w.path)) return res.status(400).json({ error: 'worktree folder is missing on disk' });
    try {
      const result = await session.openTerminal({
        worktreeId: w.id,
        worktreePath: w.path,
        appPath: wt.resolveAppPath(w.path, s.config.appDir),
        port: w.port,
        portEnvVar: s.config.portEnvVar,
        devCommand: s.config.devCommand
      });
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // Open just this worktree's Claude session -- no dev server, no port, no
  // status change. Resumes the same conversation Start would.
  app.post('/api/worktrees/:id/claude', async (req, res) => {
    const s = state.load();
    const w = s.worktrees[req.params.id];
    if (!w) return res.status(404).json({ error: 'unknown worktree id' });
    if (!fs.existsSync(w.path)) return res.status(400).json({ error: 'worktree folder is missing on disk' });
    try {
      if (!w.claudeSessionId) {
        w.claudeSessionId = crypto.randomUUID();
        state.save(s);
      }
      const result = await session.openClaude({
        worktreeId: w.id,
        worktreePath: w.path,
        claudeArgs: session.claudeArgsFor({
          claudeSessionId: w.claudeSessionId,
          hasTranscript: usage.transcriptExists(w.path, w.claudeSessionId),
          extra: req.body.claudeArgs
        })
      });
      res.json({ ...result, claudeSessionId: w.claudeSessionId });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post('/api/worktrees/:id/vscode', async (req, res) => {
    const s = state.load();
    const w = s.worktrees[req.params.id];
    if (!w) return res.status(404).json({ error: 'unknown worktree id' });
    if (!fs.existsSync(w.path)) return res.status(400).json({ error: 'worktree folder is missing on disk' });
    try {
      res.json(await session.openInVsCode({ worktreePath: w.path }));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post('/api/worktrees/:id/reinstall', async (req, res) => {
    const s = state.load();
    const w = s.worktrees[req.params.id];
    if (!w) return res.status(404).json({ error: 'unknown worktree id' });
    try {
      await wt.reinstallDeps({ worktreePath: w.path, appDir: s.config.appDir });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Remove a worktree. Works for tracked, discovered, and stale ("missing")
  // records. The branch and its commits are always kept.
  app.delete('/api/worktrees/:id', async (req, res) => {
    const s = state.load();
    const w = s.worktrees[req.params.id];
    if (!w) return res.status(404).json({ error: 'unknown worktree id' });
    try {
      if (fs.existsSync(w.path)) {
        await wt.removeWorktree({ repoPath: s.config.repoPath, worktreePath: w.path });
      } else if (s.config.repoPath) {
        // Folder already gone -- just clear git's stale bookkeeping.
        await wt.pruneWorktrees({ repoPath: s.config.repoPath }).catch(() => {});
      }
      delete s.worktrees[req.params.id];
      state.save(s);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/usage/total', (req, res) => {
    const s = state.load();
    const pricing = s.config.pricing || {};
    const totals = {};
    let usd = 0;
    for (const w of Object.values(s.worktrees)) {
      const u = usage.usageForWorktree(w.path);
      for (const f of usage.TOKEN_FIELDS) totals[f] = (totals[f] || 0) + (u.totals[f] || 0);
      usd += usage.costFor(u.perModel, pricing).usd;
    }
    res.json({ totals, total: usage.totalTokens(totals), usd });
  });

  return app;
}

module.exports = { createApp };
