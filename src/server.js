const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const state = require('./state');
const ports = require('./ports');
const { allocatePort, findFreePort, validatePort } = ports;
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

// Names a browser is allowed to have used to reach us. Binding to 127.0.0.1
// keeps other machines out, but it does not keep the user's own browser out: a
// site they visit can resolve its own domain to 127.0.0.1 (DNS rebinding) and
// then talk to this API as a same-origin page -- reading every worktree id and
// POSTing to /push. Checking the Host header is what actually stops that,
// because the rebound request still carries the attacker's hostname.
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]', '::1'];

// Host names are case-insensitive and may carry a fully-qualified trailing dot
// ("localhost."), both of which some clients do send. Compare on one form.
function hostName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, '')   // strip the port; "[::1]:4999" -> "[::1]"
    .replace(/\.$/, '');    // strip the FQDN dot; "localhost." -> "localhost"
}

// Serving this over TLS is fine -- https://localhost matches everything below.
// What does not match is a reverse proxy publishing the dashboard under some
// other name, because the browser then sends THAT name as the Host. Rather than
// loosen the check (x-forwarded-host is attacker-settable and honouring it
// would hand back the bypass this guard exists to close), the extra name is
// named explicitly by whoever set the proxy up:
//   WTD_ALLOWED_HOSTS=wtd.internal,dash.localhost
function allowedHosts() {
  const extra = String(process.env.WTD_ALLOWED_HOSTS || '')
    .split(',')
    .map(hostName)
    .filter(Boolean);
  return new Set([...LOCAL_HOSTS, ...extra]);
}

// http and https alike: which scheme the page was served over says nothing
// about whether the request is same-site, and a local TLS proxy is a normal
// way to run this.
function isAllowedOrigin(origin, hosts) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return hosts.has(hostName(url.host));
}

function localOnly(req, res, next) {
  const hosts = allowedHosts();
  if (!hosts.has(hostName(req.headers.host))) {
    return res.status(403).json({
      error: 'This dashboard only answers requests addressed to localhost. '
        + 'If you front it with your own proxy, name that host in WTD_ALLOWED_HOSTS.'
    });
  }
  // A cross-site POST cannot set Content-Type: application/json without a
  // preflight, but it can send text/plain -- which reaches handlers that read
  // nothing from the body. An Origin from anywhere else is never legitimate.
  const origin = req.headers.origin;
  if (req.method !== 'GET' && origin && !isAllowedOrigin(origin, hosts)) {
    return res.status(403).json({ error: 'Cross-origin requests are not accepted.' });
  }
  next();
}

// Env var names go into generated shell scripts as `export NAME=` / `$env:NAME`,
// so anything but a real identifier is both meaningless and an injection point.
const ENV_VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Reconcile works on its own copy of state and only ever does three things:
// insert a discovered record, flag one missing, or revive one. Merging just
// those back -- rather than saving the whole object it started from -- means a
// 5s poll can no longer clobber a write made by a request that overlapped it.
function applyReconcile(cur, reconciled) {
  for (const [id, w] of Object.entries(reconciled.worktrees)) {
    const existing = cur.worktrees[id];
    if (!existing) {
      cur.worktrees[id] = w;
      continue;
    }
    if (w.status === 'missing' || existing.status === 'missing') {
      existing.status = w.status;
      if (w.sessionPid === null) existing.sessionPid = null;
    }
  }
}

