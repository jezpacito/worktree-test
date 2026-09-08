// worktrees.js
// Creates/removes git worktrees, wires up a node_modules junction (no admin
// rights needed on Windows for /J junctions, unlike symlinks), and copies +
// patches the .env.development file for the new worktree's port.
//
// IMPORTANT tradeoff, documented for the user: the node_modules junction
// points at the MAIN repo's node_modules. If a branch changes dependencies,
// that worktree needs its own real `npm install` (use the "Reinstall deps"
// action in the UI, which replaces the junction with a real install for
// just that worktree).

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const util = require('util');
const execFileP = util.promisify(execFile);

function run(cmd, args, cwd) {
  return execFileP(cmd, args, { cwd, windowsHide: true, maxBuffer: 1024 * 1024 * 32 });
}

// Resolve the folder the app actually lives in inside a checkout. `appDir` is
// a repo-root-relative path (e.g. "src/renderer") for projects whose
// package.json / .env.development / node_modules sit in a subfolder rather
// than at the git root. Blank means "the checkout root itself".
function resolveAppPath(rootPath, appDir) {
  const root = path.resolve(rootPath);
  const rel = (appDir || '').trim();
  if (!rel) return root;
  if (path.isAbsolute(rel)) {
    throw new Error(`App subfolder must be relative to the repo root, got: ${rel}`);
  }
  const resolved = path.resolve(root, rel);
  const inside = resolved === root || resolved.startsWith(root + path.sep);
  if (!inside) {
    throw new Error(`App subfolder resolves outside the checkout: ${rel}`);
  }
  return resolved;
}

function sanitizeBranchForDir(branch) {
  return branch.replace(/[\\/:*?"<>|]/g, '-');
}

async function createWorktree({ repoPath, worktreesRoot, branch, baseRef }) {
  const dirName = `wt-${sanitizeBranchForDir(branch)}`;
  const worktreePath = path.join(worktreesRoot, dirName);

  if (fs.existsSync(worktreePath)) {
    throw new Error(`Target worktree folder already exists: ${worktreePath}`);
  }

  // Does the branch already exist locally?
  let branchExists = false;
  try {
    await run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], repoPath);
    branchExists = true;
  } catch {
    branchExists = false;
  }

  const args = branchExists
    ? ['worktree', 'add', worktreePath, branch]
    : ['worktree', 'add', '-b', branch, worktreePath, baseRef || 'HEAD'];

  await run('git', args, repoPath);

  return worktreePath;
}

async function linkOneNodeModules(src, dest) {
  if (!fs.existsSync(src)) {
    return { linked: false, reason: `No node_modules at ${src} -- run npm install there first.` };
  }
  if (fs.existsSync(dest)) {
    return { linked: false, reason: 'node_modules already exists in the worktree.' };
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  if (process.platform === 'win32') {
    // /J junction: works without admin rights or Developer Mode, unlike mklink /D symlinks.
    await run('cmd.exe', ['/c', 'mklink', '/J', dest, src], path.dirname(dest));
  } else {
    // symlinks are unrestricted on macOS/Linux
    fs.symlinkSync(src, dest, 'dir');
  }
  return { linked: true };
}

// Junction node_modules from the main checkout into the worktree. A project may
// keep its dependencies at the repo root, inside the app subfolder, or both --
// each level that actually has a node_modules in the main repo gets linked.
async function linkNodeModules({ repoPath, worktreePath, appDir }) {
  const levels = [{ label: 'root', rel: '' }];
  if ((appDir || '').trim()) levels.push({ label: appDir, rel: appDir });

  const results = {};
  for (const level of levels) {
    const src = path.join(resolveAppPath(repoPath, level.rel), 'node_modules');
    const dest = path.join(resolveAppPath(worktreePath, level.rel), 'node_modules');
    results[level.label] = await linkOneNodeModules(src, dest);
  }

  return { linked: Object.values(results).some((r) => r.linked), levels: results };
}

async function reinstallDeps({ worktreePath, appDir }) {
  const appPath = resolveAppPath(worktreePath, appDir);
  const dest = path.join(appPath, 'node_modules');
  if (fs.existsSync(dest)) {
    // remove the junction/symlink (or folder) first
    fs.rmSync(dest, { recursive: true, force: true });
  }
  await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install'], appPath);
}

function copyAndPatchEnvFile({ repoPath, worktreePath, appDir, envFileName, portEnvVar, port }) {
  const src = path.join(resolveAppPath(repoPath, appDir), envFileName);
  const destDir = resolveAppPath(worktreePath, appDir);
  const dest = path.join(destDir, envFileName);

  let contents = '';
  if (fs.existsSync(src)) {
    contents = fs.readFileSync(src, 'utf8');
  }

  const lines = contents.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const re = new RegExp(`^${portEnvVar}\\s*=`);
  let found = false;
  const patched = lines.map((line) => {
    if (re.test(line)) {
      found = true;
      return `${portEnvVar}=${port}`;
    }
    return line;
  });
  if (!found) patched.push(`${portEnvVar}=${port}`);

  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(dest, patched.join('\n') + '\n', 'utf8');
  return { copiedFrom: fs.existsSync(src) ? src : null, dest };
}

async function removeWorktree({ repoPath, worktreePath }) {
  try {
    await run('git', ['worktree', 'remove', worktreePath, '--force'], repoPath);
  } catch (e) {
    // fall back to manual removal + prune if git refuses (e.g. dirty tree)
    fs.rmSync(worktreePath, { recursive: true, force: true });
    await run('git', ['worktree', 'prune'], repoPath).catch(() => {});
  }
}

async function hasChanges({ worktreePath }) {
  const { stdout } = await run('git', ['status', '--porcelain'], worktreePath);
  return stdout.trim().length > 0;
}

async function pruneWorktrees({ repoPath }) {
  await run('git', ['worktree', 'prune'], repoPath);
}

// Parse `git worktree list --porcelain` output into
// [{ path, branch, head, detached, bare }]. Pure function, unit-tested.
function parseWorktreePorcelain(text) {
  const out = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (cur) out.push(cur);
      cur = { path: line.slice('worktree '.length).trim(), branch: null, head: null, detached: false, bare: false };
    } else if (!cur) {
      continue;
    } else if (line.startsWith('HEAD ')) {
      cur.head = line.slice('HEAD '.length).trim();
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    } else if (line === 'detached') {
      cur.detached = true;
    } else if (line === 'bare') {
      cur.bare = true;
    }
  }
  if (cur) out.push(cur);
  return out.filter((w) => !w.bare);
}

async function listGitWorktrees({ repoPath }) {
  const { stdout } = await run('git', ['worktree', 'list', '--porcelain'], repoPath);
  return parseWorktreePorcelain(stdout);
}

module.exports = {
  resolveAppPath,
  createWorktree,
  linkNodeModules,
  reinstallDeps,
  copyAndPatchEnvFile,
  removeWorktree,
  pruneWorktrees,
  hasChanges,
  listGitWorktrees,
  parseWorktreePorcelain,
  run
};
