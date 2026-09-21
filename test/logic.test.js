// Pure-logic tests for the parts that don't spawn terminals or shell out.
// Run with:  npm test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const wt = require('../src/worktrees');
const usage = require('../src/usage');
const { reconcile, norm } = require('../src/reconcile');

test('parseWorktreePorcelain: branches, detached, bare', () => {
  const text = [
    'worktree /repo/main',
    'HEAD abc123',
    'branch refs/heads/main',
    '',
    'worktree /repo/.worktrees/wt-feature',
    'HEAD def456',
    'branch refs/heads/feature/x',
    '',
    'worktree /repo/.worktrees/wt-detached',
    'HEAD 999aaa',
    'detached',
    '',
    'worktree /repo/bare',
    'bare',
    ''
  ].join('\n');

  const list = wt.parseWorktreePorcelain(text);
  assert.equal(list.length, 3, 'bare worktree filtered out');
  assert.deepEqual(list[0], { path: '/repo/main', branch: 'main', head: 'abc123', detached: false, bare: false });
  assert.equal(list[1].branch, 'feature/x');
  assert.equal(list[2].detached, true);
  assert.equal(list[2].branch, null);
});

test('priceForModel: exact, prefix, default fallback', () => {
  const table = usage.DEFAULT_PRICING;
  assert.equal(usage.priceForModel('claude-sonnet-5', table).exact, true);
  // dated / suffixed id falls back to the "claude-sonnet-4" prefix row
  const p = usage.priceForModel('claude-sonnet-4-6-20260101', table);
  assert.equal(p.exact, true);
  assert.equal(p.rate.input, 3);
  // wholly unknown -> default, flagged inexact
  const d = usage.priceForModel('some-other-llm', table);
  assert.equal(d.exact, false);
});

test('costFor: sums per-model token cost in USD', () => {
  const perModel = {
    'claude-sonnet-5': {
      input_tokens: 1_000_000,        // $2
      output_tokens: 1_000_000,       // $10
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 1_000_000 // $0.20
    }
  };
  const { usd, estimated } = usage.costFor(perModel, usage.DEFAULT_PRICING);
  assert.ok(Math.abs(usd - 12.2) < 1e-9, `expected 12.2, got ${usd}`);
  assert.equal(estimated, false);
});

test('costFor: unknown model flags estimated', () => {
  const { estimated } = usage.costFor({ unknown: { input_tokens: 100 } }, usage.DEFAULT_PRICING);
  assert.equal(estimated, true);
});

test('recommendations: low cache reuse + big output fire tips', () => {
  const tips = usage.recommendations({
    perModel: {
      'claude-sonnet-5': {
        input_tokens: 500_000,
        cache_read_input_tokens: 10_000,
        cache_creation_input_tokens: 0,
        output_tokens: 80_000
      }
    },
    sessionCount: 6,
    usd: 25,
    costThreshold: 20
  });
  assert.ok(tips.some((t) => /cache reuse/i.test(t)));
  assert.ok(tips.some((t) => /diffs\/patches/i.test(t)));
  assert.ok(tips.some((t) => /\$25/.test(t)));
  assert.ok(tips.some((t) => /sessions recorded/i.test(t)));
});

test('recommendations: no transcript data -> no tips', () => {
  assert.deepEqual(usage.recommendations({ perModel: {} }), []);
});

test('recommendations: healthy usage -> reassurance', () => {
  const tips = usage.recommendations({
    perModel: { 'claude-sonnet-5': { input_tokens: 100_000, cache_read_input_tokens: 90_000, output_tokens: 5_000 } },
    sessionCount: 1,
    usd: 1
  });
  assert.equal(tips.length, 1);
  assert.match(tips[0], /healthy/i);
});