// The env file this tool wrote into the worktree, as a git pathspec -- but only
// when the project does NOT gitignore it. In that case the auto-commit must
// leave it alone: it holds a port this tool rewrote for one worktree, and
// whatever the original env file held, and it would otherwise ride along into
// a branch the user later pushes.
async function envFileExcludes(config, worktreePath) {
  const envFileName = (config.envFileName || '').trim();
  if (!envFileName) return [];
  const appDir = (config.appDir || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const rel = appDir ? `${appDir}/${envFileName}` : envFileName;
  try {
    return (await wt.isIgnored({ worktreePath, relPath: rel })) ? [] : [rel];
  } catch {
    return [rel];
  }
}

// The callback token is a secret shared with one terminal window, and the UI
// has no use for it. Keeping it out of every response means it is not sitting
// in the browser's memory, in devtools, or in anything that logs API traffic.
function publicRecord(w) {
  const { sessionToken, ...rest } = w;
  return rest;
}

// `dashboardPort` is the port we are ACTUALLY listening on, which is not always
// config.dashboardPort: WTD_PORT overrides it at startup. The generated session
// scripts call back on this number, so taking it from config would silently
// break auto-commit on any machine that had to override the port.
function createApp({ dashboardPort } = {}) {
  const app = express();
  app.use(localOnly);
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // ---- config ----------------------------------------------------------

  app.get('/api/config', (req, res) => {
    const s = state.load();
    res.json({ ...s.config, capabilities: capabilities() });
  });

  app.post('/api/config', (req, res) => {
    const s = state.load();
    const { appDir, devCommand, portEnvVar, envFileName, startPort, pricing, costThreshold } = req.body;
    // Normalized here rather than at each use site, so what lands in state.json
    // is one absolute form no matter how the user typed it or which OS they are on.
    const repoPath = wt.normalizeUserPath(req.body.repoPath);
    const worktreesRoot = wt.normalizeUserPath(req.body.worktreesRoot);
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
    if (portEnvVar !== undefined && portEnvVar !== '' && !ENV_VAR_RE.test(String(portEnvVar).trim())) {
      return res.status(400).json({ error: `Port env var must be a plain identifier (letters, digits, underscore), got: ${portEnvVar}` });
    }
    if (envFileName !== undefined && envFileName !== '' && /[\\/]/.test(String(envFileName))) {
      return res.status(400).json({ error: 'Env file name must be a file name, not a path.' });
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
      ...(portEnvVar ? { portEnvVar: String(portEnvVar).trim() } : {}),
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

  // The port the next worktree would get, so the New Worktree form can pre-fill
  // its port box. Peeked, not consumed -- nothing is reserved until you create.
  app.get('/api/next-port', async (req, res) => {
    const s = state.load();
    try {
      res.json({ port: await findFreePort(s) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // npm scripts from the configured project, offered as dev-command suggestions.
  app.get('/api/scripts', (req, res) => {
    const s = state.load();
    const scripts = wt.listScripts({ repoPath: s.config.repoPath, appDir: s.config.appDir });
    res.json({ scripts, commands: scripts.map((n) => `npm run ${n}`) });
  });

  // ---- worktrees ---------------------------------------------------------

  app.get('/api/worktrees', async (req, res, next) => {
    try {
      const s = state.load();
      await reconcile(s);
      state.mutate((cur) => applyReconcile(cur, s));

      const pricing = s.config.pricing || {};
      const list = Object.values(s.worktrees).map((w) => {
        const u = usage.usageForWorktree(w.path);
        const cost = usage.costFor(u.perModel, pricing);
        return {
          ...publicRecord(w),
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
    } catch (e) {
      next(e);
    }
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

    // A port you named yourself wins over auto-allocation. Validated before the
    // worktree is created, so a rejected port does not leave a half-built one behind.
    let port;
    try {
      port = req.body.port === undefined || req.body.port === null || req.body.port === ''
        ? null
        : await validatePort(req.body.port, s);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    // Hold a hand-picked port too, for the same reason an allocated one is held:
    // the record that will own it does not exist until the checkout finishes.
    if (port != null) state.mutate((cur) => ports.reserve(cur, port));

    // Blank means "use the project default from Settings"; anything else is
    // remembered on the record so every later launch of this worktree reuses it.
    const devCommand = (req.body.devCommand || '').trim();

    fs.mkdirSync(worktreesRoot, { recursive: true });

    try {
      const worktreePath = await wt.createWorktree({ repoPath, worktreesRoot, branch, baseRef });
      const nmResult = await wt.linkNodeModules({ repoPath, worktreePath, appDir: s.config.appDir });
      if (port == null) port = await allocatePort(s);
      // Hold the port until this record exists, so a second create started at
      // the same moment is not handed the same number.
      state.mutate((cur) => ports.reserve(cur, port));
      wt.copyAndPatchEnvFile({
        repoPath, worktreePath,
        appDir: s.config.appDir,
        envFileName: s.config.envFileName,
        portEnvVar: s.config.portEnvVar,
        port
      });

      const id = crypto.randomUUID();
      const sessionToken = crypto.randomBytes(24).toString('hex');
      const record = {
        id, branch, path: worktreePath, port, sessionToken,
        devCommand: devCommand || null,
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
      state.mutate((cur) => {
        cur.worktrees[id] = record;
        ports.release(cur, port);
      });
      s.worktrees[id] = record;

      const launch = await session.launchSession({
        worktreeId: id,
        worktreePath,
        appPath: wt.resolveAppPath(worktreePath, s.config.appDir),
        port,
        portEnvVar: s.config.portEnvVar,
        devCommand: devCommand || s.config.devCommand,
        dashboardPort: dashboardPort || s.config.dashboardPort,
        claudeArgs: session.claudeArgsFor({
          claudeSessionId: record.claudeSessionId,
          hasTranscript: usage.transcriptExists(worktreePath, record.claudeSessionId),
          extra: claudeArgs
        }),
        withClaude: wantClaude,
        sessionToken
      });

      const saved = state.mutate((cur) => {
        const rec = cur.worktrees[id];
        rec.status = wantClaude ? 'session-running' : 'dev-running';
        rec.sessionPid = launch.pid;
        return rec;
      });

      res.json(publicRecord(saved));
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
      if (w.port == null) {
        w.port = await allocatePort(s);
        state.mutate((cur) => ports.reserve(cur, w.port));
      }

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
      // A fresh callback token per launch: the window opened by a previous
      // launch can no longer trigger a commit for this one.
      const sessionToken = crypto.randomBytes(24).toString('hex');
      w.sessionToken = sessionToken;
      state.mutate((cur) => {
        Object.assign(cur.worktrees[w.id], {
          port: w.port, nodeModules: w.nodeModules, adopted: w.adopted,
          claudeSessionId: w.claudeSessionId, tracked: true, sessionToken
        });
        ports.release(cur, w.port);
      });

      const launch = await session.launchSession({
        worktreeId: w.id,
        worktreePath: w.path,
        appPath,
        port: w.port,
        portEnvVar: s.config.portEnvVar,
        devCommand: w.devCommand || s.config.devCommand,
        dashboardPort: dashboardPort || s.config.dashboardPort,
        claudeArgs: session.claudeArgsFor({
          claudeSessionId: w.claudeSessionId,
          hasTranscript: usage.transcriptExists(w.path, w.claudeSessionId),
          extra: req.body.claudeArgs
        }),
        withClaude: wantClaude,
        sessionToken
      });

      const saved = state.mutate((cur) => {
        const rec = cur.worktrees[w.id];
        rec.status = wantClaude ? 'session-running' : 'dev-running';
        rec.sessionPid = launch.pid;
        return rec;
      });
      res.json(publicRecord(saved));
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
    res.json(publicRecord(w));
  });

  // Called by the session's PowerShell script when the Claude CLI process exits.
  app.post('/api/worktrees/:id/session/exit', async (req, res) => {
    const s = state.load();
    const w = s.worktrees[req.params.id];
    if (!w) return res.status(404).json({ error: 'unknown worktree id' });
    // Only the window this dashboard opened may declare a session over and set
    // a commit running. Records that predate tokens are let through, since no
    // token was ever handed to their still-open window.
    if (w.sessionToken && req.query.token !== w.sessionToken) {
      return res.status(403).json({ error: 'invalid or missing session token' });
    }

    state.mutate((cur) => { cur.worktrees[req.params.id].status = 'session-exited'; });

    try {
      const changed = await wt.hasChanges({ worktreePath: w.path });
      if (changed) {
        const result = await git.commitAll({
          worktreePath: w.path,
          message: `WIP: ${w.branch} (auto-commit on session exit)`,
          excludePaths: await envFileExcludes(s.config, w.path)
        });
        state.mutate((cur) => {
          const rec = cur.worktrees[req.params.id];
          rec.status = result.committed ? 'committed-pending-push' : 'session-exited';
          if (result.committed) rec.lastCommit = new Date().toISOString();
        });
      } else {
        state.mutate((cur) => { cur.worktrees[req.params.id].status = 'no-changes'; });
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
      const result = await git.commitAll({
        worktreePath: w.path,
        message: req.body.message || `WIP: ${w.branch}`,
        excludePaths: await envFileExcludes(s.config, w.path)
      });
      state.mutate((cur) => {
        const rec = cur.worktrees[req.params.id];
        if (result.committed) {
          rec.status = 'committed-pending-push';
          rec.lastCommit = new Date().toISOString();
        }
      });
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
      state.mutate((cur) => {
        cur.worktrees[req.params.id].status = 'pr-created';
        cur.worktrees[req.params.id].prUrl = result.url;
      });
      res.json(result);
    } catch (e) {
      // The push and the PR fail independently. If the commits reached the
      // remote and only `gh` failed, saying so beats leaving the row looking
      // as though nothing happened.
      if (e.pushed) {
        state.mutate((cur) => { cur.worktrees[req.params.id].status = 'pushed-no-pr'; });
      }
      res.status(500).json({
        error: e.pushed ? `Branch pushed, but creating the PR failed: ${e.message}` : e.message,
        pushed: !!e.pushed,
        detail: e.stderr || e.stdout || null
      });
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
        devCommand: w.devCommand || s.config.devCommand
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
      state.mutate((cur) => { delete cur.worktrees[req.params.id]; });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/usage/total', (req, res, next) => {
    try {
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
    } catch (e) {
      next(e);
    }
  });

  // Last resort: an error escaping a handler must become a 500 the UI can show,
  // not an unhandled rejection that takes the dashboard down mid-session.
  app.use((err, req, res, _next) => {
    console.error('[worktree-dashboard] request failed:', err && err.stack ? err.stack : err);
    if (res.headersSent) return;
    res.status(500).json({ error: (err && err.message) || 'internal error' });
  });

  return app;
}

module.exports = { createApp };
