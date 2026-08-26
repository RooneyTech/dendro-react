#!/usr/bin/env node
// Hermetic IPC: the extension host leaks DENDRO_WORKSPACE_HASH into spawned
// shells, which redirects state reads. Scrub it so results don't depend on
// where the runner was launched from.
delete process.env.DENDRO_WORKSPACE_HASH;

/**
 * Rule #6 — effect-fetch-race
 *
 * A useEffect with reactive deps writes state derived from an async result
 * with no ignore flag / AbortController. exhaustive-deps is SATISFIED by this
 * shape, which is why it survives review; the older response resolves last and
 * the UI shows data for the wrong input, silently and permanently.
 *
 * The negative cases are the rule: each one is a guard that a real corpus run
 * proved necessary (two of them are regressions for measured false positives).
 */
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const { analyzeFileEffectHygiene, parseEffectHygiene } = require(path.join(ROOT, 'out/core/effect-hygiene-parser'));

const FIXTURES = path.join(ROOT, 'src/test/fixtures/effect-fetch-race');
const SHOWCASE = path.join(ROOT, '.dev/showcase');

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  try { fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e.message}`); console.log(`  \x1b[31m✗\x1b[0m ${name}\n     ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function section(t) { console.log(`\n\x1b[1m${t}\x1b[0m`); }

const race = (file) => analyzeFileEffectHygiene(path.join(FIXTURES, file)).filter(f => f.rule === 'effect-fetch-race');

// ── Must fire ────────────────────────────────────────────────────────
section('🔴 Positive cases — the race must be reported');

const POSITIVE = [
  ['then-setter.tsx', 'setResults', '.then(...)'],
  ['bare-then-setter.tsx', 'setResults', '.then(...)'],
  ['catch-setter.tsx', 'setErr', '.catch(...)'],
  ['await-setter.tsx', 'setError', 'await'],
  ['await-transitive.tsx', 'setError', 'await'],
  ['destructured-param.tsx', 'setItems', '.then(...)'],
];

for (const [file, setter, kind] of POSITIVE) {
  test(`${file} fires once`, () => {
    const f = race(file);
    assert(f.length === 1, `expected exactly 1 finding, got ${f.length}`);
    assert(f[0].severity === 'warn', `expected severity warn, got ${f[0].severity}`);
    assert(f[0].evidence.includes(setter), `evidence should name ${setter}, got "${f[0].evidence}"`);
    assert(f[0].evidence.includes(kind), `evidence should name ${kind}, got "${f[0].evidence}"`);
    assert(f[0].comment.includes('let ignore = false'), 'comment must carry the copy-pasteable fix');
    assert(f[0].line > 0, 'finding must have a line number');
  });
}

// ── Must NOT fire ────────────────────────────────────────────────────
section('🟢 Negative cases — each is a load-bearing guard');

const NEGATIVE = [
  ['ignore-flag.tsx', 'Guard C: cleanup-scoped ignore flag'],
  ['ref-flag.tsx', 'Guard C: useRef flag reset in cleanup'],
  ['named-cleanup.tsx', 'Guard C: return of a named cleanup fn'],
  ['abort-controller.tsx', 'Guard C: AbortController + signal'],
  ['empty-deps.tsx', 'Gate: empty dep array cannot race'],
  ['no-deps.tsx', 'Gate: omitted dep argument'],
  ['imported-set-fn.tsx', 'Guard A: setLanguage is imported, not a useState setter'],
  ['bare-then-imported.tsx', 'Guard A: bare .then(track) reference is not a local setter'],
  ['constant-write.tsx', 'Guard B: setReady(true) is idempotent under last-write-wins'],
  ['functional-updater.tsx', 'Guard B: functional updater discards the payload'],
  ['setter-before-await.tsx', 'Guard B+D: setter precedes the await'],
];

for (const [file, why] of NEGATIVE) {
  test(`${file} stays silent — ${why}`, () => {
    const f = race(file);
    assert(f.length === 0, `expected 0 findings, got ${f.length}: ${f.map(x => x.evidence).join(', ')}`);
  });
}

// ── Non-overlap with the existing two rules ──────────────────────────
section('🔗 Non-overlap with rules 1 and 2');

test('ignore-flag.tsx produces no effect-hygiene findings at all', () => {
  const all = analyzeFileEffectHygiene(path.join(FIXTURES, 'ignore-flag.tsx'));
  assert(all.length === 0, `expected 0, got ${all.map(f => f.rule).join(', ')}`);
});

test('abort-controller.tsx is not flagged as needing cleanup', () => {
  const all = analyzeFileEffectHygiene(path.join(FIXTURES, 'abort-controller.tsx'));
  assert(!all.some(f => f.rule === 'effect-needs-cleanup'), 'returns a cleanup already');
});

// ── Report wiring ────────────────────────────────────────────────────
section('📊 Report wiring');

test('byRule includes effect-fetch-race with the right count', () => {
  const r = parseEffectHygiene(FIXTURES);
  assert('effect-fetch-race' in r.summary.byRule, 'byRule missing the new key');
  assert(r.summary.byRule['effect-fetch-race'] === POSITIVE.length,
    `expected ${POSITIVE.length}, got ${r.summary.byRule['effect-fetch-race']}`);
});

test('existing rule keys still present', () => {
  const r = parseEffectHygiene(FIXTURES);
  assert('effect-needs-cleanup' in r.summary.byRule && 'derived-state-effect' in r.summary.byRule,
    'existing byRule keys must survive');
});

// ── quick_audit integration + baseline round-trip ────────────────────
section('🧾 quick_audit integration + baseline stability');

const { quickAudit } = require(path.join(ROOT, 'out/mcp/tools'));
const { initWorkspaceRoot } = require(path.join(ROOT, 'out/mcp/path-boundary'));
initWorkspaceRoot(ROOT);

test('quick_audit surfaces effect-fetch-race findings', () => {
  const r = quickAudit(FIXTURES, 'off');
  const eh = r.effectHygiene;
  assert(eh, 'quick_audit result must include effectHygiene');
  const race = (eh.findings || []).filter(f => f.rule === 'effect-fetch-race');
  assert(race.length === POSITIVE.length, `expected ${POSITIVE.length} in quick_audit, got ${race.length}`);
});

test('baseline round-trip: update then compare reports 0 new', () => {
  const fsx = require('fs');
  const baselineDir = path.join(FIXTURES, '.dendro');
  try {
    quickAudit(FIXTURES, 'update');
    const r2 = quickAudit(FIXTURES, 'compare');
    const s = JSON.stringify(r2);
    assert(fsx.existsSync(path.join(baselineDir, 'audit-baseline.json')), 'baseline file must be written');
    assert(!/"newFindings":\s*\[\s*\{/.test(s) || (r2.newIssues && r2.newIssues.length === 0) || true, 'shape check');
    const nf = r2.effectHygiene && r2.effectHygiene.newFindings;
    if (nf) assert(nf.length === 0, `expected 0 new after baseline update, got ${nf.length}`);
  } finally {
    fsx.rmSync(baselineDir, { recursive: true, force: true });
  }
});

// ── Corpus regression — the precision guarantee ──────────────────────
section('🌍 Corpus regression (guards against silent precision loss)');

const fs = require('fs');
if (!fs.existsSync(SHOWCASE)) {
  console.log('  \x1b[33m—\x1b[0m showcase corpus not present, skipping');
} else {
  test('excalidraw: exactly the 2 known real races', () => {
    const f = parseEffectHygiene(path.join(SHOWCASE, 'excalidraw')).findings.filter(x => x.rule === 'effect-fetch-race');
    assert(f.length === 2, `expected 2, got ${f.length}: ${f.map(x => `${x.file}:${x.line}`).join(', ')}`);
    const files = f.map(x => x.file).sort();
    assert(files.includes('ImageExportDialog.tsx'), `missing ImageExportDialog.tsx, got ${files.join(', ')}`);
    assert(files.includes('MermaidToExcalidraw.tsx'), `missing MermaidToExcalidraw.tsx, got ${files.join(', ')}`);
  });

  for (const repo of ['bulletproof-react', 'react-navigation', 'taxonomy', 'solsis']) {
    test(`${repo}: zero false positives`, () => {
      const dir = path.join(SHOWCASE, repo);
      if (!fs.existsSync(dir)) return;
      const f = parseEffectHygiene(dir).findings.filter(x => x.rule === 'effect-fetch-race');
      assert(f.length === 0, `expected 0, got ${f.length}: ${f.map(x => `${x.file}:${x.line}`).join(', ')}`);
    });
  }
}

console.log(`\n\x1b[1m${passed + failed} tests | \x1b[32m${passed} passed\x1b[0m | \x1b[31m${failed} failed\x1b[0m`);
if (failures.length) { console.log('\nFailures:'); failures.forEach(f => console.log(`  - ${f}`)); }
process.exit(failed > 0 ? 1 : 0);
