// Tests that touch the HTTP layer and real git. HOME is redirected FIRST, so
// state.js computes its APP_DIR inside a throwaway directory and the developer's
// own ~/.worktree-dashboard/state.json is never read or written by the suite.
const fs = require('fs');
const os = require('os');
const path = require('path');

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wtd-home-'));
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;

const http = require('http');
const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../src/server');
const git = require('../src/git');
const wt = require('../src/worktrees');

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

// fetch() refuses to set Host (it is a forbidden header), so the rebinding case
// has to be sent with the raw http client.
function rawGet(port, host) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/api/config', method: 'GET', headers: { Host: host } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

test('the API refuses a request addressed to anything but localhost', async () => {
  const { server } = await listen(createApp());
  const port = server.address().port;
  try {
    // A DNS-rebinding page reaches us on 127.0.0.1 but still sends its own Host.
    assert.equal(await rawGet(port, 'evil.test'), 403);
    assert.equal(await rawGet(port, `localhost:${port}`), 200);
    assert.equal(await rawGet(port, `127.0.0.1:${port}`), 200);
  } finally {
    server.close();
  }
});

test('the API refuses a state-changing request from a foreign origin', async () => {
  const { server, base } = await listen(createApp());
  try {
    // text/plain is a CORS-simple type, so this POST would otherwise arrive
    // with no preflight to stop it.
    const cross = await fetch(`${base}/api/worktrees/whatever/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Origin: 'https://evil.test' },
      body: ''
    });
    assert.equal(cross.status, 403);

    const sameOrigin = await fetch(`${base}/api/worktrees/whatever/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: '{}'
    });
    assert.equal(sameOrigin.status, 404, 'a genuine request still gets through to the handler');
  } finally {
    server.close();
  }
});

test('POST /api/config rejects a port env var that is not an identifier', async () => {
  const { server, base } = await listen(createApp());
  try {
    const res = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ portEnvVar: 'PORT; rm -rf ~' })
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /plain identifier/);
  } finally {
    server.close();
  }
});

// ---- auto-commit must not sweep up an un-ignored env file ------------------

async function tinyRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtd-git-'));
  await wt.run('git', ['init', '-q', '.'], dir);
  await wt.run('git', ['config', 'user.email', 'test@example.com'], dir);
  await wt.run('git', ['config', 'user.name', 'test'], dir);
  await wt.run('git', ['commit', '-q', '--allow-empty', '-m', 'init'], dir);
  return dir;
}

