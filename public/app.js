async function api(path, opts) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- config --------------------------------------------------------------

let config = {};

async function loadConfig() {
  config = await api('/api/config');
  $('cfgRepoPath').value = config.repoPath || '';
  $('cfgAppDir').value = config.appDir || '';
  $('cfgDevCommand').value = config.devCommand || '';
  $('cfgDevServerScheme').value = config.devServerScheme || 'http';
  $('cfgPortEnvVar').value = config.portEnvVar || '';
  $('cfgEnvFile').value = config.envFileName || '';
  $('cfgStartPort').value = config.startPort || '';
  $('cfgWorktreesRoot').value = config.worktreesRoot || '';
  $('cfgCostThreshold').value = config.costThreshold ?? '';
  $('cfgPricing').value = JSON.stringify(config.pricing || {}, null, 2);
  renderAppDirHint();
  renderDetection();
  renderBrandSub();
  $('newDevCommand').placeholder = config.devCommand || 'npm run dev';
  await Promise.all([loadNextPort(), loadScriptSuggestions()]);
}

// Pre-fill the port box with the port this worktree would get anyway, so the
// common case is "leave it alone" and the override is one edit away.
async function loadNextPort() {
  const input = $('newPort');
  if (input.dataset.touched === '1') return;
  try {
    const { port } = await api('/api/next-port');
    input.value = port;
  } catch {
    input.value = '';
  }
}

// Offer the project's own npm scripts (npm run dev, dev-mt, dev-tt, ...) as
// dev-command suggestions, rather than making the user remember them.
async function loadScriptSuggestions() {
  try {
    const { commands } = await api('/api/scripts');
    $('devCommandOptions').innerHTML = (commands || [])
      .map((c) => `<option value="${esc(c)}"></option>`).join('');
  } catch {
    $('devCommandOptions').innerHTML = '';
  }
}

// Once you type a port yourself, refreshes stop overwriting it -- until the
// next successful create, which hands back a clean suggestion.
$('newPort').addEventListener('input', () => {
  $('newPort').dataset.touched = $('newPort').value.trim() ? '1' : '';
});

function renderBrandSub() {
  const repo = config.repoPath || '';
  const name = repo ? repo.split(/[\\/]/).filter(Boolean).pop() : 'no project set';
  // The address actually in use, not the configured one: WTD_PORT, a proxy or
  // an https front-end all make those differ.
  $('brandSub').textContent = `${location.host || `localhost:${config.dashboardPort || 4999}`} · ${name}`;
}

// Show what was worked out about the project and why. The point is that the
// port plumbing is not something to configure by hand -- but a silent guess is
// worse than no guess, so every decision says what it was based on.
function renderDetection() {
  const box = $('detectNote');
  const d = config.detected;
  if (!d || !d.notes || !d.notes.length) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;
  box.innerHTML = `<span class="detected-title">Detected automatically</span><ul>`
    + d.notes.map((n) => `<li>${esc(n)}</li>`).join('')
    + `</ul><span class="detected-foot">Clear a field above to have it worked out again; typing in it overrides this.</span>`;
}