test('reconcile: inserts discovered worktrees and skips the main checkout', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wtd-test-'));
  const repo = path.join(tmp, 'repo');
  const disc = path.join(tmp, 'wt-existing');
  fs.mkdirSync(repo);
  fs.mkdirSync(disc);

  const s = {
    config: { repoPath: repo },
    worktrees: {}
  };
  await reconcile(s, {
    gitList: [
      { path: repo, branch: 'main', detached: false, bare: false },
      { path: disc, branch: 'feature/existing', detached: false, bare: false }
    ]
  });

  const recs = Object.values(s.worktrees);
  assert.equal(recs.length, 1, 'main checkout not tracked');
  assert.equal(recs[0].branch, 'feature/existing');
  assert.equal(recs[0].status, 'discovered');
  assert.equal(recs[0].tracked, false);
  assert.equal(recs[0].port, null);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('reconcile startup: downgrades leftover running status and flags missing folders', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wtd-test-'));
  const repo = path.join(tmp, 'repo');
  const live = path.join(tmp, 'wt-live');
  fs.mkdirSync(repo);
  fs.mkdirSync(live);

  const s = {
    config: { repoPath: repo },
    worktrees: {
      a: { id: 'a', path: live, branch: 'live', status: 'session-running', tracked: true, adopted: true, sessionPid: 123 },
      b: { id: 'b', path: path.join(tmp, 'gone'), branch: 'gone', status: 'idle', tracked: true, adopted: true }
    }
  };
  await reconcile(s, {
    startup: true,
    gitList: [
      { path: repo, branch: 'main' },
      { path: live, branch: 'live' }
    ]
  });

  assert.equal(s.worktrees.a.status, 'idle', 'running -> idle on startup');
  assert.equal(s.worktrees.a.sessionPid, null);
  assert.equal(s.worktrees.b.status, 'missing', 'vanished folder flagged');

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('norm: trailing separators and case', () => {
  assert.equal(norm('/a/b/'), norm('/a/b'));
});

// ---- appDir support ------------------------------------------------------

const session = require('../src/session');

function tmpdir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), name));
}

test('resolveAppPath: blank appDir resolves to the worktree root', () => {
  assert.strictEqual(wt.resolveAppPath('/wt/feature', ''), path.resolve('/wt/feature'));
  assert.strictEqual(wt.resolveAppPath('/wt/feature', undefined), path.resolve('/wt/feature'));
});

test('resolveAppPath: nested appDir joins under the worktree root', () => {
  assert.strictEqual(
    wt.resolveAppPath('/wt/feature', 'src/renderer'),
    path.resolve('/wt/feature/src/renderer')
  );
});

test('resolveAppPath: rejects an appDir that escapes the worktree', () => {
  assert.throws(() => wt.resolveAppPath('/wt/feature', '../elsewhere'), /outside/i);
  assert.throws(() => wt.resolveAppPath('/wt/feature', '/abs/path'), /relative/i);
});

test('copyAndPatchEnvFile: writes into the appDir, creating it, not the worktree root', () => {
  const repo = tmpdir('wtd-repo-');
  const worktree = tmpdir('wtd-wt-');
  fs.mkdirSync(path.join(repo, 'src', 'renderer'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'renderer', '.env.development'), 'API_URL=x\nPORT=3000\n');

  const r = wt.copyAndPatchEnvFile({
    repoPath: repo, worktreePath: worktree, appDir: 'src/renderer',
    envFileName: '.env.development', portEnvVar: 'PORT', port: 5005
  });

  const dest = path.join(worktree, 'src', 'renderer', '.env.development');
  assert.strictEqual(r.dest, dest);
  assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'API_URL=x\nPORT=5005\n');
  assert.strictEqual(fs.existsSync(path.join(worktree, '.env.development')), false);
});

test('copyAndPatchEnvFile: appends the port var when the source has none', () => {
  const repo = tmpdir('wtd-repo-');
  const worktree = tmpdir('wtd-wt-');
  fs.mkdirSync(path.join(repo, 'app'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'app', '.env.development'), 'API_URL=x\n');

  wt.copyAndPatchEnvFile({
    repoPath: repo, worktreePath: worktree, appDir: 'app',
    envFileName: '.env.development', portEnvVar: 'PORT', port: 5006
  });

  assert.strictEqual(
    fs.readFileSync(path.join(worktree, 'app', '.env.development'), 'utf8'),
    'API_URL=x\nPORT=5006\n'
  );
});

