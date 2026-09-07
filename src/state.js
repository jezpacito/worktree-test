// state.js
// Everything the dashboard remembers lives OUTSIDE the target project repo,
// under the user's home directory. Nothing here ever touches the project's
// own config files (package.json, .eslintrc, etc). Git worktree metadata is
// the one exception -- git itself writes to <repo>/.git/worktrees/* whenever
// you run `git worktree add`, which is inherent to how git worktrees work,
// not something this tool does on top of git.

const fs = require('fs');
const path = require('path');
const os = require('os');

const APP_DIR = path.join(os.homedir(), '.worktree-dashboard');
const SESSIONS_DIR = path.join(APP_DIR, 'launchers');
const STATE_FILE = path.join(APP_DIR, 'state.json');

function ensureDirs() {
  fs.mkdirSync(APP_DIR, { recursive: true });
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

const DEFAULT_STATE = {
  // config describes the ONE project this dashboard instance is pointed at.
  // Run `wtd init` again (or use the UI) to point it at a different project.
  config: {
    repoPath: null,          // absolute path to the main checkout (git root)
    devCommand: 'npm run dev', // command used to start the dev server
    portEnvVar: 'PORT',      // env var name the dev command reads for its port
    envFileName: '.env.development',
    startPort: 5002,
    worktreesRoot: null,     // where sibling worktree folders get created; default: sibling of repoPath
    dashboardPort: 4999
  },
  worktrees: {},   // id -> worktree record
  nextPort: 5002
};

function load() {
  ensureDirs();
  if (!fs.existsSync(STATE_FILE)) {
    save(DEFAULT_STATE);
    return structuredClone(DEFAULT_STATE);
  }
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return { ...structuredClone(DEFAULT_STATE), ...raw, config: { ...DEFAULT_STATE.config, ...(raw.config || {}) } };
  } catch (e) {
    console.error('State file corrupt, resetting:', e.message);
    save(DEFAULT_STATE);
    return structuredClone(DEFAULT_STATE);
  }
}

function save(state) {
  ensureDirs();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

module.exports = { load, save, APP_DIR, SESSIONS_DIR, STATE_FILE };
