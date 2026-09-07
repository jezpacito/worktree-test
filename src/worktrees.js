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

async function linkNodeModules({ repoPath, worktreePath }) {
  const src = path.join(repoPath, 'node_modules');
  const dest = path.join(worktreePath, 'node_modules');

  if (!fs.existsSync(src)) {
    return { linked: false, reason: 'Main repo has no node_modules yet -- run npm install there first.' };
  }
  if (fs.existsSync(dest)) {
    return { linked: false, reason: 'node_modules already exists in the worktree.' };
  }

  if (process.platform === 'win32') {
    // /J junction: works without admin rights or Developer Mode, unlike mklink /D symlinks.
    await run('cmd.exe', ['/c', 'mklink', '/J', dest, src], worktreePath);
  } else {
    // symlinks are unrestricted on macOS/Linux
    fs.symlinkSync(src, dest, 'dir');
  }
  return { linked: true };
}

async function reinstallDeps({ worktreePath }) {
  const dest = path.join(worktreePath, 'node_modules');
  if (fs.existsSync(dest)) {
    // remove the junction/symlink (or folder) first
    fs.rmSync(dest, { recursive: true, force: true });
  }
  await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install'], worktreePath);
}

function copyAndPatchEnvFile({ repoPath, worktreePath, envFileName, portEnvVar, port }) {
  const src = path.join(repoPath, envFileName);
  const dest = path.join(worktreePath, envFileName);

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

module.exports = {
  createWorktree,
  linkNodeModules,
  reinstallDeps,
  copyAndPatchEnvFile,
  removeWorktree,
  hasChanges,
  run
};
