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

function buildPowerShellScript({ worktreePath, port, portEnvVar, devCommand, dashboardPort, worktreeId, claudeArgs, withClaude }) {
  const wtPath = worktreePath.replace(/"/g, '""');

  // Dev-server-only mode: no Claude, no background job, no auto-commit callback.
  // The dev command runs in the foreground so closing the window (or Ctrl+C)
  // stops it and frees the port. The dashboard downgrades the record to "idle"
  // on its next restart, or you can hit "Mark idle" now.
  if (!withClaude) {
    return `
$ErrorActionPreference = 'Continue'
Set-Location -LiteralPath "${wtPath}"
$env:${portEnvVar} = "${port}"

Write-Host "== worktree-dashboard session (dev server only) ==" -ForegroundColor Cyan
Write-Host "Worktree: ${wtPath}"
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
Set-Location -LiteralPath "${worktreePath.replace(/"/g, '""')}"
$env:${portEnvVar} = "${port}"

Write-Host "== worktree-dashboard session ==" -ForegroundColor Cyan
Write-Host "Worktree: ${worktreePath.replace(/"/g, '""')}"
Write-Host "Dev server port: ${port} (env ${portEnvVar})"
Write-Host ""

$devJob = Start-Job -ScriptBlock {
  param($path, $envVarName, $port, $cmd)
  Set-Location -LiteralPath $path
  Set-Item -Path "Env:$envVarName" -Value $port
  Invoke-Expression $cmd
} -ArgumentList "${worktreePath.replace(/"/g, '""')}", "${portEnvVar}", "${port}", "${devCommand.replace(/"/g, '\\"')}"

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

async function launchSession({ worktreeId, worktreePath, port, portEnvVar, devCommand, dashboardPort, claudeArgs, withClaude = true }) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const scriptPath = path.join(SESSIONS_DIR, `${worktreeId}.ps1`);
  const script = buildPowerShellScript({ worktreePath, port, portEnvVar, devCommand, dashboardPort, worktreeId, claudeArgs, withClaude });
  fs.writeFileSync(scriptPath, script, 'utf8');

  const wt = process.platform === 'win32' ? await which('wt.exe') : null;

  let child;
  if (wt) {
    // Windows Terminal: open a new window/tab running the script
    child = spawn(wt, [
      'new-tab', '--title', `wt:${worktreeId}`,
      'powershell.exe', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', scriptPath
    ], { detached: true, stdio: 'ignore', windowsHide: false });
  } else if (process.platform === 'win32') {
    child = spawn('powershell.exe', ['-NoExit', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      detached: true, stdio: 'ignore', windowsHide: false
    });
  } else if (!withClaude) {
    // Non-Windows, dev-only: run the dev server in the foreground, no callback.
    child = spawn('bash', ['-lc', `cd "${worktreePath}" && ${portEnvVar}=${port} ${devCommand}`], {
      detached: true, stdio: 'ignore'
    });
  } else {
    // Non-Windows fallback: just run claude directly in a detached shell (no split-pane dev job UI, best-effort).
    child = spawn('bash', ['-lc', `cd "${worktreePath}" && ${portEnvVar}=${port} bash -lc '${devCommand} &' ; claude ${claudeArgs || ''}; curl -s -X POST http://127.0.0.1:${dashboardPort}/api/worktrees/${worktreeId}/session/exit`], {
      detached: true, stdio: 'ignore'
    });
  }
  child.unref();
  return { pid: child.pid, scriptPath };
}

module.exports = { launchSession };
