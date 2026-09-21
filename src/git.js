// git.js
// Commit-on-exit (never pushes on its own), and push+PR only after the user
// explicitly confirms in the dashboard UI.

const { run } = require('./worktrees');

// `excludePaths` keeps a file out of the auto-commit without touching the
// user's .gitignore. The caller uses it for an env file that the project does
// not ignore: this tool copies that file into the worktree and rewrites its
// port, so sweeping it into a commit would put a per-worktree port -- and
// whatever secrets the original held -- into a branch that later gets pushed.
async function commitAll({ worktreePath, message, excludePaths = [] }) {
  const addArgs = ['add', '-A', '--', '.', ...excludePaths.map((p) => `:(exclude)${p}`)];
  await run('git', addArgs, worktreePath);
  try {
    await run('git', ['commit', '-m', message], worktreePath);
    return { committed: true };
  } catch (e) {
    // Most common cause: nothing to commit. Surface that distinctly.
    if (/nothing to commit/i.test(e.stdout || e.message || '')) {
      return { committed: false, reason: 'nothing to commit' };
    }
    throw e;
  }
}

// Two steps that fail independently. If the push lands and `gh` then fails
// (not installed, not authenticated, PR already open), the caller must be able
// to tell -- the commits ARE on the remote at that point, and reporting the
// whole thing as a failure would be wrong.
async function pushAndCreatePr({ worktreePath, branch, baseRef, title, body }) {
  await run('git', ['push', '-u', 'origin', branch], worktreePath);

  const args = [
    'pr', 'create',
    '--head', branch,
    '--title', title || `Changes from ${branch}`,
    '--body', body || `Automated PR for worktree branch \`${branch}\`.`
  ];
  if (baseRef) args.push('--base', baseRef);

  let stdout;
  try {
    ({ stdout } = await run('gh', args, worktreePath));
  } catch (e) {
    e.pushed = true;
    throw e;
  }
  // Pick the PR URL out by shape rather than taking the last line: gh prints
  // warnings and upgrade notices after it, which would otherwise become the url.
  const match = (stdout || '').match(/https?:\/\/\S+\/pull\/\d+/);
  return { url: match ? match[0] : (stdout || '').trim().split('\n').pop(), pushed: true };
}

module.exports = { commitAll, pushAndCreatePr };