test('buildPowerShellScript: dev job runs in the appDir, claude pane in the worktree root', () => {
  const script = session.buildPowerShellScript({
    worktreePath: 'C:\\wt\\feature', appPath: 'C:\\wt\\feature\\src\\renderer',
    port: 5005, portEnvVar: 'PORT', devCommand: 'npm run dev',
    dashboardPort: 4999, worktreeId: 'abc', withClaude: true
  });
  assert.match(script, /Set-Location -LiteralPath "C:\\wt\\feature"/);
  assert.match(script, /-ArgumentList "C:\\wt\\feature\\src\\renderer"/);
});

test('buildPowerShellScript: dev-only mode runs the dev command from the appDir', () => {
  const script = session.buildPowerShellScript({
    worktreePath: 'C:\\wt\\feature', appPath: 'C:\\wt\\feature\\src\\renderer',
    port: 5005, portEnvVar: 'PORT', devCommand: 'npm run dev',
    dashboardPort: 4999, worktreeId: 'abc', withClaude: false
  });
  assert.match(script, /Set-Location -LiteralPath "C:\\wt\\feature\\src\\renderer"[\s\S]*npm run dev/);
});

test('buildTerminalScript: opens at the appDir with the port env var preset', () => {
  const script = session.buildTerminalScript({
    worktreePath: 'C:\\wt\\feature', appPath: 'C:\\wt\\feature\\src\\renderer',
    port: 5005, portEnvVar: 'PORT', devCommand: 'npm run dev'
  });
  assert.match(script, /Set-Location -LiteralPath "C:\\wt\\feature\\src\\renderer"/);
  assert.match(script, /\$env:PORT = "5005"/);
  assert.match(script, /npm run dev/);
  // no dev server is started for the user, and nothing calls back to the dashboard
  assert.doesNotMatch(script, /Start-Job/);
  assert.doesNotMatch(script, /Invoke-RestMethod/);
});

// ---- claude session resume -----------------------------------------------

test('claudeArgsFor: starts a named session when no transcript exists yet', () => {
  const args = session.claudeArgsFor({
    claudeSessionId: 'aaaaaaaa-0000-4000-8000-000000000001',
    hasTranscript: false
  });
  assert.strictEqual(args, '--session-id aaaaaaaa-0000-4000-8000-000000000001');
});

test('claudeArgsFor: resumes that session once its transcript exists', () => {
  const args = session.claudeArgsFor({
    claudeSessionId: 'aaaaaaaa-0000-4000-8000-000000000001',
    hasTranscript: true
  });
  assert.strictEqual(args, '--resume aaaaaaaa-0000-4000-8000-000000000001');
});

test('claudeArgsFor: appends any extra args the caller passed', () => {
  const args = session.claudeArgsFor({
    claudeSessionId: 'aaaaaaaa-0000-4000-8000-000000000001',
    hasTranscript: true,
    extra: '--model opus'
  });
  assert.strictEqual(args, '--resume aaaaaaaa-0000-4000-8000-000000000001 --model opus');
});

test('claudeArgsFor: falls back to plain claude when there is no session id', () => {
  assert.strictEqual(session.claudeArgsFor({ extra: '--model opus' }), '--model opus');
  assert.strictEqual(session.claudeArgsFor({}), '');
});

test('claudeArgsFor: rejects a session id that is not a plain UUID', () => {
  assert.throws(
    () => session.claudeArgsFor({ claudeSessionId: 'x; rm -rf /', hasTranscript: false }),
    /uuid/i
  );
});

test('transcriptExists: true only when that session id has a .jsonl on disk', () => {
  const projects = tmpdir('wtd-projects-');
  const worktree = '/somewhere/wt-feature-x';
  const dir = path.join(projects, '-somewhere-wt-feature-x');
  fs.mkdirSync(dir, { recursive: true });
  const id = 'aaaaaaaa-0000-4000-8000-000000000001';

  assert.strictEqual(usage.transcriptExists(worktree, id, projects), false);
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), '{}\n');
  assert.strictEqual(usage.transcriptExists(worktree, id, projects), true);
});

test('buildClaudeScript: resumes claude at the worktree root, with no dev server', () => {
  const script = session.buildClaudeScript({
    worktreePath: 'C:\\wt\\feature',
    claudeArgs: '--resume aaaaaaaa-0000-4000-8000-000000000001'
  });
  assert.match(script, /Set-Location -LiteralPath "C:\\wt\\feature"/);
  assert.match(script, /claude --resume aaaaaaaa-0000-4000-8000-000000000001/);
  // no dev server, and nothing that would auto-commit on exit
  assert.doesNotMatch(script, /Start-Job/);
  assert.doesNotMatch(script, /Invoke-RestMethod/);
  assert.doesNotMatch(script, /npm run dev/);
});

