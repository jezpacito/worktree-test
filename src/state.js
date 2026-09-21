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
const { DEFAULT_PRICING } = require('./usage');

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
    appDir: '',              // repo-root-relative folder the app lives in (e.g. 'src/renderer');
                             // blank means the app is at the repo root. The dev command,
                             // the env file and node_modules all resolve inside it.
    devCommand: 'npm run dev', // command used to start the dev server
    devServerScheme: 'http', // 'https' for a project whose dev server serves TLS;
                             // only decides how the dashboard links to it
    portEnvVar: 'PORT',      // env var name the dev command reads for its port
    envFileName: '.env.development',
    startPort: 5002,
    worktreesRoot: null,     // where sibling worktree folders get created; default: sibling of repoPath
    dashboardPort: 4999,
    pricing: DEFAULT_PRICING, // $/1M tokens per model, editable in Settings; used for cost estimates
    costThreshold: 20         // $ per worktree above which an optimization tip fires
  },
  worktrees: {},   // id -> worktree record
  nextPort: 5002,  // rolling hint only; allocation rescans from startPort
  reservations: {} // port -> expiry ms, for ports handed out but not yet recorded
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
    // Never silently destroy the only record of every worktree, port and
    // Claude session id. Keep the unreadable file so it can be hand-repaired.
    const backup = `${STATE_FILE}.corrupt-${Date.now()}`;
    try {
      fs.copyFileSync(STATE_FILE, backup);
      console.error(`State file corrupt, resetting. Previous contents kept at ${backup}:`, e.message);
    } catch {
      console.error('State file corrupt and could not be backed up, resetting:', e.message);
    }
    save(DEFAULT_STATE);
    return structuredClone(DEFAULT_STATE);
  }
}

// Written to a temp file and renamed, because rename is atomic: a crash (or a
// full disk) mid-save leaves the previous state.json intact rather than a
// half-written one that load() would have to throw away.
function save(state) {
  ensureDirs();
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_FILE);
}

// Read-modify-write as one step. A handler that loaded state, awaited something
// slow (spawning a terminal, running git) and then saved the object it loaded
// would clobber anything written in the meantime. Re-reading inside the mutation
// means only the fields `fn` actually touches are updated.
function mutate(fn) {
  const s = load();
  const result = fn(s);
  save(s);
  return result === undefined ? s : result;
}

module.exports = { load, save, mutate, APP_DIR, SESSIONS_DIR, STATE_FILE };
