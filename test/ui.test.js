// Browser tests. These drive the real dashboard in a real browser against a
// real git repo: the point is to catch what unit tests structurally cannot --
// that the page wires up, that detection reaches the fields a person actually
// reads, and that the settings panel opens with one field rather than ten.
//
// Skipped automatically when Playwright or its browser is not installed, so
// `npm test` still works on a machine that has neither.
//
// Screenshots land in test/screenshots/ for eyeballing.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Captured before HOME is redirected: the browser cache lives in the REAL home,
// while the dashboard's state must not.
const REAL_HOME = os.homedir();

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wtd-ui-home-'));
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;

const test = require('node:test');
const assert = require('node:assert');
const { execFile } = require('child_process');
const util = require('util');
const execFileP = util.promisify(execFile);

const SHOTS = path.join(__dirname, 'screenshots');

let chromium = null;
let executablePath;
try {
  ({ chromium } = require('playwright'));
  executablePath = chromium.executablePath();
  if (!fs.existsSync(executablePath)) {
    // Fall back to any other browser build already on the machine, so a
    // version bump in playwright does not force a 170MB download.
    const cache = path.join(REAL_HOME, '.cache', 'ms-playwright');
    const build = fs.existsSync(cache)
      ? fs.readdirSync(cache)
        .filter((d) => /^chromium-\d+$/.test(d))
        .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
        .map((d) => path.join(cache, d, 'chrome-linux64', 'chrome'))
        .find((p) => fs.existsSync(p))
      : null;
    executablePath = build || null;
  }
} catch {
  chromium = null;
}

const describe = chromium && executablePath ? test : test.skip;

// A real project to point the dashboard at: a monorepo whose app is nested,
// uses Vite, names its port VITE_PORT and serves https. Every one of those is
// something the user would otherwise have had to type in by hand.
// The repo goes one level down inside its own temp directory, so the sibling
// .worktrees folder the dashboard creates lands in there too and is removed
// with it -- rather than in /tmp, where it would outlive the run and make the
// next one fail on a folder that already exists.
async function fixtureRepo() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'wtd-ui-'));
  const root = path.join(workspace, 'project');
  const app = path.join(root, 'apps', 'web');
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'root', private: true }));
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({
    name: 'web',
    scripts: { dev: 'vite', build: 'vite build' },
    devDependencies: { vite: '^5.0.0' }
  }, null, 2));
  fs.writeFileSync(path.join(app, '.env.local'), 'API_URL=x\nVITE_PORT=5173\nHTTPS=true\n');
  fs.writeFileSync(path.join(root, '.gitignore'), '.env.local\nnode_modules\n');

  const git = (...args) => execFileP('git', args, { cwd: root });
  await git('init', '-q', '.');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'test');
  await git('add', '-A');
  await git('commit', '-qm', 'init');
  return { workspace, root };
}

