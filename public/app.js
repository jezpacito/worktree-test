async function api(path, opts) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

async function loadConfig() {
  const cfg = await api('/api/config');
  document.getElementById('cfgRepoPath').value = cfg.repoPath || '';
  document.getElementById('cfgDevCommand').value = cfg.devCommand || '';
  document.getElementById('cfgPortEnvVar').value = cfg.portEnvVar || '';
  document.getElementById('cfgEnvFile').value = cfg.envFileName || '';
  document.getElementById('cfgStartPort').value = cfg.startPort || '';
  document.getElementById('cfgWorktreesRoot').value = cfg.worktreesRoot || '';
}

document.getElementById('saveConfig').addEventListener('click', async () => {
  const status = document.getElementById('configStatus');
  status.textContent = 'Saving...';
  try {
    await api('/api/config', {
      method: 'POST',
      body: JSON.stringify({
        repoPath: document.getElementById('cfgRepoPath').value.trim(),
        devCommand: document.getElementById('cfgDevCommand').value.trim(),
        portEnvVar: document.getElementById('cfgPortEnvVar').value.trim(),
        envFileName: document.getElementById('cfgEnvFile').value.trim(),
        startPort: document.getElementById('cfgStartPort').value.trim(),
        worktreesRoot: document.getElementById('cfgWorktreesRoot').value.trim()
      })
    });
    status.textContent = 'Saved.';
  } catch (e) {
    status.textContent = 'Error: ' + e.message;
  }
});

document.getElementById('createWorktree').addEventListener('click', async () => {
  const status = document.getElementById('createStatus');
  const branch = document.getElementById('newBranch').value.trim();
  const baseRef = document.getElementById('newBaseRef').value.trim();
  if (!branch) { status.textContent = 'Branch name required.'; return; }
  status.textContent = 'Creating worktree and launching session...';
  try {
    const w = await api('/api/worktrees', { method: 'POST', body: JSON.stringify({ branch, baseRef }) });
    status.textContent = `Launched on port ${w.port}.`;
    document.getElementById('newBranch').value = '';
    await refresh();
  } catch (e) {
    status.textContent = 'Error: ' + e.message;
  }
});

function fmtTokens(n) {
  if (n == null) return '--';
  if (n > 1000000) return (n / 1000000).toFixed(2) + 'M';
  if (n > 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

async function refresh() {
  const list = await api('/api/worktrees');
  const body = document.getElementById('wtBody');
  body.innerHTML = '';

  for (const w of list) {
    const tr = document.createElement('tr');

    const actions = [];
    if (w.status === 'committed-pending-push') {
      actions.push(`<button data-action="push" data-id="${w.id}">Push & create PR</button>`);
    }
    if (w.status === 'session-exited' || w.status === 'no-changes') {
      actions.push(`<button class="secondary" data-action="commit" data-id="${w.id}">Commit now</button>`);
    }
    actions.push(`<button class="secondary" data-action="reinstall" data-id="${w.id}">Reinstall deps</button>`);
    actions.push(`<button class="danger" data-action="remove" data-id="${w.id}">Remove</button>`);
    if (w.prUrl) actions.push(`<a href="${w.prUrl}" target="_blank">PR ↗</a>`);

    tr.innerHTML = `
      <td>${w.branch}</td>
      <td>${w.port}</td>
      <td><span class="status status-${w.status}">${w.status}</span></td>
      <td>${fmtTokens(w.usage && w.usage.total)}</td>
      <td>${actions.join(' ')}</td>
    `;
    body.appendChild(tr);
  }

  body.querySelectorAll('button[data-action]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const action = btn.dataset.action;
      btn.disabled = true;
      try {
        if (action === 'push') {
          const r = await api(`/api/worktrees/${id}/push`, { method: 'POST', body: JSON.stringify({}) });
          alert('PR created: ' + r.url);
        } else if (action === 'commit') {
          await api(`/api/worktrees/${id}/commit`, { method: 'POST', body: JSON.stringify({}) });
        } else if (action === 'reinstall') {
          await api(`/api/worktrees/${id}/reinstall`, { method: 'POST', body: JSON.stringify({}) });
        } else if (action === 'remove') {
          if (confirm('Remove this worktree? Uncommitted changes will be lost.')) {
            await api(`/api/worktrees/${id}`, { method: 'DELETE' });
          }
        }
      } catch (e) {
        alert('Error: ' + e.message);
      }
      await refresh();
    });
  });

  const total = await api('/api/usage/total');
  document.getElementById('totalUsage').textContent = `Total tokens: ${fmtTokens(total.total)}`;
}

loadConfig();
refresh();
setInterval(refresh, 5000);
