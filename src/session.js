// session.js
// Spawns a real terminal window per worktree that:
//   1. starts the dev server as a background job on the assigned port
//   2. runs `claude` in the foreground (interactive -- you type in it normally)
//   3. when you exit claude (Ctrl+D / `exit`), stops the dev server job and
//      calls back into this dashboard so it can auto-commit (never push)
//
// The port is only ever freed when step 3 fires, i.e. when you exit the
// Claude session -- typing other commands inside the same claude session
// never touches the dev server.
//
// Windows Terminal (wt.exe) is used when available for a nicer split-pane
// view (dev server output on the left, Claude on the right); otherwise this
// falls back to a plain PowerShell window running the same script.

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { SESSIONS_DIR } = require('./state');

function which(cmd) {
  return new Promise((resolve) => {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    execFile(finder, [cmd], (err, stdout) => {
      resolve(err ? null : stdout.split(/\r?\n/)[0].trim());
    });
  });
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// Build the argument string for the `claude` invocation. The dashboard assigns
// each worktree a session id up front rather than scraping one out of the
// transcripts afterwards: the first launch names the session with --session-id,
// and every later launch reopens it with --resume. Which of the two applies is
// decided by whether the transcript is actually on disk, because a session the
// user opened and closed without saying anything never gets written, and
// resuming it would fail.
function claudeArgsFor({ claudeSessionId, hasTranscript, extra } = {}) {
  const tail = (extra || '').trim();
  if (!claudeSessionId) return tail;
  if (!UUID_RE.test(claudeSessionId)) {
    throw new Error(`Claude session id must be a UUID, got: ${claudeSessionId}`);
  }
  const flag = hasTranscript ? '--resume' : '--session-id';
  return `${flag} ${claudeSessionId}${tail ? ' ' + tail : ''}`;
}

function q(p) {
  return String(p).replace(/"/g, '""');
}

function buildPowerShellScript({ worktreePath, appPath, port, portEnvVar, devCommand, dashboardPort, worktreeId, claudeArgs, withClaude }) {
  const wtPath = q(worktreePath);
  const appDirPath = q(appPath || worktreePath);

  // Dev-server-only mode: no Claude, no background job, no auto-commit callback.
  // The dev command runs in the foreground so closing the window (or Ctrl+C)
  // stops it and frees the port. The dashboard downgrades the record to "idle"
  // on its next restart, or you can hit "Mark idle" now.
  if (!withClaude) {
    return `
$ErrorActionPreference = 'Continue'
Set-Location -LiteralPath "${appDirPath}"
$env:${portEnvVar} = "${port}"

Write-Host "== worktree-dashboard session (dev server only) ==" -ForegroundColor Cyan
Write-Host "Worktree: ${wtPath}"
Write-Host "Dev server runs in: ${appDirPath}"
Write-Host "Dev server port: ${port} (env ${portEnvVar})"
Write-Host "No Claude session. Close this window or press Ctrl+C to stop the dev server and free the port." -ForegroundColor Cyan
Write-Host ""

${devCommand}
`;
  }

  // Every ${...} PowerShell variable below is escaped with a backtick where
  // it must NOT be interpolated by the JS template literal.
  return `
$ErrorActionPreference = 'Continue'
Set-Location -LiteralPath "${wtPath}"
$env:${portEnvVar} = "${port}"

Write-Host "== worktree-dashboard session ==" -ForegroundColor Cyan
Write-Host "Worktree: ${wtPath}"
Write-Host "Dev server runs in: ${appDirPath}"
Write-Host "Dev server port: ${port} (env ${portEnvVar})"
Write-Host ""

$devJob = Start-Job -ScriptBlock {
  param($path, $envVarName, $port, $cmd)
  Set-Location -LiteralPath $path
  Set-Item -Path "Env:$envVarName" -Value $port
  Invoke-Expression $cmd
} -ArgumentList "${appDirPath}", "${portEnvVar}", "${port}", "${devCommand.replace(/"/g, '\\"')}"

Write-Host "Dev server starting in background (job id $($devJob.Id))..." -ForegroundColor DarkGray
Write-Host "Starting Claude CLI session below. Exit it (Ctrl+D or 'exit') to stop the dev server and auto-commit." -ForegroundColor Cyan
Write-Host ""

claude ${claudeArgs || ''}

Write-Host ""
Write-Host "Claude session ended. Stopping dev server..." -ForegroundColor DarkGray
Stop-Job $devJob -ErrorAction SilentlyContinue | Out-Null
Receive-Job $devJob -ErrorAction SilentlyContinue | Out-Null
Remove-Job $devJob -ErrorAction SilentlyContinue | Out-Null

try {
  Invoke-RestMethod -Uri "http://127.0.0.1:${dashboardPort}/api/worktrees/${worktreeId}/session/exit" -Method POST -TimeoutSec 5 | Out-Null
  Write-Host "Dashboard notified: committing changes (not pushing)." -ForegroundColor Green
} catch {
  Write-Host "Could not reach dashboard to auto-commit. Open the dashboard and use 'Commit now' manually." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Port ${port} is now free. You can close this window." -ForegroundColor Cyan
`;
}

// A plain shell at the worktree's app folder. No dev server is started for you
// and nothing calls back into the dashboard -- this is just a terminal with the
// right cwd and the right port already exported, so `npm run dev` works.
function buildTerminalScript({ worktreePath, appPath, port, portEnvVar, devCommand }) {
  const wtPath = q(worktreePath);
  const appDirPath = q(appPath || worktreePath);
  const portLine = port == null
    ? `Write-Host "No port assigned to this worktree yet." -ForegroundColor Yellow`
    : `$env:${portEnvVar} = "${port}"\nWrite-Host "${portEnvVar} is set to ${port} for this shell."`;

  return `
$ErrorActionPreference = 'Continue'
Set-Location -LiteralPath "${appDirPath}"
${portLine}

Write-Host "== worktree-dashboard terminal ==" -ForegroundColor Cyan
Write-Host "Worktree root: ${wtPath}"
Write-Host "You are in:    ${appDirPath}"
Write-Host ""
Write-Host "Run the dev server with:  ${devCommand || 'npm run dev'}" -ForegroundColor DarkGray
Write-Host "The dashboard is not tracking this shell -- closing it won't change the worktree's status." -ForegroundColor DarkGray
Write-Host ""
`;
}

// Windows Terminal when it's installed (nicer tabs), plain PowerShell otherwise.
// Both keep the window open after the script finishes (-NoExit).
async function spawnWindow(scriptPath, title) {
  const psArgs = ['-NoExit', '-ExecutionPolicy', 'Bypass', '-File', scriptPath];
  const wtExe = await which('wt.exe');
  if (wtExe) {
    return spawn(wtExe, ['new-tab', '--title', title, 'powershell.exe', ...psArgs],
      { detached: true, stdio: 'ignore', windowsHide: false });
  }
  return spawn('powershell.exe', psArgs, { detached: true, stdio: 'ignore', windowsHide: false });
}

async function openTerminal({ worktreeId, worktreePath, appPath, port, portEnvVar, devCommand }) {
  if (process.platform !== 'win32') {
    throw new Error('Opening a terminal is only wired up for Windows (Windows Terminal / PowerShell).');
  }
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const scriptPath = path.join(SESSIONS_DIR, `${worktreeId}-terminal.ps1`);
  fs.writeFileSync(scriptPath, buildTerminalScript({ worktreePath, appPath, port, portEnvVar, devCommand }), 'utf8');

  const child = await spawnWindow(scriptPath, `term:${worktreeId}`);
  child.unref();
  return { pid: child.pid, scriptPath, cwd: appPath || worktreePath };
}

// Open the worktree ROOT in VS Code -- you want the whole branch checkout in the
// editor, not just the app subfolder.
async function openInVsCode({ worktreePath }) {
  const candidates = process.platform === 'win32' ? ['code.cmd', 'code'] : ['code'];
  let bin = null;
  for (const c of candidates) {
    bin = await which(c);
    if (bin) break;
  }
  if (!bin) {
    throw new Error("VS Code CLI not found on PATH. In VS Code, run \"Shell Command: Install 'code' command in PATH\" from the command palette, then try again.");
  }
  // `code` is a .cmd shim on Windows, which Node won't spawn directly. Go via
  // cmd.exe /c rather than shell:true, so a path with spaces is still quoted.
  const child = process.platform === 'win32'
    ? spawn('cmd.exe', ['/c', bin, worktreePath], { detached: true, stdio: 'ignore', windowsHide: true })
    : spawn(bin, [worktreePath], { detached: true, stdio: 'ignore' });
  child.unref();
  return { pid: child.pid, path: worktreePath };
}

async function launchSession({ worktreeId, worktreePath, appPath, port, portEnvVar, devCommand, dashboardPort, claudeArgs, withClaude = true }) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const scriptPath = path.join(SESSIONS_DIR, `${worktreeId}.ps1`);
  const script = buildPowerShellScript({ worktreePath, appPath, port, portEnvVar, devCommand, dashboardPort, worktreeId, claudeArgs, withClaude });
  fs.writeFileSync(scriptPath, script, 'utf8');

  let child;
  if (process.platform === 'win32') {
    child = await spawnWindow(scriptPath, `wt:${worktreeId}`);
  } else if (!withClaude) {
    // Non-Windows, dev-only: run the dev server in the foreground, no callback.
    child = spawn('bash', ['-lc', `cd "${appPath || worktreePath}" && ${portEnvVar}=${port} ${devCommand}`], {
      detached: true, stdio: 'ignore'
    });
  } else {
    // Non-Windows fallback: just run claude directly in a detached shell (no split-pane dev job UI, best-effort).
    child = spawn('bash', ['-lc', `cd "${worktreePath}" && (cd "${appPath || worktreePath}" && ${portEnvVar}=${port} ${devCommand} &) ; claude ${claudeArgs || ''}; curl -s -X POST http://127.0.0.1:${dashboardPort}/api/worktrees/${worktreeId}/session/exit`], {
      detached: true, stdio: 'ignore'
    });
  }
  child.unref();
  return { pid: child.pid, scriptPath };
}

module.exports = { launchSession, openTerminal, openInVsCode, claudeArgsFor, buildPowerShellScript, buildTerminalScript };
