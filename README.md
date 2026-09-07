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
- **Or launches the dev server on its own**, no Claude. Untick "Run Claude in
  this session" (on the create form, or the per-row checkbox next to "Start").
  You get a terminal running just the dev server on that worktree's port;
  close it or Ctrl+C to stop it. No auto-commit in this mode -- use
  "Commit now" if you made changes.
- **Discovers worktrees it didn't create.** Worktrees made by hand
  (`git worktree add`) or in a previous dashboard run show up in the table
  marked `discovered`. Clicking "Start" adopts one: it allocates a port,
  patches the env file once (later starts leave your edits alone), links
  `node_modules`, and launches the session. Records left "running" from a
  previous dashboard process are reset to `idle` on restart; use "Mark idle"
  to reset one yourself after you've closed its terminal. A worktree whose
  folder has vanished is shown as `missing` and can be cleared with "Remove".
- **Auto-commits (never auto-pushes)** when you exit a Claude session, so
  work-in-progress is always saved locally. Pushing and opening a PR only
  happens when you click "Push & create PR" in the dashboard -- that's the
  explicit confirmation step.
- **Dashboard view** of every worktree: branch, path, port, status, an
  estimated dollar cost, and a best-effort token count -- per worktree and
  in total. The table has a branch filter and pages 10 at a time.
- **Estimated cost per worktree, with tips.** Click the cost cell to expand a
  per-session breakdown plus a few plain-language suggestions for keeping the
  session cheap but effective (cache reuse, output size, resumed-session
  count, spend threshold). Costs multiply the token counts from Claude CLI's
  local transcripts by a per-model price map ($/1M tokens) you can edit in
  Settings; an asterisk on a figure means an unknown model id was priced at
  the fallback rate. Treat the numbers as a rough signal, not a bill.

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
- **Cost alert threshold ($)** -- a worktree that has cost more than this
  gets a "split the task / clear context" tip. Defaults to `20`.
- **Model pricing (JSON)** -- `$` per 1M tokens per model
  (`input` / `output` / `cacheWrite` / `cacheRead`), plus a `default` row
  used for model ids not listed. Seeded from the public Claude price list.

Then, for each new task:
1. Type a branch name (and optionally a base ref, default `HEAD`), leave
   **Run Claude in this session** ticked, and click **Create worktree +
   launch session**.
2. A terminal opens with your dev server running in the background and
   `claude` running in the foreground. Run your company skill / do your work
   as normal.
3. Exit the Claude session when you're done. The dashboard auto-commits
   locally and marks the worktree "committed, pending push".
4. When you're happy, click **Push & create PR** in the dashboard -- this is
   the only step that pushes anything or talks to GitHub.

To start an existing worktree without Claude (just the dev server), find its
row in the table, untick the per-row **Claude** checkbox, and click **Start**.

## Running the tests

```
npm test
```

Covers the pure logic only (worktree-list parsing, cost/pricing math,
optimization-tip rules, state reconciliation). The terminal-spawning paths
aren't automated.

## Where state lives

Everything the dashboard tracks (config, worktree list, port assignments,
generated launcher scripts) lives under `%USERPROFILE%\.worktree-dashboard\`,
entirely outside your project repo.

## Usage & cost monitoring caveat

Token-usage numbers are read from Claude CLI's local session transcripts
under `~/.claude/projects/**/*.jsonl`. This is genuinely best-effort: the
transcript schema isn't a stable public API, so if your Claude CLI version
stores things differently you may just see `--`. Dollar costs are those token
counts multiplied by the editable price map in Settings -- an estimate, and
flagged with `*` when a model id had to be priced at the fallback rate. Treat
both as a rough signal, not a billing source of truth.

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
