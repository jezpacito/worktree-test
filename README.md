# Worktree Dashboard

A small local web app for managing multiple Git worktrees, each with its own
Claude CLI session and its own dev-server port, without touching your
project's own config files and without needing admin rights on Windows.

## What it does

- **Point it at your project once.** It never modifies your project's
  `package.json`, `.eslintrc`, etc. The one thing it does write into your
  repo is what `git worktree add` itself writes (`<repo>/.git/worktrees/*`) --
  that's inherent to how git worktrees work, not something this tool adds.
- **Creates a worktree per task/branch**, in a sibling `.worktrees/` folder
  next to your repo (configurable).
- **Skips the `npm install` tax.** Each new worktree's `node_modules` is a
  Windows *directory junction* (`mklink /J`) pointing at your main repo's
  already-installed `node_modules`. Junctions, unlike symlinks, don't require
  admin rights or Developer Mode on Windows. If a branch changes dependencies,
  use "Reinstall deps" on that one worktree to swap the junction for a real
  `npm install`.
- **Copies and patches `.env.development`** into the new worktree, setting
  your port env var (e.g. `PORT`) to the port assigned to that worktree.
- **Allocates ports starting at 5002**, incrementing for each new worktree,
  and reclaims a port once you remove that worktree.
- **Launches a real terminal per worktree** (Windows Terminal if installed,
  otherwise a plain PowerShell window) that starts your dev server in the
  background and runs `claude` in the foreground. The dev server -- and the
  port -- stay up for as long as that terminal is open, regardless of what
  you type inside the Claude session. Only exiting the Claude CLI session
  (Ctrl+D / `exit`) stops the dev server and frees the port.
- **Auto-commits (never auto-pushes)** when you exit the Claude session, so
  work-in-progress is always saved locally. Pushing and opening a PR only
  happens when you click "Push & create PR" in the dashboard -- that's the
  explicit confirmation step.
- **Dashboard view** of every active worktree: branch, port, status
  (created / session running / committed, pending push / PR created), and a
  best-effort token-usage count per worktree and in total.

## Requirements

- Node.js (no admin rights needed to run it once installed; if Node itself
  isn't installed and you can't install it system-wide, use a portable Node
  build or `nvm-windows` in "no admin" mode, or ask IT for the base Node MSI --
  that's outside what this app can do for you).
- `git` on PATH.
- `claude` (Claude CLI) on PATH, already logged in with your company skills
  available.
- `gh` (GitHub CLI) on PATH, already run through `gh auth login` -- used only
  for the push+PR step, and only when you click the button.
- Windows Terminal (`wt.exe`) is optional but recommended for a nicer
  split-pane view; the app falls back to a plain PowerShell window if it's
  not installed.

None of the above need admin rights to install for your own user account.

## Setup

```
cd worktree-dashboard
npm install
npm start
```

This starts the dashboard at `http://localhost:4999`. Open that in your
browser (or a VS Code Simple Browser tab).

In **Settings**, fill in:
- **Project path** -- the root of your main repo checkout (where `.git` lives).
- **Dev command** -- e.g. `npm run dev`.
- **Port env var** -- whatever your dev server reads for its port, e.g. `PORT`,
  `VITE_PORT`, `NEXT_PUBLIC_PORT`.
- **Env file name** -- e.g. `.env.development`.
- **Start port** -- defaults to `5002`.

Then, for each new task:
1. Type a branch name (and optionally a base ref, default `HEAD`) and click
   **Create worktree + launch Claude session**.
2. A terminal opens with your dev server running in the background and
   `claude` running in the foreground. Run your company skill / do your work
   as normal.
3. Exit the Claude session when you're done. The dashboard auto-commits
   locally and marks the worktree "committed, pending push".
4. When you're happy, click **Push & create PR** in the dashboard -- this is
   the only step that pushes anything or talks to GitHub.

## Where state lives

Everything the dashboard tracks (config, worktree list, port assignments,
generated launcher scripts) lives under `%USERPROFILE%\.worktree-dashboard\`,
entirely outside your project repo.

## Usage monitoring caveat

Token-usage numbers are read from Claude CLI's local session transcripts
under `~/.claude/projects/**/*.jsonl`. This is genuinely best-effort: the
transcript schema isn't a stable public API, so if your Claude CLI version
stores things differently you may just see `--`. Treat it as a rough signal,
not a billing source of truth.

## Known tradeoffs / things to adjust for your setup

- The `node_modules` junction assumes all worktrees can share one install.
  If your company's skills or lint tooling write into `node_modules` per
  branch, use "Reinstall deps" for that worktree instead of relying on the
  junction.
- Push/PR uses `gh pr create` with your existing `gh auth login` session --
  if your company uses SSO tokens with a shorter lifetime, you may need to
  re-auth `gh` occasionally outside this tool.
- If your dev command needs more than one env var patched (not just the
  port), extend `copyAndPatchEnvFile` in `src/worktrees.js`.