// Echo where the dev command will actually run, so a wrong subfolder is
// obvious before any worktree gets created.
function renderAppDirHint() {
  const repo = $('cfgRepoPath').value.trim();
  const appDir = $('cfgAppDir').value.trim().replace(/^[\\/]+|[\\/]+$/g, '');
  const hint = $('appDirHint');
  if (!repo) { hint.innerHTML = ''; return; }
  const sep = repo.includes('\\') ? '\\' : '/';
  const root = $('cfgWorktreesRoot').value.trim()
    || repo.split(/[\\/]/).slice(0, -1).join(sep) + sep + '.worktrees';
  const target = root + sep + 'wt-<branch>' + (appDir ? sep + appDir.replace(/\//g, sep) : '');
  hint.innerHTML = `Dev command and env file resolve to <code>${esc(target)}</code>`;
}

['cfgAppDir', 'cfgRepoPath', 'cfgWorktreesRoot'].forEach((id) =>
  $(id).addEventListener('input', renderAppDirHint));

$('toggleSettings').addEventListener('click', () => {
  const panel = $('settingsPanel');
  const open = panel.hidden;
  panel.hidden = !open;
  $('toggleSettings').setAttribute('aria-expanded', String(open));
  if (open) $('cfgRepoPath').focus();
});

$('saveConfig').addEventListener('click', async () => {
  const status = $('configStatus');
  status.className = 'form-note';
  status.textContent = 'Saving…';
  try {
    await api('/api/config', {
      method: 'POST',
      body: JSON.stringify({
        repoPath: $('cfgRepoPath').value.trim(),
        appDir: $('cfgAppDir').value.trim(),
        devCommand: $('cfgDevCommand').value.trim(),
        devServerScheme: $('cfgDevServerScheme').value,
        portEnvVar: $('cfgPortEnvVar').value.trim(),
        envFileName: $('cfgEnvFile').value.trim(),
        startPort: $('cfgStartPort').value.trim(),
        worktreesRoot: $('cfgWorktreesRoot').value.trim(),
        costThreshold: $('cfgCostThreshold').value.trim(),
        pricing: $('cfgPricing').value.trim()
      })
    });
    status.className = 'form-note ok';
    status.textContent = 'Settings saved';
    setTimeout(() => { status.textContent = ''; }, 2000);
    await loadConfig();
    await refresh();
  } catch (e) {
    status.className = 'form-note error';
    status.textContent = e.message;
  }
});

$('createWorktree').addEventListener('click', async () => {
  const status = $('createStatus');
  const btn = $('createWorktree');
  const branch = $('newBranch').value.trim();
  const baseRef = $('newBaseRef').value.trim();
  const port = $('newPort').value.trim();
  const devCommand = $('newDevCommand').value.trim();
  const withClaude = $('newWithClaude').checked;
  status.className = 'form-note';
  if (!branch) {
    status.className = 'form-note error';
    status.textContent = 'Enter a branch name first.';
    return;
  }
  btn.disabled = true;
  status.textContent = 'Creating the worktree and opening a terminal…';
  try {
    const w = await api('/api/worktrees', {
      method: 'POST',
      body: JSON.stringify({ branch, baseRef, port, devCommand, withClaude })
    });
    status.className = 'form-note ok';
    status.textContent = `${w.branch} is running on port ${w.port} via \`${w.devCommand || config.devCommand}\`.`;
    $('newBranch').value = '';
    $('newBaseRef').value = '';
    $('newDevCommand').value = '';
    $('newPort').dataset.touched = '';
    await loadNextPort();
    await refresh();
  } catch (e) {
    status.className = 'form-note error';
    status.textContent = e.message;
  }
  btn.disabled = false;
});

// ---- status tones --------------------------------------------------------

// The dashboard records what it launched; it never polls to see whether that
// terminal is still open. These labels describe the last recorded action, not
// a verified live process.
const TONES = {
  'session-running':        { tone: 'running', label: 'Claude + dev server' },
  'dev-running':            { tone: 'running', label: 'Dev server' },
  'created':                { tone: 'warn',    label: 'Never launched' },
  'idle':                   { tone: 'idle',    label: 'Idle' },
  'session-exited':         { tone: 'idle',    label: 'Session ended' },
  'no-changes':             { tone: 'idle',    label: 'No changes' },
  'committed-pending-push': { tone: 'pending', label: 'Committed, not pushed' },
  'pushed-no-pr':           { tone: 'pending', label: 'Pushed, PR not created' },
  'pr-created':             { tone: 'done',    label: 'PR created' },
  'discovered':             { tone: 'found',   label: 'Discovered' },
  'missing':                { tone: 'gone',    label: 'Folder missing' }
};
const toneFor = (s) => TONES[s] || { tone: 'idle', label: s };
const isRunning = (s) => s === 'session-running' || s === 'dev-running';

// ---- table ---------------------------------------------------------------

let allWorktrees = [];
let filterText = '';
let page = 0;
const PAGE_SIZE = 10;
const expanded = new Set();
let openMenu = null;

$('branchFilter').addEventListener('input', (e) => {
  filterText = e.target.value.trim().toLowerCase();
  page = 0;
  render();
});
$('pagePrev').addEventListener('click', () => { if (page > 0) { page--; render(); } });
$('pageNext').addEventListener('click', () => { page++; render(); });

function fmtTokens(n) {
  if (n == null) return '—';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}
function fmtUsd(n) {
  if (n == null || Number.isNaN(n)) return '—';
  if (n > 0 && n < 0.01) return '<$0.01';
  return '$' + n.toFixed(2);
}
const fmtInt = (n) => (n == null ? '—' : n.toLocaleString('en-US'));

// Show the worktree folder relative to the worktrees root -- the shared prefix
// is the same on every row and just pushes the useful part out of view.
function shortPath(full) {
  const roots = [config.worktreesRoot, config.repoPath].filter(Boolean);
  for (const root of roots) {
    const norm = (p) => p.replace(/[\\/]+$/, '');
    if (full.length > norm(root).length && full.startsWith(norm(root))) {
      return full.slice(norm(root).length).replace(/^[\\/]+/, '');
    }
  }
  return full;
}

const CHEVRON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
const KEBAB = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>';

// The scheme is the PROJECT's, not the dashboard's: an https dashboard in front
// of a plain dev server must still link to http, and a project whose dev server
// serves TLS needs https even when the dashboard itself is plain. Hence the
// explicit setting rather than copying location.protocol. The host does follow
// the address bar, so the link points at the right machine behind a proxy.
function devServerOrigin(port) {
  const scheme = config.devServerScheme === 'https' ? 'https' : 'http';
  const host = location.hostname || 'localhost';
  return `${scheme}://${host.includes(':') ? `[${host}]` : host}:${port}`;
}

// The port cell links to the dev server. It stays clickable when idle -- the
// port is still that worktree's -- but is dimmed so you can tell it is not up.
function portCell(w) {
  if (w.port == null) return '<span class="empty-cell">—</span>';
  const url = devServerOrigin(w.port);
  const live = isRunning(w.status);
  const cmd = w.devCommand ? `\nDev command: ${w.devCommand}` : '';
  const title = (live ? `Open ${url}` : `Open ${url}. The dev server is not running — start it first.`) + cmd;
  return `<a class="port-link${live ? '' : ' dim'}" href="${url}" target="_blank" rel="noopener noreferrer" title="${esc(title)}">${w.port}</a>`;
}

function rowHtml(w) {
  const t = toneFor(w.status);
  const u = w.usage || {};
  const open = expanded.has(w.id);
  const from = w.baseRef ? `from ${esc(w.baseRef)}` : (w.tracked ? '' : 'found on disk');
  const sess = w.claudeSessionId
    ? `<span class="tag" title="Claude session ${esc(w.claudeSessionId)}. Start resumes it once it has been used.">resumes ${esc(w.claudeSessionId.slice(0, 8))}</span>`
    : '';

  const cost = u.available
    ? `<button class="cost-toggle" data-action="toggle-cost" data-id="${w.id}" aria-expanded="${open}">
         ${fmtUsd(u.usd)}${u.estimated ? '*' : ''} ${CHEVRON}</button>`
    : '<span class="empty-cell">—</span>';

  const primary = w.status === 'missing' ? ''
    : isRunning(w.status)
      ? `<button class="btn btn-ghost btn-sm" data-action="mark-idle" data-id="${w.id}" title="You closed that terminal yourself — resets this row to idle and frees the port. It does not stop a running process.">Mark idle</button>`
      : `<button class="btn btn-primary btn-sm" data-action="start" data-id="${w.id}" title="${config.capabilities?.openTerminal ? 'Opens a terminal running the dev server on this worktree\'s port.' : 'Starts the dev server on this worktree\'s port.'}">Start</button>`;

  return `
    <div class="row-grid">
      <div>
        <div class="cell-branch-name" title="${esc(w.branch || '')}">${esc(w.branch || '(unknown)')}</div>
        ${from || sess ? `<div class="cell-branch-from">${from}${from && sess ? ' · ' : ''}${sess}</div>` : ''}
      </div>
      <div class="cell-path" title="${esc(w.path)}">${esc(shortPath(w.path))}</div>
      <div class="cell-port">${portCell(w)}</div>
      <div><span class="status tone-${t.tone}"><span class="dot"></span>${esc(t.label)}</span></div>
      <div>${cost}</div>
      <div class="cell-tokens">${fmtTokens(u.total)}</div>
      <div class="cell-actions">
        ${primary}
        <button class="btn-icon" data-action="menu" data-id="${w.id}" aria-expanded="${openMenu === w.id}" aria-label="More actions for ${esc(w.branch || 'this worktree')}">${KEBAB}</button>
      </div>
    </div>
    ${open ? `<div class="detail" id="detail-${w.id}">Loading breakdown…</div>` : ''}`;
}

function menuHtml(w) {
  const live = isRunning(w.status);
  const items = [];
  if (!live && w.status !== 'missing') {
    items.push(`<label><input type="checkbox" data-claude="${w.id}" checked> Run Claude on start</label>`);
  }
  if (w.status !== 'missing') {
    if (config.capabilities?.openTerminal) {
      items.push(`<button data-action="claude" data-id="${w.id}" title="Opens the Claude session for this worktree on its own -- no dev server, no port, nothing committed on exit. Close the worktree's other window first if one is already open on this session.">Open Claude session</button>`);
      items.push(`<button data-action="terminal" data-id="${w.id}">Open terminal</button>`);
    }
    items.push(`<button data-action="vscode" data-id="${w.id}">Open in VS Code</button>`);
  }
  if (w.status === 'committed-pending-push') {
    items.push(`<button class="accent" data-action="push" data-id="${w.id}">Push and create PR</button>`);
  }
  if (w.status === 'session-exited' || w.status === 'no-changes') {
    items.push(`<button data-action="commit" data-id="${w.id}">Commit now</button>`);
  }
  if (w.status !== 'missing') {
    items.push(`<button data-action="reinstall" data-id="${w.id}">Reinstall deps</button>`);
  }
  if (w.claudeSessionId && !live) {
    items.push(`<button data-action="new-session" data-id="${w.id}">Start a fresh Claude session</button>`);
  }
  if (w.prUrl) items.push(`<button data-action="open-pr" data-id="${w.id}">View pull request</button>`);
  items.push('<div class="sep"></div>');
  items.push(`<button class="danger" data-action="remove" data-id="${w.id}">Remove worktree</button>`);
  return items.join('');
}

function render() {
  const body = $('wtBody');
  const filtered = allWorktrees.filter((w) => (w.branch || '').toLowerCase().includes(filterText));
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  if (page >= pageCount) page = pageCount - 1;
  const rows = filtered.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  $('pageLabel').textContent = `Page ${page + 1} of ${pageCount}`;
  $('pagePrev').disabled = page === 0;
  $('pageNext').disabled = page >= pageCount - 1;
  $('resultsSummary').textContent = filtered.length === allWorktrees.length
    ? `${allWorktrees.length} total`
    : `${filtered.length} of ${allWorktrees.length} match “${filterText}”`;

  if (rows.length === 0) {
    body.innerHTML = filterText
      ? `<div class="empty"><strong>Nothing matches “${esc(filterText)}”</strong>Clear the filter to see every worktree.</div>`
      : `<div class="empty"><strong>No worktrees yet</strong>Name a branch above and create one — it gets its own port and its own terminal.</div>`;
    return;
  }

  body.innerHTML = rows.map((w) => `<div class="row">${rowHtml(w)}</div>`).join('');
  for (const w of rows) if (expanded.has(w.id)) loadDetail(w.id);
  if (openMenu && !rows.some((w) => w.id === openMenu)) openMenu = null;
}

function renderKpis(total) {
  const running = allWorktrees.filter((w) => isRunning(w.status)).length;
  const claude = allWorktrees.filter((w) => w.status === 'session-running').length;
  $('kpiCount').textContent = allWorktrees.length;
  $('kpiCountFoot').textContent = allWorktrees.length
    ? `${allWorktrees.filter((w) => w.tracked).length} tracked here`
    : 'none yet';
  $('kpiRunning').textContent = running;
  $('kpiRunningFoot').textContent = running
    ? `${claude} launched with Claude`
    : 'none launched from here';
  $('kpiCost').textContent = total ? fmtUsd(total.usd) : '—';
  $('kpiCostFoot').textContent = `alert above ${fmtUsd(Number(config.costThreshold ?? 20))}`;
  $('kpiTokens').textContent = total ? fmtTokens(total.total) : '—';
  $('totalCost').textContent = `Estimated cost ${total ? fmtUsd(total.usd) : '—'}`;
  $('totalUsage').textContent = `Tokens ${total ? fmtTokens(total.total) : '—'}`;
}

async function refresh() {
  try {
    allWorktrees = await api('/api/worktrees');
  } catch (e) {
    $('wtBody').innerHTML = `<div class="empty"><strong>Can't reach the dashboard</strong>${esc(e.message)}</div>`;
    return;
  }
  render();
  try { renderKpis(await api('/api/usage/total')); } catch { renderKpis(null); }
}

const BREAKDOWN = [
  ['Input', 'input_tokens'],
  ['Output', 'output_tokens'],
  ['Cache write', 'cache_creation_input_tokens'],
  ['Cache read', 'cache_read_input_tokens']
];

async function loadDetail(id) {
  const el = $('detail-' + id);
  if (!el) return;
  try {
    const d = await api(`/api/worktrees/${id}/usage`);
    if (!d.available) {
      el.innerHTML = '<div class="tips">No Claude transcripts found for this worktree yet.</div>';
      return;
    }
    const cells = BREAKDOWN.map(([label, key]) => `
      <div>
        <div class="breakdown-label">${label}</div>
        <div class="breakdown-value">${fmtInt((d.totals || {})[key] || 0)}</div>
      </div>`).join('');
    const tips = (d.recommendations || []).map((t) => `<li>${esc(t)}</li>`).join('');
    el.innerHTML = `
      <div class="breakdown">${cells}</div>
      <div class="tips">
        <b>Tips</b>
        <ul>${tips || '<li>Nothing to flag.</li>'}</ul>
        ${d.estimated ? '<div class="caveat">* some model ids were unknown and priced at the fallback rate</div>' : ''}
      </div>`;
  } catch (e) {
    el.innerHTML = `<div class="tips">${esc(e.message)}</div>`;
  }
}

// ---- actions -------------------------------------------------------------

function closeMenu() {
  openMenu = null;
  document.querySelectorAll('.menu, .menu-backdrop').forEach((n) => n.remove());
  document.querySelectorAll('[data-action="menu"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
}

function showMenu(btn, w) {
  closeMenu();
  openMenu = w.id;
  btn.setAttribute('aria-expanded', 'true');

  const backdrop = document.createElement('div');
  backdrop.className = 'menu-backdrop';
  backdrop.addEventListener('click', closeMenu);

  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.innerHTML = menuHtml(w);
  document.body.append(backdrop, menu);

  // Anchor to the button, flipping above it when there isn't room below.
  const r = btn.getBoundingClientRect();
  menu.style.left = Math.max(8, r.right - menu.offsetWidth) + 'px';
  menu.style.top = (r.bottom + 6 + menu.offsetHeight > innerHeight
    ? r.top - 6 - menu.offsetHeight
    : r.bottom + 6) + 'px';
  menu.querySelector('button, input')?.focus();
}

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const { action, id } = btn.dataset;
  const w = allWorktrees.find((x) => x.id === id);
  if (!w) return;

  if (action === 'toggle-cost') {
    if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
    render();
    return;
  }
  if (action === 'menu') {
    if (openMenu === id) closeMenu(); else showMenu(btn, w);
    return;
  }
  if (action === 'open-pr') { window.open(w.prUrl, '_blank', 'noopener'); closeMenu(); return; }

  const claudeBox = document.querySelector(`input[data-claude="${id}"]`);
  const withClaude = claudeBox ? claudeBox.checked : true;
  closeMenu();
  btn.disabled = true;

  try {
    if (action === 'start') {
      await api(`/api/worktrees/${id}/start`, { method: 'POST', body: JSON.stringify({ withClaude }) });
    } else if (action === 'mark-idle') {
      await api(`/api/worktrees/${id}/mark-idle`, { method: 'POST', body: JSON.stringify({}) });
    } else if (action === 'claude') {
      await api(`/api/worktrees/${id}/claude`, { method: 'POST', body: JSON.stringify({}) });
    } else if (action === 'terminal') {
      await api(`/api/worktrees/${id}/terminal`, { method: 'POST', body: JSON.stringify({}) });
    } else if (action === 'vscode') {
      await api(`/api/worktrees/${id}/vscode`, { method: 'POST', body: JSON.stringify({}) });
    } else if (action === 'push') {
      const r = await api(`/api/worktrees/${id}/push`, { method: 'POST', body: JSON.stringify({}) });
      window.open(r.url, '_blank', 'noopener');
    } else if (action === 'commit') {
      await api(`/api/worktrees/${id}/commit`, { method: 'POST', body: JSON.stringify({}) });
    } else if (action === 'new-session') {
      if (!confirm(`Next Start on ${w.branch} begins a new Claude conversation instead of resuming the current one. The old transcript is kept. Continue?`)) {
        btn.disabled = false;
        return;
      }
      await api(`/api/worktrees/${id}/new-session`, { method: 'POST', body: JSON.stringify({}) });
    } else if (action === 'reinstall') {
      await api(`/api/worktrees/${id}/reinstall`, { method: 'POST', body: JSON.stringify({}) });
    } else if (action === 'remove') {
      if (!confirm(`Remove ${w.branch}? Uncommitted changes in that worktree are lost. The branch and its commits are kept.`)) {
        btn.disabled = false;
        return;
      }
      await api(`/api/worktrees/${id}`, { method: 'DELETE' });
    }
  } catch (err) {
    alert(err.message);
  }
  await refresh();
});

loadConfig();
refresh();
setInterval(() => { if (!openMenu) refresh(); }, 5000);