// ---- WSL launcher --------------------------------------------------------

test('launcherKind: windows, wsl and plain linux are told apart', () => {
  assert.strictEqual(session.launcherKind({ platform: 'win32', release: '10.0.22631' }), 'win32');
  assert.strictEqual(session.launcherKind({ platform: 'linux', release: '6.6.87.2-microsoft-standard-WSL2' }), 'wsl');
  assert.strictEqual(session.launcherKind({ platform: 'linux', release: '6.8.0-generic' }), 'posix');
  assert.strictEqual(session.launcherKind({ platform: 'darwin', release: '23.5.0' }), 'posix');
});

test('buildBashClaudeScript: resumes claude at the worktree root, nothing else', () => {
  const s = session.buildBashClaudeScript({
    worktreePath: '/home/j/wt/feature',
    claudeArgs: '--resume aaaaaaaa-0000-4000-8000-000000000001'
  });
  assert.match(s, /cd "\/home\/j\/wt\/feature"/);
  assert.match(s, /claude --resume aaaaaaaa-0000-4000-8000-000000000001/);
  assert.doesNotMatch(s, /npm run dev/);
  assert.doesNotMatch(s, /curl/);
});

test('buildBashTerminalScript: lands in the app folder with the port exported', () => {
  const s = session.buildBashTerminalScript({
    worktreePath: '/home/j/wt/feature',
    appPath: '/home/j/wt/feature/src/renderer',
    port: 5005, portEnvVar: 'PORT', devCommand: 'npm run dev'
  });
  assert.match(s, /cd "\/home\/j\/wt\/feature\/src\/renderer"/);
  assert.match(s, /export PORT="5005"/);
  assert.doesNotMatch(s, /^npm run dev$/m);
});

test('buildBashSessionScript: dev server in the app folder, claude at the root', () => {
  const s = session.buildBashSessionScript({
    worktreePath: '/home/j/wt/feature',
    appPath: '/home/j/wt/feature/src/renderer',
    port: 5005, portEnvVar: 'PORT', devCommand: 'npm run dev',
    dashboardPort: 4999, worktreeId: 'abc',
    claudeArgs: '--resume aaaaaaaa-0000-4000-8000-000000000001',
    withClaude: true
  });
  assert.match(s, /cd "\/home\/j\/wt\/feature\/src\/renderer"[\s\S]*npm run dev/);
  assert.match(s, /cd "\/home\/j\/wt\/feature"/);
  assert.match(s, /claude --resume aaaaaaaa-0000-4000-8000-000000000001/);
  assert.match(s, /worktrees\/abc\/session\/exit/);
  assert.match(s, /kill /);
});

test('buildBashSessionScript: dev-only mode runs no claude and never calls back', () => {
  const s = session.buildBashSessionScript({
    worktreePath: '/home/j/wt/feature',
    appPath: '/home/j/wt/feature/src/renderer',
    port: 5005, portEnvVar: 'PORT', devCommand: 'npm run dev',
    dashboardPort: 4999, worktreeId: 'abc', withClaude: false
  });
  assert.match(s, /npm run dev/);
  assert.doesNotMatch(s, /\bclaude\b/);
  assert.doesNotMatch(s, /curl/);
});

test('wslWindowArgs: opens a Windows Terminal tab back into the distro', () => {
  const args = session.wslWindowArgs({ scriptPath: '/tmp/s.sh', title: 'wt:abc', distro: 'Ubuntu-24.04', hasWindowsTerminal: true });
  assert.deepStrictEqual(args.slice(0, 6), ['new-tab', '--title', 'wt:abc', 'wsl.exe', '-d', 'Ubuntu-24.04']);
  assert.ok(args.join(' ').includes('/tmp/s.sh'));
});

// ---- port choice, dev command, and path normalization ---------------------

const ports = require('../src/ports');

