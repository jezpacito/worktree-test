// detect.js
// Works out how a project's dev server wants to be told which port to use, so
// the user does not have to know. Two things vary between frameworks and there
// is no way to guess them from the outside:
//
//   * WHERE the port goes. Next.js, react-scripts, Nuxt and a plain node server
//     read a PORT env var. Vite, Angular and webpack-dev-server ignore it
//     entirely and only take a --port flag -- point a worktree at PORT=5003 and
//     Vite cheerfully starts on 5173 anyway, so two worktrees collide.
//   * WHETHER the dev server speaks TLS, which decides how the dashboard links
//     to it. Nothing here turns TLS on; it only reads what the project already
//     does.
//
// Everything is best-effort and non-fatal: an unreadable project just falls
// back to the conventional PORT env var, which is what the dashboard used to
// assume unconditionally.

const fs = require('fs');
const path = require('path');

// Packages that only accept the port as a CLI flag, mapped to the flag they use.
// Anything not listed is assumed to read a PORT env var.
const FLAG_PORT_PACKAGES = [
  { pkg: 'vite', flag: '--port' },
  { pkg: '@sveltejs/kit', flag: '--port' },
  { pkg: '@angular/cli', flag: '--port' },
  { pkg: 'webpack-dev-server', flag: '--port' },
  { pkg: 'astro', flag: '--port' },
  { pkg: '@11ty/eleventy', flag: '--port' },
  { pkg: 'parcel', flag: '--port' }
];

// Packages that signal TLS in the dev server just by being installed.
const HTTPS_PACKAGES = ['@vitejs/plugin-basic-ssl', 'vite-plugin-mkcert'];

const SCRIPT_PREFERENCE = ['dev', 'start', 'serve', 'develop'];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function allDeps(pkg) {
  return { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
}

// The script most likely to be "run the dev server". Falls back to anything
// whose name looks like one, so `dev-mt` / `dev:web` are still found.
function pickDevScript(scripts) {
  const names = Object.keys(scripts || {});
  for (const preferred of SCRIPT_PREFERENCE) {
    if (names.includes(preferred)) return preferred;
  }
  return names.find((n) => /^(dev|start|serve)\b|[:-](dev|serve)$/i.test(n)) || null;
}

// A project that already names its port in an env file has told us what the
// variable is called -- VITE_PORT, APP_PORT, SERVER_PORT and so on. Prefer that
// over the conventional PORT, since it is the one the code actually reads.
function portVarFromEnvFile(text) {
  const lines = text.split(/\r?\n/);
  const matches = lines
    .map((l) => l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/))
    .filter(Boolean)
    .map((m) => m[1])
    .filter((name) => /PORT$/.test(name));
  if (!matches.length) return null;
  // An exact PORT wins; otherwise the first prefixed one.
  return matches.includes('PORT') ? 'PORT' : matches[0];
}

function detectHttps({ deps, devScriptBody, envText, appPath }) {
  const reasons = [];
  for (const pkg of HTTPS_PACKAGES) {
    if (deps[pkg]) reasons.push(`${pkg} is installed`);
  }
  if (/--(experimental-)?https\b/.test(devScriptBody)) reasons.push('the dev script passes --https');
  if (/^\s*(?:[A-Za-z_][A-Za-z0-9_]*_)?HTTPS\s*=\s*(true|1)\s*$/im.test(envText)) {
    reasons.push('HTTPS=true is set in the env file');
  }
  for (const name of ['vite.config.js', 'vite.config.ts', 'vite.config.mjs']) {
    const body = readText(path.join(appPath, name));
    if (/server\s*:\s*\{[^}]*\bhttps\b/s.test(body)) {
      reasons.push(`${name} enables server.https`);
      break;
    }
  }
  return { https: reasons.length > 0, reasons };
}

// Put {port} in the dev command where this framework wants it. The dashboard
// substitutes the worktree's port there at launch. `npm run x` needs the `--`
// separator so the flag reaches the script rather than npm itself.
function withPortFlag(command, flag) {
  if (/\{port\}/.test(command)) return command;
  const separator = /^(npm|pnpm) run\b/.test(command) ? ' -- ' : ' ';
  return `${command}${separator}${flag} {port}`;
}

// Returns what the dashboard should use for a project, plus a plain-language
// note per decision so the UI can show its reasoning rather than a silent guess.
function detectProject({ repoPath, appPath, envFileName = '.env.development' }) {
  const result = {
    devCommand: null,
    portEnvVar: 'PORT',
    devServerScheme: 'http',
    framework: null,
    notes: []
  };
  if (!repoPath || !appPath) return result;

  const pkg = readJson(path.join(appPath, 'package.json'));
  if (!pkg) {
    result.notes.push('No readable package.json, so the usual PORT env var is assumed.');
    return result;
  }

  const deps = allDeps(pkg);
  const scripts = pkg.scripts || {};
  const scriptName = pickDevScript(scripts);
  const devScriptBody = scriptName ? String(scripts[scriptName]) : '';

  if (scriptName) {
    result.devCommand = `npm run ${scriptName}`;
    result.notes.push(`Found the "${scriptName}" script in package.json.`);
  } else {
    result.notes.push('No dev-looking script in package.json; set the dev command yourself.');
  }

  const flagged = FLAG_PORT_PACKAGES.find(({ pkg: name }) => deps[name])
    || (/\bvite\b/.test(devScriptBody) ? { pkg: 'vite', flag: '--port' } : null);

  if (flagged) {
    result.framework = flagged.pkg;
    if (result.devCommand) {
      result.devCommand = withPortFlag(result.devCommand, flagged.flag);
      result.notes.push(
        `${flagged.pkg} ignores a PORT env var, so the command passes ${flagged.flag} {port} instead -- `
        + `that is how each worktree gets its own port.`
      );
    }
  } else {
    result.notes.push('This dev server reads its port from an env var.');
  }

  const envText = readText(path.join(appPath, envFileName));
  const fromEnv = portVarFromEnvFile(envText);
  if (fromEnv) {
    result.portEnvVar = fromEnv;
    result.notes.push(`${envFileName} already names the port as ${fromEnv}, so that is the variable used.`);
  }

  const { https, reasons } = detectHttps({ deps, devScriptBody, envText, appPath });
  if (https) {
    result.devServerScheme = 'https';
    result.notes.push(`Dev server looks like it serves https (${reasons.join('; ')}).`);
  }

  return result;
}

module.exports = { detectProject, pickDevScript, portVarFromEnvFile, withPortFlag, detectHttps };
