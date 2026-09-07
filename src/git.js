// git.js
// Commit-on-exit (never pushes on its own), and push+PR only after the user
// explicitly confirms in the dashboard UI.

const { run } = require('./worktrees');

async function commitAll({ worktreePath, message }) {
  await run('git', ['add', '-A'], worktreePath);
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

async function pushAndCreatePr({ worktreePath, branch, baseRef, title, body }) {
  await run('git', ['push', '-u', 'origin', branch], worktreePath);

  const args = [
    'pr', 'create',
    '--head', branch,
    '--title', title || `Changes from ${branch}`,
    '--body', body || `Automated PR for worktree branch \`${branch}\`.`
  ];
  if (baseRef) args.push('--base', baseRef);

  const { stdout } = await run('gh', args, worktreePath);
  // gh pr create prints the PR URL as the last line of stdout
  const url = stdout.trim().split('\n').pop();
  return { url };
}

module.exports = { commitAll, pushAndCreatePr };