function stateWith(worktrees, { startPort = 5002, nextPort = 5002 } = {}) {
  return { config: { startPort }, worktrees, nextPort };
}

test('validatePort: rejects non-integers and out-of-range values', async () => {
  const s = stateWith({});
  await assert.rejects(() => ports.validatePort('abc', s), /whole number/);
  await assert.rejects(() => ports.validatePort('50.5', s), /whole number/);
  await assert.rejects(() => ports.validatePort(80, s), /between 1024 and 65535/);
  await assert.rejects(() => ports.validatePort(70000, s), /between 1024 and 65535/);
});

test('validatePort: rejects a port already assigned to another worktree', async () => {
  const s = stateWith({ a: { id: 'a', branch: 'feature/x', port: 5002 } });
  await assert.rejects(() => ports.validatePort(5002, s), /already assigned .*feature\/x/);
});

test('validatePort: the worktree already holding the port may keep it', async () => {
  const s = stateWith({ a: { id: 'a', branch: 'feature/x', port: 5002 } });
  assert.equal(await ports.validatePort(5002, s, { excludeId: 'a' }), 5002);
});

test('validatePort: accepts a free port and returns it as a number', async () => {
  const s = stateWith({});
  assert.strictEqual(await ports.validatePort('5399', s), 5399);
});

test('findFreePort peeks without consuming; allocatePort advances nextPort', async () => {
  const s = stateWith({}, { startPort: 5210, nextPort: 5210 });
  const peeked = await ports.findFreePort(s);
  assert.equal(s.nextPort, 5210, 'peeking must not move the cursor');
  const taken = await ports.allocatePort(s);
  assert.equal(taken, peeked);
  assert.equal(s.nextPort, peeked + 1);
});

test('findFreePort skips ports already assigned to worktrees', async () => {
  const s = stateWith(
    { a: { id: 'a', branch: 'x', port: 5310 }, b: { id: 'b', branch: 'y', port: 5311 } },
    { startPort: 5310, nextPort: 5310 }
  );
  assert.equal(await ports.findFreePort(s), 5312);
});

test('applyPortPlaceholder: substitutes every {port}, leaves other commands alone', () => {
  assert.equal(
    session.applyPortPlaceholder('npm run dev-mt -- --port {port}', 5002),
    'npm run dev-mt -- --port 5002'
  );
  assert.equal(
    session.applyPortPlaceholder('serve --port {port} --admin {port}', 4100),
    'serve --port 4100 --admin 4100'
  );
  assert.equal(session.applyPortPlaceholder('npm run dev', 5002), 'npm run dev');
  assert.equal(session.applyPortPlaceholder('', 5002), '');
  assert.equal(session.applyPortPlaceholder(undefined, 5002), '');
});

test('applyPortPlaceholder: no port yet leaves the placeholder visible', () => {
  assert.equal(
    session.applyPortPlaceholder('npm run dev -- --port {port}', null),
    'npm run dev -- --port {port}'
  );
});

test('script builders substitute {port} into the dev command', () => {
  const args = {
    worktreePath: '/repo/.worktrees/wt-feature',
    appPath: '/repo/.worktrees/wt-feature/app',
    port: 5007,
    portEnvVar: 'PORT',
    devCommand: 'npm run dev-tt -- --port {port}',
    dashboardPort: 4999,
    worktreeId: 'id-1',
    claudeArgs: '--session-id 00000000-0000-4000-8000-000000000000'
  };
  const scripts = [
    session.buildPowerShellScript({ ...args, withClaude: true }),
    session.buildPowerShellScript({ ...args, withClaude: false }),
    session.buildTerminalScript(args),
    session.buildBashSessionScript({ ...args, withClaude: true }),
    session.buildBashSessionScript({ ...args, withClaude: false }),
    session.buildBashTerminalScript(args)
  ];
  for (const s of scripts) {
    assert.match(s, /--port 5007/, 'placeholder should be substituted');
    assert.ok(!s.includes('{port}'), 'no raw placeholder should survive');
  }
});

test('normalizeUserPath: strips quotes, whitespace and trailing separators', () => {
  const base = path.join(os.tmpdir(), 'wtd-norm');
  assert.equal(wt.normalizeUserPath(`  "${base}"  `), path.resolve(base));
  assert.equal(wt.normalizeUserPath(`${base}${path.sep}`), path.resolve(base));
  assert.equal(wt.normalizeUserPath("'" + base + "'"), path.resolve(base));
});

