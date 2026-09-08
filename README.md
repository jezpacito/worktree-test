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
- **Works with apps in a subfolder.** If your `package.json`, `node_modules`
  and `.env.development` live in something like `src/renderer` rather than at
  the git root, set **App subfolder** in Settings to that relative path. The
  dev command runs there, the env file is copied there, and `node_modules` is
  junctioned there. Git operations (branch, commit, worktree add/remove) still
  happen at the worktree root, which is where they belong. Leave it blank for
  a plain single-package repo.
- **Skips the `npm install` tax.** Each new worktree's `node_modules` is a
  Windows *directory junction* (`mklink /J`) pointing at your main repo's
  already-installed `node_modules`. Junctions, unlike symlinks, don't require
  admin rights or Developer Mode on Windows. If a branch changes dependencies,
  use "Reinstall deps" on that one worktree to swap the junction for a real
  `npm install`.
- **Copies and patches `.env.development`** into the new worktree (into the
  app subfolder, if you set one), setting your port env var (e.g. `PORT`) to
  the port assigned to that worktree.
- **Port numbers are links.** Click a worktree's port in the table to open
  `http://localhost:<port>` in a new tab. The link is dimmed on a worktree the
  dashboard has not launched, but stays clickable -- that port belongs to that
  worktree either way.
- **Opens a terminal or VS Code at any worktree**, from the row's menu.
  **Open terminal** (Windows only -- Windows Terminal if installed, otherwise
  PowerShell) drops you into that worktree's app folder with the port env var
  already exported, so `npm run dev` just works. **Open in VS Code** opens the
  worktree root in your editor. Neither is tracked as a session: closing the
  terminal doesn't change the row's status.
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

## The interface

Settings are collapsed behind a button in the top bar, so the page opens on
what you actually came for: four counters (worktrees, how many were launched,
estimated cost, tokens), the create form, and the worktree table. Each row
carries its branch, a shortened path, a clickable port, a status pill, an
expandable cost cell, and one primary button — **Start** when idle, **Mark
idle** when running. Everything else (Open terminal, Open in VS Code, Push
and create PR, Commit now, Reinstall deps, Remove) lives in the row's ⋯ menu.

Expanding the cost cell breaks the spend into input, output, cache write and
cache read tokens, alongside the optimization tips.

**Status is a record, not a probe.** The dashboard stores what it last
launched; it never polls to check whether that terminal is still open or
whether the port is answering. Close a terminal yourself and the row keeps
saying "Dev server" until you hit **Mark idle** (or restart the dashboard,
which downgrades leftover running rows). The UI only offers actions this
machine can perform -- **Open terminal** is hidden off Windows, since that is
the only platform it is implemented for.

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
- **App subfolder** -- optional, relative to the project path. Set it to
  `src/renderer` for a layout like `root-project/src/renderer`, i.e. wherever
  the `package.json` with your `dev` script lives. Leave blank if that's the
  repo root. A hint under the form shows the full path it resolves to.
- **Dev command** -- e.g. `npm run dev`. Runs inside the app subfolder.
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
   **Run Claude in this session** ticked, and click **Create worktree**.
2. A terminal opens with your dev server running in the background and
   `claude` running in the foreground. Run your company skill / do your work
   as normal.
3. Exit the Claude session when you're done. The dashboard auto-commits
   locally and marks the worktree "Committed, not pushed".
4. When you're happy, open the row's **⋯** menu and click **Push and create
   PR** -- this is the only step that pushes anything or talks to GitHub.

Every other per-row action lives in that same **⋯** menu:

| Action | What it does |
| --- | --- |
| **Run Claude on start** | Untick before hitting **Start** to get the dev server on its own. |
| **Open terminal** | A shell in that worktree's app folder with the port env var already exported. Windows only -- the menu hides it elsewhere. |
| **Open in VS Code** | Opens the worktree root. Needs the `code` CLI on your PATH (in VS Code: *Shell Command: Install 'code' command in PATH*). |
| **Commit now** | Commits everything in that worktree. Never pushes. |
| **Reinstall deps** | Swaps the shared `node_modules` junction for a real `npm install` in that worktree. |
| **Remove worktree** | Deletes the folder. The branch and its commits are kept. |

**Start** and **Mark idle** stay outside the menu as the row's primary button.
**Mark idle** only resets the record and frees the port -- it does not stop a
process, so use it after you have closed the terminal yourself.

## Running the tests

```
npm test
```

Covers the pure logic only: worktree-list parsing, cost and pricing math,
optimization-tip rules, state reconciliation, app-subfolder path resolution,
the env-file copy and patch, and the generated launcher scripts. The parts
that actually spawn a terminal or a browser are not automated -- neither is
the front end, which has no DOM test harness.

## Where state lives

Everything the dashboard tracks (config, worktree list, port assignments,
generated launcher scripts) lives under `%USERPROFILE%\.worktree-dashboard\`
on Windows, `~/.worktree-dashboard/` elsewhere -- entirely outside your
project repo.

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
- Only one **App subfolder** is supported. A repo with several independently
  runnable packages needs one dashboard config per package, or a change to
  make `appDir` a per-worktree field.
- Worktrees created *before* you set **App subfolder** have their env file at
  the old location. The env file is only written on first adoption, so fix
  those by hand or remove and recreate the worktree.
- Nothing polls a running session. A row keeps its launched status until you
  hit **Mark idle** or restart the dashboard. Making this self-correcting
  would mean probing each port on every refresh -- a deliberate omission, not
  an oversight.
- Changing settings that the server reads at startup needs a restart. The
  page is served from disk on every request, so the form can show a field the
  running process does not yet understand.
