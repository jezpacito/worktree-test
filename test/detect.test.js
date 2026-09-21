// Detection is what spares the user from knowing whether their dev server
// wants PORT= or --port. These cases are the ones that actually differ.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const detect = require('../src/detect');

function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtd-detect-'));
  for (const [name, body] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  }
  return dir;
}

function run(dir, envFileName = '.env.development') {
  return detect.detectProject({ repoPath: dir, appPath: dir, envFileName });
}

test('vite: gets --port on the command, because it ignores PORT', () => {
  const dir = project({
    'package.json': { scripts: { dev: 'vite' }, devDependencies: { vite: '^5.0.0' } }
  });
  const d = run(dir);
  assert.equal(d.devCommand, 'npm run dev -- --port {port}');
  assert.equal(d.framework, 'vite');
  assert.ok(d.notes.some((n) => /ignores a PORT env var/.test(n)));
});

test('next: keeps the plain command and uses the PORT env var', () => {
  const dir = project({
    'package.json': { scripts: { dev: 'next dev' }, dependencies: { next: '^14.0.0' } }
  });
  const d = run(dir);
  assert.equal(d.devCommand, 'npm run dev');
  assert.equal(d.portEnvVar, 'PORT');
  assert.equal(d.framework, null);
});

test('a dev script that shells out to vite is caught even without the dependency', () => {
  const dir = project({ 'package.json': { scripts: { dev: 'vite --host' } } });
  assert.equal(run(dir).devCommand, 'npm run dev -- --port {port}');
});

test('the port flag is not added twice when the script already has {port}', () => {
  const cmd = detect.withPortFlag('npm run dev -- --port {port}', '--port');
  assert.equal(cmd, 'npm run dev -- --port {port}');
});

test('a non-npm command gets the flag without the -- separator', () => {
  assert.equal(detect.withPortFlag('vite', '--port'), 'vite --port {port}');
});

test('the env file names the port variable when the project already does', () => {
  const dir = project({
    'package.json': { scripts: { dev: 'node server.js' } },
    '.env.development': 'API_URL=x\nVITE_PORT=5173\n'
  });
  const d = run(dir);
  assert.equal(d.portEnvVar, 'VITE_PORT');
  assert.ok(d.notes.some((n) => /VITE_PORT/.test(n)));
});

test('a plain PORT wins over a prefixed one', () => {
  assert.equal(detect.portVarFromEnvFile('APP_PORT=1\nPORT=2\n'), 'PORT');
  assert.equal(detect.portVarFromEnvFile('APP_PORT=1\n'), 'APP_PORT');
  // only a name that ENDS in PORT is a port variable
  assert.equal(detect.portVarFromEnvFile('NO_PORTS_HERE_AT_ALL=1\n'), null);
  assert.equal(detect.portVarFromEnvFile('PORT=3000\n'), 'PORT', 'a plain PORT line must be found');
  assert.equal(detect.portVarFromEnvFile('API_URL=x\n'), null);
});

test('https is detected from a TLS plugin, a flag, the env file or vite config', () => {
  assert.equal(run(project({
    'package.json': { scripts: { dev: 'vite' }, devDependencies: { 'vite-plugin-mkcert': '^1' } }
  })).devServerScheme, 'https');

  assert.equal(run(project({
    'package.json': { scripts: { dev: 'next dev --experimental-https' } }
  })).devServerScheme, 'https');

  assert.equal(run(project({
    'package.json': { scripts: { dev: 'react-scripts start' } },
    '.env.development': 'HTTPS=true\n'
  })).devServerScheme, 'https');

  assert.equal(run(project({
    'package.json': { scripts: { dev: 'vite' } },
    'vite.config.ts': 'export default { server: { https: true, port: 5173 } }'
  })).devServerScheme, 'https');
});

test('a plain http project is not mistaken for https', () => {
  const d = run(project({
    'package.json': { scripts: { dev: 'vite' } },
    '.env.development': 'API_URL=https://api.example.com\n'
  }));
  assert.equal(d.devServerScheme, 'http', 'an https URL in a value is not the dev server');
});

test('an unreadable project falls back to the conventional PORT', () => {
  const d = run(project({ 'README.md': 'no package.json here' }));
  assert.equal(d.portEnvVar, 'PORT');
  assert.equal(d.devCommand, null);
  assert.ok(d.notes.some((n) => /No readable package\.json/.test(n)));
});

test('the dev script is found even when it is not called "dev"', () => {
  assert.equal(detect.pickDevScript({ build: 'x', 'dev-mt': 'vite' }), 'dev-mt');
  assert.equal(detect.pickDevScript({ build: 'x', start: 'node .' }), 'start');
  assert.equal(detect.pickDevScript({ dev: 'a', start: 'b' }), 'dev', 'dev preferred over start');
  assert.equal(detect.pickDevScript({ build: 'x' }), null);
});

// ---- finding the app, and the env file it actually has --------------------

test('detectAppDir: an app at the repo root means no subfolder', () => {
  const dir = project({ 'package.json': { scripts: { dev: 'vite' } } });
  assert.equal(detect.detectAppDir(dir), '');
});

test('detectAppDir: finds a monorepo app under apps/', () => {
  const dir = project({
    'package.json': { name: 'root', private: true },
    'apps/web/package.json': { scripts: { dev: 'vite' } }
  });
  assert.equal(detect.detectAppDir(dir), 'apps/web');
});

test('detectAppDir: finds a conventional subfolder before an arbitrary one', () => {
  const dir = project({
    'package.json': { name: 'root' },
    'zzz-other/package.json': { scripts: { dev: 'vite' } },
    'client/package.json': { scripts: { dev: 'vite' } }
  });
  assert.equal(detect.detectAppDir(dir), 'client');
});

test('detectAppDir: a package.json with no dev script does not count as the app', () => {
  const dir = project({
    'package.json': { name: 'root' },
    'tools/package.json': { scripts: { build: 'tsc' } }
  });
  assert.equal(detect.detectAppDir(dir), '');
});

test('detectAppDir: nothing to find is not an error', () => {
  assert.equal(detect.detectAppDir(project({ 'README.md': 'empty' })), '');
  assert.equal(detect.detectAppDir(''), '');
});

test('detectEnvFileName: keeps the configured file when it exists', () => {
  const dir = project({ '.env.development': 'X=1', '.env': 'Y=2' });
  assert.equal(detect.detectEnvFileName(dir, '.env.development'), '.env.development');
});

test('detectEnvFileName: falls back to whichever env file the app has', () => {
  const dir = project({ '.env.local': 'X=1' });
  assert.equal(detect.detectEnvFileName(dir, '.env.development'), '.env.local');
  assert.equal(detect.detectEnvFileName(project({ 'a.txt': '' }), '.env.development'), null);
});

test('a nested vite app is read from its own folder, not the repo root', () => {
  const dir = project({
    'package.json': { name: 'root' },
    'apps/web/package.json': { scripts: { dev: 'vite' }, devDependencies: { vite: '^5' } },
    'apps/web/.env.local': 'VITE_PORT=5173\nHTTPS=true\n'
  });
  const appDir = detect.detectAppDir(dir);
  const d = detect.detectProject({
    repoPath: dir, appPath: path.join(dir, appDir), envFileName: '.env.development'
  });
  assert.equal(appDir, 'apps/web');
  assert.equal(d.devCommand, 'npm run dev -- --port {port}');
  assert.equal(d.portEnvVar, 'VITE_PORT');
  assert.equal(d.envFileName, '.env.local');
  assert.equal(d.devServerScheme, 'https');
});