test('normalizeUserPath: blank input stays blank rather than becoming cwd', () => {
  assert.equal(wt.normalizeUserPath(''), '');
  assert.equal(wt.normalizeUserPath('   '), '');
  assert.equal(wt.normalizeUserPath(null), '');
  assert.equal(wt.normalizeUserPath(undefined), '');
});

test('listScripts: reads npm script names from the app package.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtd-scripts-'));
  fs.mkdirSync(path.join(dir, 'app'));
  fs.writeFileSync(
    path.join(dir, 'app', 'package.json'),
    JSON.stringify({ scripts: { dev: 'vite', 'dev-mt': 'vite --mode mt', 'dev-tt': 'vite --mode tt' } })
  );
  assert.deepEqual(wt.listScripts({ repoPath: dir, appDir: 'app' }), ['dev', 'dev-mt', 'dev-tt']);
});

test('listScripts: missing or unreadable package.json yields no suggestions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtd-scripts-'));
  assert.deepEqual(wt.listScripts({ repoPath: dir, appDir: '' }), []);
  fs.writeFileSync(path.join(dir, 'package.json'), 'not json');
  assert.deepEqual(wt.listScripts({ repoPath: dir, appDir: '' }), []);
  assert.deepEqual(wt.listScripts({ repoPath: null, appDir: '' }), []);
});

// ---- reconcile: a failed git call must not look like "no worktrees" -------