test('commitAll: excluded paths stay out of the commit', async () => {
  const dir = await tinyRepo();
  fs.writeFileSync(path.join(dir, 'work.txt'), 'real change');
  fs.writeFileSync(path.join(dir, '.env.development'), 'SECRET=hunter2\nPORT=5005\n');

  const result = await git.commitAll({
    worktreePath: dir, message: 'WIP', excludePaths: ['.env.development']
  });
  assert.equal(result.committed, true);

  const { stdout } = await wt.run('git', ['show', '--name-only', '--format=', 'HEAD'], dir);
  assert.match(stdout, /work\.txt/);
  assert.doesNotMatch(stdout, /\.env\.development/, 'the env file must not be committed');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('isIgnored: true only for a path the project actually ignores', async () => {
  const dir = await tinyRepo();
  fs.writeFileSync(path.join(dir, '.gitignore'), '.env.development\n');
  assert.equal(await wt.isIgnored({ worktreePath: dir, relPath: '.env.development' }), true);
  assert.equal(await wt.isIgnored({ worktreePath: dir, relPath: 'src/index.js' }), false);
  fs.rmSync(dir, { recursive: true, force: true });
});


test('the session token never leaves the server', async () => {
  const state = require('../src/state');
  const s = state.load();
  s.config.repoPath = null;
  s.worktrees = {
    tok: { id: 'tok', branch: 'x', path: '/nope', port: 5002, status: 'idle', sessionToken: 'super-secret' }
  };
  state.save(s);

  const { server, base } = await listen(createApp());
  try {
    const body = await (await fetch(`${base}/api/worktrees`)).text();
    assert.doesNotMatch(body, /super-secret/, 'the callback token must not reach the browser');
    assert.match(body, /"id":"tok"/, 'the rest of the record still does');

    const idle = await (await fetch(`${base}/api/worktrees/tok/mark-idle`, { method: 'POST' })).text();
    assert.doesNotMatch(idle, /super-secret/);
  } finally {
    server.close();
  }
});

test('the session-exit callback refuses a wrong or missing token', async () => {
  const state = require('../src/state');
  const s = state.load();
  s.config.repoPath = null;
  s.worktrees = {
    tok: { id: 'tok', branch: 'x', path: '/nope', port: 5002, status: 'session-running', sessionToken: 'super-secret' }
  };
  state.save(s);

  const { server, base } = await listen(createApp());
  try {
    const none = await fetch(`${base}/api/worktrees/tok/session/exit`, { method: 'POST' });
    assert.equal(none.status, 403);
    const wrong = await fetch(`${base}/api/worktrees/tok/session/exit?token=guess`, { method: 'POST' });
    assert.equal(wrong.status, 403);
    // status untouched by the rejected attempts
    assert.equal(state.load().worktrees.tok.status, 'session-running');
  } finally {
    server.close();
  }
});

test('an https localhost front-end is not mistaken for a foreign origin', async () => {
  const { server, base } = await listen(createApp());
  try {
    for (const origin of ['https://localhost', 'https://localhost:8443', 'https://127.0.0.1', 'http://[::1]:4999']) {
      const res = await fetch(`${base}/api/worktrees/whatever/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin },
        body: '{}'
      });
      assert.equal(res.status, 404, `${origin} should reach the handler, not the guard`);
    }
  } finally {
    server.close();
  }
});

test('the Host check ignores case and a trailing FQDN dot', async () => {
  const { server } = await listen(createApp());
  const port = server.address().port;
  try {
    assert.equal(await rawGet(port, `LOCALHOST:${port}`), 200);
    assert.equal(await rawGet(port, `localhost.:${port}`), 200);
    assert.equal(await rawGet(port, '[::1]'), 200);
    assert.equal(await rawGet(port, 'localhost.evil.test'), 403, 'a suffix match must not count');
  } finally {
    server.close();
  }
});

test('WTD_ALLOWED_HOSTS lets a deliberate proxy hostname through', async () => {
  const previous = process.env.WTD_ALLOWED_HOSTS;
  process.env.WTD_ALLOWED_HOSTS = 'wtd.internal, dash.localhost';
  const { server, base } = await listen(createApp());
  const port = server.address().port;
  try {
    assert.equal(await rawGet(port, 'wtd.internal'), 200);
    assert.equal(await rawGet(port, 'dash.localhost'), 200);
    assert.equal(await rawGet(port, 'other.internal'), 403);

    // ...and its https origin is accepted for writes, while others are not
    const allowed = await fetch(`${base}/api/worktrees/whatever/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://wtd.internal' },
      body: '{}'
    });
    assert.equal(allowed.status, 404);
    const denied = await fetch(`${base}/api/worktrees/whatever/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.test' },
      body: '{}'
    });
    assert.equal(denied.status, 403);
  } finally {
    server.close();
    if (previous === undefined) delete process.env.WTD_ALLOWED_HOSTS;
    else process.env.WTD_ALLOWED_HOSTS = previous;
  }
});

test('a spoofed x-forwarded-host cannot get past the Host check', async () => {
  const { server } = await listen(createApp());
  const port = server.address().port;
  try {
    const status = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1', port, path: '/api/config', method: 'GET',
          headers: { Host: 'evil.test', 'X-Forwarded-Host': 'localhost' }
        },
        (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403);
  } finally {
    server.close();
  }
});

test('saving Settings with the fields blank fills them in from the project', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'wtd-vite-'));
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({
    scripts: { dev: 'vite' },
    devDependencies: { vite: '^5.0.0', 'vite-plugin-mkcert': '^1.17.0' }
  }));
  fs.mkdirSync(path.join(repo, '.git'));

  const { server, base } = await listen(createApp());
  try {
    const res = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoPath: repo, devCommand: '', portEnvVar: '', devServerScheme: '' })
    });
    const cfg = await res.json();
    assert.equal(cfg.devCommand, 'npm run dev -- --port {port}', 'vite needs the flag, not PORT=');
    assert.equal(cfg.devServerScheme, 'https');
    assert.ok(cfg.detected.notes.some((n) => /ignores a PORT env var/.test(n)));

    // ...and a value typed by hand is never overwritten by detection
    const override = await (await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ devCommand: 'pnpm serve --port {port}', devServerScheme: 'http' })
    })).json();
    assert.equal(override.devCommand, 'pnpm serve --port {port}');
    assert.equal(override.devServerScheme, 'http');
  } finally {
    server.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('POST /api/config rejects a dev server scheme that is not http or https', async () => {
  const { server, base } = await listen(createApp());
  try {
    const res = await fetch(`${base}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ devServerScheme: 'ftp' })
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /http or https/);
  } finally {
    server.close();
  }
});

test.after(() => fs.rmSync(FAKE_HOME, { recursive: true, force: true }));
