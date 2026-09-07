// Pure-logic tests for the parts that don't spawn terminals or shell out.
// Run with:  npm test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const wt = require('../src/worktrees');
const usage = require('../src/usage');
const { reconcile, norm } = require('../src/reconcile');

test('parseWorktreePorcelain: branches, detached, bare', () => {
  const text = [
    'worktree /repo/main',
    'HEAD abc123',
    'branch refs/heads/main',
    '',
    'worktree /repo/.worktrees/wt-feature',
    'HEAD def456',
    'branch refs/heads/feature/x',
    '',
    'worktree /repo/.worktrees/wt-detached',
    'HEAD 999aaa',
    'detached',
    '',
    'worktree /repo/bare',
    'bare',
    ''
  ].join('\n');

  const list = wt.parseWorktreePorcelain(text);
  assert.equal(list.length, 3, 'bare worktree filtered out');
  assert.deepEqual(list[0], { path: '/repo/main', branch: 'main', head: 'abc123', detached: false, bare: false });
  assert.equal(list[1].branch, 'feature/x');
  assert.equal(list[2].detached, true);
  assert.equal(list[2].branch, null);
});

test('priceForModel: exact, prefix, default fallback', () => {
  const table = usage.DEFAULT_PRICING;
  assert.equal(usage.priceForModel('claude-sonnet-5', table).exact, true);
  // dated / suffixed id falls back to the "claude-sonnet-4" prefix row
  const p = usage.priceForModel('claude-sonnet-4-6-20260101', table);
  assert.equal(p.exact, true);
  assert.equal(p.rate.input, 3);
  // wholly unknown -> default, flagged inexact
  const d = usage.priceForModel('some-other-llm', table);
  assert.equal(d.exact, false);
});

test('costFor: sums per-model token cost in USD', () => {
  const perModel = {
    'claude-sonnet-5': {
      input_tokens: 1_000_000,        // $2
      output_tokens: 1_000_000,       // $10
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 1_000_000 // $0.20
    }
  };
  const { usd, estimated } = usage.costFor(perModel, usage.DEFAULT_PRICING);
  assert.ok(Math.abs(usd - 12.2) < 1e-9, `expected 12.2, got ${usd}`);
  assert.equal(estimated, false);
});

test('costFor: unknown model flags estimated', () => {
  const { estimated } = usage.costFor({ unknown: { input_tokens: 100 } }, usage.DEFAULT_PRICING);
  assert.equal(estimated, true);
});

test('recommendations: low cache reuse + big output fire tips', () => {
  const tips = usage.recommendations({
    perModel: {
      'claude-sonnet-5': {
        input_tokens: 500_000,
        cache_read_input_tokens: 10_000,
        cache_creation_input_tokens: 0,
        output_tokens: 80_000
      }
    },
    sessionCount: 6,
    usd: 25,
    costThreshold: 20
  });
  assert.ok(tips.some((t) => /cache reuse/i.test(t)));
  assert.ok(tips.some((t) => /diffs\/patches/i.test(t)));
  assert.ok(tips.some((t) => /\$25/.test(t)));
  assert.ok(tips.some((t) => /sessions recorded/i.test(t)));
});

test('recommendations: no transcript data -> no tips', () => {
  assert.deepEqual(usage.recommendations({ perModel: {} }), []);
});

test('recommendations: healthy usage -> reassurance', () => {
  const tips = usage.recommendations({
    perModel: { 'claude-sonnet-5': { input_tokens: 100_000, cache_read_input_tokens: 90_000, output_tokens: 5_000 } },
    sessionCount: 1,
    usd: 1
  });
  assert.equal(tips.length, 1);
  assert.match(tips[0], /healthy/i);
});

test('reconcile: inserts discovered worktrees and skips the main checkout', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wtd-test-'));
  const repo = path.join(tmp, 'repo');
  const disc = path.join(tmp, 'wt-existing');
  fs.mkdirSync(repo);
  fs.mkdirSync(disc);

  const s = {
    config: { repoPath: repo },
    worktrees: {}
  };
  await reconcile(s, {
    gitList: [
      { path: repo, branch: 'main', detached: false, bare: false },
      { path: disc, branch: 'feature/existing', detached: false, bare: false }
    ]
  });

  const recs = Object.values(s.worktrees);
  assert.equal(recs.length, 1, 'main checkout not tracked');
  assert.equal(recs[0].branch, 'feature/existing');
  assert.equal(recs[0].status, 'discovered');
  assert.equal(recs[0].tracked, false);
  assert.equal(recs[0].port, null);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('reconcile startup: downgrades leftover running status and flags missing folders', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wtd-test-'));
  const repo = path.join(tmp, 'repo');
  const live = path.join(tmp, 'wt-live');
  fs.mkdirSync(repo);
  fs.mkdirSync(live);

  const s = {
    config: { repoPath: repo },
    worktrees: {
      a: { id: 'a', path: live, branch: 'live', status: 'session-running', tracked: true, adopted: true, sessionPid: 123 },
      b: { id: 'b', path: path.join(tmp, 'gone'), branch: 'gone', status: 'idle', tracked: true, adopted: true }
    }
  };
  await reconcile(s, {
    startup: true,
    gitList: [
      { path: repo, branch: 'main' },
      { path: live, branch: 'live' }
    ]
  });

  assert.equal(s.worktrees.a.status, 'idle', 'running -> idle on startup');
  assert.equal(s.worktrees.a.sessionPid, null);
  assert.equal(s.worktrees.b.status, 'missing', 'vanished folder flagged');

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('norm: trailing separators and case', () => {
  assert.equal(norm('/a/b/'), norm('/a/b'));
});