test('reconcile: a git failure leaves every record alone', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wtd-test-'));
  const notARepo = path.join(tmp, 'not-a-repo');
  const live = path.join(tmp, 'wt-live');
  fs.mkdirSync(notARepo);
  fs.mkdirSync(live);

  const s = {
    config: { repoPath: notARepo },
    worktrees: {
      a: { id: 'a', path: live, branch: 'live', status: 'session-running', tracked: true, sessionPid: 42 }
    }
  };
  // No gitList injected, and repoPath is not a git repo -> listGitWorktrees throws.
  await reconcile(s);

  assert.equal(s.worktrees.a.status, 'session-running', 'must not be downgraded to missing');
  assert.equal(s.worktrees.a.sessionPid, 42);

  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---- ports: reclamation and reservations ---------------------------------

test('findFreePort reuses a port freed by a removed worktree', async () => {
  // nextPort has drifted upwards, but 5320 is free again: it must come back.
  const s = { config: { startPort: 5320 }, worktrees: {}, nextPort: 5400 };
  assert.equal(await ports.findFreePort(s), 5320);
});

test('reserve holds a port until the worktree record exists', async () => {
  const s = { config: { startPort: 5330 }, worktrees: {}, nextPort: 5330, reservations: {} };
  const first = await ports.allocatePort(s);
  ports.reserve(s, first);
  const second = await ports.findFreePort(s);
  assert.notEqual(second, first, 'a concurrent create must not get the same port');
  await assert.rejects(() => ports.validatePort(first, s), /being created/);

  ports.release(s, first);
  assert.equal(await ports.findFreePort(s), first, 'released once the record is written');
});

test('reserve ignores expired reservations', async () => {
  const s = { config: { startPort: 5340 }, worktrees: {}, nextPort: 5340, reservations: { 5340: Date.now() - 1000 } };
  assert.equal(await ports.findFreePort(s), 5340);
});

// ---- shell/PowerShell injection through paths and args --------------------

test('buildPowerShellScript: a branch name cannot inject a PowerShell subexpression', () => {
  const script = session.buildPowerShellScript({
    worktreePath: 'C:\\wt\\wt-feat$(calc)',
    appPath: 'C:\\wt\\wt-feat$(calc)',
    port: 5005, portEnvVar: 'PORT', devCommand: 'npm run dev',
    dashboardPort: 4999, worktreeId: 'abc', withClaude: true
  });
  assert.ok(!/[^`]\$\(calc\)/.test(script), 'every $( must be backtick-escaped');
  assert.match(script, /`\$\(calc\)/);
});

test('buildBashSessionScript: a branch name cannot inject a bash subshell', () => {
  const s = session.buildBashSessionScript({
    worktreePath: '/wt/wt-feat$(touch pwned)',
    appPath: '/wt/wt-feat$(touch pwned)',
    port: 5005, portEnvVar: 'PORT', devCommand: 'npm run dev',
    dashboardPort: 4999, worktreeId: 'abc', claudeArgs: '', withClaude: true
  });
  assert.ok(!/[^\\]\$\(touch/.test(s), 'every $( must be backslash-escaped');
});

test('claudeArgsFor: refuses extra args carrying shell metacharacters', () => {
  const id = 'aaaaaaaa-0000-4000-8000-000000000001';
  assert.throws(() => session.claudeArgsFor({ claudeSessionId: id, extra: '--model x; curl evil.test' }), /metacharacters/);
  assert.throws(() => session.claudeArgsFor({ claudeSessionId: id, extra: '--model $(id)' }), /metacharacters/);
  assert.throws(() => session.claudeArgsFor({ claudeSessionId: id, extra: '--model `id`' }), /metacharacters/);
  // ordinary flags still go through
  assert.equal(
    session.claudeArgsFor({ claudeSessionId: id, hasTranscript: true, extra: '--model opus' }),
    `--resume ${id} --model opus`
  );
});

// ---- the session-exit callback is token-gated ----------------------------

test('session scripts carry the per-launch exit token, and omit it when absent', () => {
  const args = {
    worktreePath: '/wt/f', appPath: '/wt/f', port: 5005, portEnvVar: 'PORT',
    devCommand: 'npm run dev', dashboardPort: 4999, worktreeId: 'abc',
    claudeArgs: '', withClaude: true
  };
  const withToken = session.buildBashSessionScript({ ...args, sessionToken: 'deadbeef' });
  assert.match(withToken, /session\/exit\?token=deadbeef/);
  const ps = session.buildPowerShellScript({ ...args, sessionToken: 'deadbeef' });
  assert.match(ps, /session\/exit\?token=deadbeef/);
  // builders called without a token (tests, older records) emit a clean URL
  assert.match(session.buildBashSessionScript(args), /session\/exit"/);
});

// ---- transcript directory matching ---------------------------------------

test('findProjectLogDir: same folder name under two roots does not collide', () => {
  const projects = tmpdir('wtd-projects-');
  fs.mkdirSync(path.join(projects, '-repo-a-wt-feature'), { recursive: true });
  const id = 'aaaaaaaa-0000-4000-8000-000000000001';
  fs.writeFileSync(path.join(projects, '-repo-a-wt-feature', `${id}.jsonl`), '{}\n');

  // repo-b's worktree has the same basename but no transcripts of its own
  assert.strictEqual(usage.transcriptExists('/repo/b/wt-feature', id, projects), false);
  assert.strictEqual(usage.transcriptExists('/repo/a/wt-feature', id, projects), true);
});

test('findProjectLogDir: a dot-directory root still matches', () => {
  const projects = tmpdir('wtd-projects-');
  // the CLI flattens the dot in ".worktrees" to a dash
  fs.mkdirSync(path.join(projects, '-repo--worktrees-wt-feature'), { recursive: true });
  const id = 'aaaaaaaa-0000-4000-8000-000000000001';
  fs.writeFileSync(path.join(projects, '-repo--worktrees-wt-feature', `${id}.jsonl`), '{}\n');
  assert.strictEqual(usage.transcriptExists('/repo/.worktrees/wt-feature', id, projects), true);
});

// ---- node_modules removal must never follow the link ----------------------

test('removeNodeModules: unlinks the junction without touching the main tree', () => {
  const root = tmpdir('wtd-nm-');
  const main = path.join(root, 'main', 'node_modules');
  const worktree = path.join(root, 'wt');
  fs.mkdirSync(main, { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(main, 'marker.txt'), 'keep me');
  const link = path.join(worktree, 'node_modules');
  fs.symlinkSync(main, link, 'dir');

  wt.removeNodeModules(link);

  assert.strictEqual(fs.existsSync(link), false, 'link removed');
  assert.strictEqual(fs.existsSync(path.join(main, 'marker.txt')), true, 'main node_modules untouched');
});