async function startDashboard() {
  const { createApp } = require('../src/server');
  return new Promise((resolve) => {
    const app = createApp();
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

describe('the dashboard loads, detects the project, and shows one field to fill in', async (t) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const { workspace, root: repo } = await fixtureRepo();
  const { server, base } = await startDashboard();
  const browser = await chromium.launch({ executablePath });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('response', async (r) => {
    if (r.status() >= 400) {
      let body = '';
      try { body = (await r.text()).slice(0, 300); } catch { /* no body */ }
      consoleErrors.push(`${r.status()} ${new URL(r.url()).pathname} ${body}`);
    }
  });
  page.on('pageerror', (e) => consoleErrors.push(e.message));

  try {
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.screenshot({ path: path.join(SHOTS, '1-empty.png'), fullPage: true });

    await t.test('the page renders with no console errors', () => {
      assert.deepEqual(consoleErrors, [], 'the page must load clean');
    });

    await t.test('settings opens showing the project path, with the rest folded away', async () => {
      await page.click('#toggleSettings');
      await page.waitForSelector('#settingsPanel:not([hidden])');

      assert.ok(await page.isVisible('#cfgRepoPath'), 'the one field you must answer is visible');
      for (const id of ['#cfgAppDir', '#cfgDevCommand', '#cfgPortEnvVar', '#cfgEnvFile', '#cfgPricing']) {
        assert.equal(await page.isVisible(id), false, `${id} starts folded away`);
      }
      await page.screenshot({ path: path.join(SHOTS, '2-settings-clean.png'), fullPage: true });
    });

    await t.test('entering only the repo path fills in everything else', async () => {
      await page.fill('#cfgRepoPath', repo);
      await page.click('#saveConfig');
      await page.waitForSelector('#configStatus.ok');

      // The resolved-path line must include the detected app folder, not stop
      // at the worktree root just because the subfolder box is empty.
      assert.match(await page.textContent('#appDirHint'), /apps\/web/);

      const notes = await page.$$eval('#detectNote li', (els) => els.map((e) => e.textContent));
      assert.ok(notes.some((n) => /apps\/web/.test(n)), 'says where the app is');
      assert.ok(notes.some((n) => /ignores a PORT env var/.test(n)), 'says why the command got --port');
      assert.ok(notes.some((n) => /VITE_PORT/.test(n)), 'says which port variable it took');
      assert.ok(notes.some((n) => /https/i.test(n)), 'says it spotted https');

      await page.screenshot({ path: path.join(SHOTS, '3-detected.png'), fullPage: true });
    });

    await t.test('the override boxes are empty, and show what was detected', async () => {
      await page.click('#settingsOverrides > summary');
      await page.waitForSelector('#cfgDevCommand', { state: 'visible' });

      // Empty means "auto". A default sitting in a box would be taken for the
      // user's own answer on the next save, and would beat detection.
      for (const id of ['#cfgAppDir', '#cfgDevCommand', '#cfgPortEnvVar', '#cfgEnvFile']) {
        assert.equal(await page.inputValue(id), '', `${id} stays on auto`);
      }
      assert.equal(await page.inputValue('#cfgDevServerScheme'), '');

      const ph = (id) => page.getAttribute(id, 'placeholder');
      assert.match(await ph('#cfgAppDir'), /apps\/web/);
      assert.match(await ph('#cfgDevCommand'), /npm run dev -- --port \{port\}/);
      assert.match(await ph('#cfgPortEnvVar'), /VITE_PORT/);
      assert.match(await ph('#cfgEnvFile'), /\.env\.local/);
      assert.match(
        await page.textContent('#cfgDevServerScheme option[value=""]'), /auto \(https\)/);

      await page.screenshot({ path: path.join(SHOTS, '4-overrides-open.png'), fullPage: true });
    });

    // "Settings saved" appears before the fields are repopulated, so wait on the
    // field reaching the value we are actually asserting about.
    async function saveUntil(selector, predicate) {
      await page.click('#saveConfig');
      await page.waitForSelector('#configStatus.ok');
      await page.waitForFunction(
        ({ sel, want }) => document.querySelector(sel).value === want,
        { sel: selector, want: predicate },
        { timeout: 10000 }
      );
    }

    await t.test('typing an override sticks, and clearing it goes back to auto', async () => {
      await page.fill('#cfgDevCommand', 'pnpm dev --port {port}');
      await saveUntil('#cfgDevCommand', 'pnpm dev --port {port}');
      assert.equal(await page.inputValue('#cfgDevCommand'), 'pnpm dev --port {port}',
        'what you typed is kept');

      await page.fill('#cfgDevCommand', '');
      await saveUntil('#cfgDevCommand', '');
      assert.equal(await page.inputValue('#cfgDevCommand'), '', 'the box goes back to empty');
      assert.match(await page.getAttribute('#cfgDevCommand', 'placeholder'), /--port \{port\}/,
        'and detection is back in charge');
    });

    await t.test('a worktree can be created from the page, and links to its dev server over https', async () => {
      await page.click('#toggleSettings'); // close settings, back to the table
      await page.fill('#newBranch', 'feature/from-the-browser');
      await page.uncheck('#newWithClaude');
      await page.click('#createWorktree');
      await page.waitForSelector('#createStatus.ok', { timeout: 20000 });

      const row = page.locator('#wtBody .row').first();
      await row.waitFor();
      assert.match(await row.textContent(), /feature\/from-the-browser/);

      // Regression: with the dev command on auto, the stored value is null, and
      // the status line used to read "running on port 5002 via `null`".
      const status = await page.textContent('#createStatus');
      assert.doesNotMatch(status, /null|undefined/, status);
      assert.match(status, /--port \{port\}|npm run dev/);

      const link = page.locator('a.port-link').first();
      const href = await link.getAttribute('href');
      assert.match(href, /^https:\/\//, 'an https project must get an https link');
      assert.match(href, /:\d+$/);

      await page.screenshot({ path: path.join(SHOTS, '5-worktree-created.png'), fullPage: true });
    });

    await t.test('it holds up at phone width', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(100);
      const overflow = await page.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 0, `the page must not scroll sideways (overflowed by ${overflow}px)`);
      await page.screenshot({ path: path.join(SHOTS, '6-mobile.png'), fullPage: true });
    });

    await t.test('nothing errored in the console across the whole run', () => {
      assert.deepEqual(consoleErrors, []);
    });
  } finally {
    await browser.close();
    server.close();
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(FAKE_HOME, { recursive: true, force: true });
  }
});
