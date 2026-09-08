async function api(path, opts) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// ---- config --------------------------------------------------------------

async function loadConfig() {
  const cfg = await api('/api/config');
  document.getElementById('cfgRepoPath').value = cfg.repoPath || '';
  document.getElementById('cfgAppDir').value = cfg.appDir || '';
  document.getElementById('cfgDevCommand').value = cfg.devCommand || '';
  document.getElementById('cfgPortEnvVar').value = cfg.portEnvVar || '';
  document.getElementById('cfgEnvFile').value = cfg.envFileName || '';
  document.getElementById('cfgStartPort').value = cfg.startPort || '';
  document.getElementById('cfgWorktreesRoot').value = cfg.worktreesRoot || '';
  document.getElementById('cfgCostThreshold').value = cfg.costThreshold ?? '';
  document.getElementById('cfgPricing').value = JSON.stringify(cfg.pricing || {}, null, 2);
  renderAppDirHint();
}

// Echo where the dev command will actually run, so a wrong subfolder is
// obvious before any worktree gets created.
function renderAppDirHint() {
  const repo = document.getElementById('cfgRepoPath').value.trim();
  const appDir = document.getElementById('cfgAppDir').value.trim().replace(/^[\\/]+|[\\/]+$/g, '');
  const hint = document.getElementById('appDirHint');
  if (!repo) { hint.textContent = ''; return; }
  const sep = repo.includes('\\') ? '\\' : '/';
  const wtRoot = repo.split(/[\\/]/).slice(0, -1).join(sep) + sep + '.worktrees' + sep + 'wt-<branch>';
  const target = appDir ? wtRoot + sep + appDir.replace(/\//g, sep) : wtRoot;
  hint.textContent = `Dev command and env file will resolve to: ${target}`;
}

document.getElementById('cfgAppDir').addEventListener('input', renderAppDirHint);
document.getElementById('cfgRepoPath').addEventListener('input', renderAppDirHint);

document.getElementById('saveConfig').addEventListener('click', async () => {
  const status = document.getElementById('configStatus');
  status.textContent = 'Saving...';
  try {
    await api('/api/config', {
      method: 'POST',
      body: JSON.stringify({
        repoPath: document.getElementById('cfgRepoPath').value.trim(),
        appDir: document.getElementById('cfgAppDir').value.trim(),
        devCommand: document.getElementById('cfgDevCommand').value.trim(),
        portEnvVar: document.getElementById('cfgPortEnvVar').value.trim(),
        envFileName: document.getElementById('cfgEnvFile').value.trim(),
        startPort: document.getElementById('cfgStartPort').value.trim(),
        worktreesRoot: document.getElementById('cfgWorktreesRoot').value.trim(),
        costThreshold: document.getElementById('cfgCostThreshold').value.trim(),
        pricing: document.getElementById('cfgPricing').value.trim()
      })
    });
    status.textContent = 'Saved.';
    await loadConfig();
  } catch (e) {
    status.textContent = 'Error: ' + e.message;
  }
});

document.getElementById('createWorktree').addEventListener('click', async () => {
  const status = document.getElementById('createStatus');
  const branch = document.getElementById('newBranch').value.trim();
  const baseRef = document.getElementById('newBaseRef').value.trim();
  const withClaude = document.getElementById('newWithClaude').checked;
  if (!branch) { status.textContent = 'Branch name required.'; return; }
  status.textContent = withClaude ? 'Creating worktree and launching session...' : 'Creating worktree and starting dev server...';
  try {
    const w = await api('/api/worktrees', { method: 'POST', body: JSON.stringify({ branch, baseRef, withClaude }) });
    status.textContent = `Launched on port ${w.port}.`;
    document.getElementById('newBranch').value = '';
    await refresh();
  } catch (e) {
    status.textContent = 'Error: ' + e.message;
  }
});

// ---- worktree table ----------------------------------------------------

let allWorktrees = [];
let filterText = '';
let page = 0;
const PAGE_SIZE = 10;
const expanded = new Set();

const branchFilter = document.getElementById('branchFilter');
branchFilter.addEventListener('input', () => {
  filterText = branchFilter.value.trim().toLowerCase();
  page = 0;
  render();
});
document.getElementById('pagePrev').addEventListener('click', () => { if (page > 0) { page--; render(); } });
document.getElementById('pageNext').addEventListener('click', () => { page++; render(); });

function fmtTokens(n) {
  if (n == null) return '--';
  if (n > 1000000) return (n / 1000000).toFixed(2) + 'M';
  if (n > 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

function fmtUsd(n) {
  if (n == null || Number.isNaN(n)) return '--';
  if (n > 0 && n < 0.01) return '~<$0.01';
  return '~$' + n.toFixed(2);
}

const TIP = {
  start: "Opens a terminal running the dev server on this worktree's port (plus Claude if ticked).",
  claude: 'Also run the Claude CLI in that terminal, and auto-commit when you exit it.',
  terminal: 'Opens PowerShell in this worktree\'s app folder with the port env var already set -- for running the dev command yourself.',
  vscode: "Opens this worktree's root folder in VS Code.",
  markIdle: 'You closed the terminal yourself -- reset this row to idle and free the port.',
  push: 'Pushes this branch and opens a PR. Nothing is pushed without this.',
  commit: 'Commit everything in this worktree now (never pushes).',
  reinstall: 'Replaces the shared node_modules junction with a real npm install in this worktree.',
  remove: 'Deletes the worktree folder. The branch and its commits are kept.'
};

function actionsFor(w) {
  const a = [];
  const running = w.status === 'session-running' || w.status === 'dev-running';
  if (!running && w.status !== 'missing') {
    a.push(
      `<label class="inline-check" title="${TIP.claude}"><input type="checkbox" data-claude="${w.id}" checked> Claude</label>` +
      `<button data-action="start" data-id="${w.id}" title="${TIP.start}">Start</button>`
    );
  }
  if (running) {
    a.push(`<button class="secondary" data-action="mark-idle" data-id="${w.id}" title="${TIP.markIdle}">Mark idle</button>`);
  }
  if (w.status !== 'missing') {
    a.push(`<button class="secondary" data-action="terminal" data-id="${w.id}" title="${TIP.terminal}">Terminal</button>`);
    a.push(`<button class="secondary" data-action="vscode" data-id="${w.id}" title="${TIP.vscode}">VS Code</button>`);
  }
  if (w.status === 'committed-pending-push') {
    a.push(`<button data-action="push" data-id="${w.id}" title="${TIP.push}">Push &amp; create PR</button>`);
  }
  if (w.status === 'session-exited' || w.status === 'no-changes') {
    a.push(`<button class="secondary" data-action="commit" data-id="${w.id}" title="${TIP.commit}">Commit now</button>`);
  }
  if (w.status !== 'missing') {
    a.push(`<button class="secondary" data-action="reinstall" data-id="${w.id}" title="${TIP.reinstall}">Reinstall deps</button>`);
  }
  a.push(`<button class="danger" data-action="remove" data-id="${w.id}" title="${TIP.remove}">Remove</button>`);
  if (w.prUrl) a.push(`<a href="${w.prUrl}" target="_blank">PR &#8599;</a>`);
  return a.join(' ');
}

async function refresh() {
  try {
    allWorktrees = await api('/api/worktrees');
  } catch (e) {
    document.getElementById('wtBody').innerHTML = `<tr><td colspan="7">Error: ${e.message}</td></tr>`;
    return;
  }
  render();

  try {
    const total = await api('/api/usage/total');
    document.getElementById('totalUsage').textContent = `Total tokens: ${fmtTokens(total.total)}`;
    document.getElementById('totalCost').textContent = `Total est. cost: ${fmtUsd(total.usd)}`;
  } catch { /* ignore */ }
}

function render() {
  const body = document.getElementById('wtBody');
  body.innerHTML = '';

  const filtered = allWorktrees.filter((w) => (w.branch || '').toLowerCase().includes(filterText));
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  if (page >= pageCount) page = pageCount - 1;
  document.getElementById('pageLabel').textContent = `Page ${page + 1} of ${pageCount} (${filtered.length})`;
  const rows = filtered.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  if (rows.length === 0) {
    body.innerHTML = `<tr><td colspan="7" class="muted">No worktrees${filterText ? ' match that filter' : ' yet'}.</td></tr>`;
    return;
  }

  for (const w of rows) {
    const tr = document.createElement('tr');
    const u = w.usage || {};
    const costLabel = u.available ? `${fmtUsd(u.usd)}${u.estimated ? '*' : ''} ${expanded.has(w.id) ? '&#9662;' : '&#9656;'}` : '--';
    const src = w.tracked ? '' : '<span class="tag">discovered</span>';
    tr.innerHTML = `
      <td>${w.branch || '(unknown)'} ${src}</td>
      <td class="path" title="${w.path}">${w.path}</td>
      <td>${w.port ?? '--'}</td>
      <td><span class="status status-${w.status}">${w.status}</span></td>
      <td><button class="link" data-action="toggle-cost" data-id="${w.id}">${costLabel}</button></td>
      <td>${fmtTokens(u.total)}</td>
      <td>${actionsFor(w)}</td>
    `;
    body.appendChild(tr);

    if (expanded.has(w.id)) {
      const detail = document.createElement('tr');
      detail.className = 'detail-row';
      detail.innerHTML = `<td colspan="7"><div class="detail" id="detail-${w.id}">Loading breakdown...</div></td>`;
      body.appendChild(detail);
      loadDetail(w.id);
    }
  }

  wireButtons();
}

async function loadDetail(id) {
  const el = document.getElementById('detail-' + id);
  if (!el) return;
  try {
    const d = await api(`/api/worktrees/${id}/usage`);
    if (!d.available) { el.innerHTML = '<span class="muted">No Claude transcripts found for this worktree.</span>'; return; }
    const sessionRows = d.sessions.map((s) => `
      <tr><td>${(s.mtime || '').slice(0, 16).replace('T', ' ')}</td>
      <td>${fmtTokens(s.total)}</td><td>${fmtUsd(s.usd)}</td></tr>`).join('');
    const tips = (d.recommendations || []).map((t) => `<li>${t}</li>`).join('');
    el.innerHTML = `
      <div class="detail-grid">
        <div>
          <table class="mini">
            <thead><tr><th>Session</th><th>Tokens</th><th>Est. cost</th></tr></thead>
            <tbody>${sessionRows || '<tr><td colspan="3" class="muted">no sessions</td></tr>'}</tbody>
          </table>
        </div>
        <div>
          <div class="muted">Optimization tips${d.estimated ? ' (cost is estimated)' : ''}</div>
          <ul>${tips || '<li class="muted">Nothing to flag.</li>'}</ul>
        </div>
      </div>`;
  } catch (e) {
    el.innerHTML = `<span class="muted">Error: ${e.message}</span>`;
  }
}

function wireButtons() {
  const body = document.getElementById('wtBody');
  body.querySelectorAll('button[data-action]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const action = btn.dataset.action;

      if (action === 'toggle-cost') {
        if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
        render();
        return;
      }

      btn.disabled = true;
      try {
        if (action === 'start') {
          const cb = body.querySelector(`input[data-claude="${id}"]`);
          const withClaude = cb ? cb.checked : true;
          await api(`/api/worktrees/${id}/start`, { method: 'POST', body: JSON.stringify({ withClaude }) });
        } else if (action === 'terminal') {
          await api(`/api/worktrees/${id}/terminal`, { method: 'POST', body: JSON.stringify({}) });
        } else if (action === 'vscode') {
          await api(`/api/worktrees/${id}/vscode`, { method: 'POST', body: JSON.stringify({}) });
        } else if (action === 'mark-idle') {
          await api(`/api/worktrees/${id}/mark-idle`, { method: 'POST', body: JSON.stringify({}) });
        } else if (action === 'push') {
          const r = await api(`/api/worktrees/${id}/push`, { method: 'POST', body: JSON.stringify({}) });
          alert('PR created: ' + r.url);
        } else if (action === 'commit') {
          await api(`/api/worktrees/${id}/commit`, { method: 'POST', body: JSON.stringify({}) });
        } else if (action === 'reinstall') {
          await api(`/api/worktrees/${id}/reinstall`, { method: 'POST', body: JSON.stringify({}) });
        } else if (action === 'remove') {
          if (!confirm('Remove this worktree? Uncommitted changes will be lost. The branch is kept.')) {
            btn.disabled = false;
            return;
          }
          await api(`/api/worktrees/${id}`, { method: 'DELETE' });
        }
      } catch (e) {
        alert('Error: ' + e.message);
      }
      await refresh();
    });
  });
}

loadConfig();
refresh();
setInterval(refresh, 5000);
