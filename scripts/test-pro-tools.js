#!/usr/bin/env node
/**
 * test-pro-tools.js
 *
 * Tests for the 4 new Pro MCP tools:
 *   - batch_analysis
 *   - save_snapshot
 *   - list_snapshots
 *   - compare_snapshots
 *
 * Usage:
 *   npm run build && node scripts/test-pro-tools.js
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { createHmac } = require('crypto');

// Paths
const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(ROOT, 'src/test/fixtures/mcp-tools');
const APP_FIXTURE = path.join(FIXTURES, 'App.tsx');
const HEADER_FIXTURE = path.join(FIXTURES, 'Header.tsx');
const DENDRO_DIR = path.join(os.homedir(), '.dendro');
const LICENSE_FILE = path.join(DENDRO_DIR, 'license-status.json');
const LICENSE_SECRET_PATH = path.join(DENDRO_DIR, '.license-secret');

// Temp workspace for snapshot tests
const TEMP_WORKSPACE = path.join(os.tmpdir(), `dendro-test-${Date.now()}`);

// Initialize workspace root so assertPathInWorkspace() accepts fixture paths
process.env.DENDRO_WORKSPACE_ROOT = ROOT;
const { initWorkspaceRoot } = require(path.join(ROOT, 'out/mcp/path-boundary'));
initWorkspaceRoot();

/**
 * Write a properly HMAC-signed license file for testing.
 */
function writeSignedLicense(isPro, cachedUntil) {
  const secret = 'a'.repeat(64);
  const signature = createHmac('sha256', secret)
    .update(`${isPro}:${cachedUntil}`)
    .digest('hex');
  fs.mkdirSync(DENDRO_DIR, { recursive: true });
  fs.writeFileSync(LICENSE_SECRET_PATH, secret);
  fs.writeFileSync(LICENSE_FILE, JSON.stringify({ isPro, cachedUntil, signature }));
  return secret;
}

function cleanupLicense() {
  try { fs.unlinkSync(LICENSE_FILE); } catch {}
  try { fs.unlinkSync(LICENSE_SECRET_PATH); } catch {}
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ❌ ${name}`);
    console.log(`     ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function cleanup() {
  try {
    if (fs.existsSync(TEMP_WORKSPACE)) {
      fs.rmSync(TEMP_WORKSPACE, { recursive: true, force: true });
    }
  } catch { /* best effort */ }
}

// ============================================================================
// 1. Batch Analysis
// ============================================================================
console.log('\n📦 Batch Analysis');

const { batchAnalysis } = require(path.join(ROOT, 'out/mcp/pro-tools/batch-analysis'));

test('batch with single entry returns result', () => {
  const result = batchAnalysis(
    [{ entryFile: APP_FIXTURE, label: 'App' }],
    ['tree']
  );
  assert(result.entries.length === 1, `expected 1 entry, got ${result.entries.length}`);
  assert(result.entries[0].label === 'App', 'label should be "App"');
  assert(result.entries[0].result.tree, 'should have tree result');
  assert(result.aggregate.totalEntries === 1, 'totalEntries should be 1');
  assert(result.aggregate.totalComponents >= 1, 'should have at least 1 component');
});

test('batch with multiple entries returns combined results', () => {
  const result = batchAnalysis(
    [
      { entryFile: APP_FIXTURE, label: 'App' },
      { entryFile: HEADER_FIXTURE, label: 'Header' }
    ],
    ['tree']
  );
  assert(result.entries.length === 2, `expected 2 entries, got ${result.entries.length}`);
  assert(result.aggregate.totalEntries === 2, 'totalEntries should be 2');
  assert(result.aggregate.totalComponents >= 2, 'combined components should be >= 2');
});

test('batch with complexity collects highest scores', () => {
  const result = batchAnalysis(
    [{ entryFile: APP_FIXTURE }],
    ['tree', 'complexity']
  );
  assert(result.entries[0].result.complexity, 'should have complexity');
  assert(Array.isArray(result.aggregate.highestComplexity), 'should have highestComplexity array');
});

test('batch with multiple analyses runs all', () => {
  const result = batchAnalysis(
    [{ entryFile: APP_FIXTURE }],
    ['tree', 'complexity', 'context']
  );
  const entry = result.entries[0].result;
  assert(entry.tree, 'should have tree');
  assert(entry.complexity, 'should have complexity');
  assert(entry.context, 'should have context');
  assert(entry.stats.analysesRun >= 3, `expected >= 3 analyses, got ${entry.stats.analysesRun}`);
});

test('batch with empty entries returns error', () => {
  const result = batchAnalysis([], ['tree']);
  assert(result.error, 'should have error for empty entries');
  assert(result.entries.length === 0, 'should have 0 entries');
});

test('batch handles missing file gracefully', () => {
  const result = batchAnalysis(
    [
      { entryFile: APP_FIXTURE, label: 'Good' },
      { entryFile: '/nonexistent/file.tsx', label: 'Bad' }
    ],
    ['tree']
  );
  assert(result.entries.length === 2, 'should still have 2 entries');
  assert(result.entries[0].result.tree, 'good entry should have tree');
  // Bad entry should have error in its result
  const badEntry = result.entries[1].result;
  assert(badEntry.error || (badEntry.tree && badEntry.tree.error), 'bad entry should have error');
});

test('batch with maxDepth limits tree depth', () => {
  const full = batchAnalysis([{ entryFile: APP_FIXTURE }], ['tree']);
  const shallow = batchAnalysis([{ entryFile: APP_FIXTURE }], ['tree'], 0);
  assert(
    shallow.aggregate.totalComponents <= full.aggregate.totalComponents,
    'shallow should have fewer or equal components'
  );
});

test('batch auto-generates label from filename', () => {
  const result = batchAnalysis(
    [{ entryFile: APP_FIXTURE }],
    ['tree']
  );
  assert(result.entries[0].label === 'App.tsx', `expected "App.tsx", got "${result.entries[0].label}"`);
});

// ============================================================================
// 2. Save Snapshot
// ============================================================================
console.log('\n💾 Save Snapshot');

// Create temp workspace and switch to permissive mode for snapshot tests.
// Snapshot tests use both fixture paths (under ROOT) and temp paths (under /tmp).
// Setting DENDRO_WORKSPACE_ROOT to /tmp triggers permissive mode since /tmp is in UNSAFE_ROOTS.
fs.mkdirSync(TEMP_WORKSPACE, { recursive: true });
process.env.DENDRO_WORKSPACE_ROOT = '/tmp';
initWorkspaceRoot();

const { saveSnapshot, listSnapshots, loadSnapshot } = require(path.join(ROOT, 'out/mcp/pro-tools/snapshot-manager'));

test('saves snapshot to workspace', () => {
  const result = saveSnapshot(APP_FIXTURE, TEMP_WORKSPACE, 'test-snapshot');
  assert(result.id, 'should have id');
  assert(result.label === 'test-snapshot', `label should be "test-snapshot", got "${result.label}"`);
  assert(result.timestamp, 'should have timestamp');
  assert(result.path, 'should have path');
  assert(fs.existsSync(result.path), 'snapshot file should exist on disk');
  assert(result.analysesIncluded.length >= 1, 'should have at least 1 analysis');
  assert(result.stats.totalComponents >= 1, 'should have at least 1 component');
});

test('creates .dendro/snapshots/ directory', () => {
  const snapshotsDir = path.join(TEMP_WORKSPACE, '.dendro', 'snapshots');
  assert(fs.existsSync(snapshotsDir), '.dendro/snapshots/ should exist');
});

test('creates manifest.json', () => {
  const manifestPath = path.join(TEMP_WORKSPACE, '.dendro', 'snapshots', 'manifest.json');
  assert(fs.existsSync(manifestPath), 'manifest.json should exist');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  assert(manifest.snapshots.length >= 1, 'manifest should have at least 1 snapshot');
});

test('saves with custom analyses', () => {
  const result = saveSnapshot(APP_FIXTURE, TEMP_WORKSPACE, 'custom-analyses', ['tree', 'complexity']);
  assert(result.analysesIncluded.includes('tree'), 'should include tree');
  assert(result.analysesIncluded.includes('complexity'), 'should include complexity');
});

test('saves with default label from filename', () => {
  const result = saveSnapshot(APP_FIXTURE, TEMP_WORKSPACE);
  assert(result.label === 'App', `default label should be "App", got "${result.label}"`);
});

test('saves multiple snapshots', () => {
  saveSnapshot(APP_FIXTURE, TEMP_WORKSPACE, 'snapshot-a');
  saveSnapshot(HEADER_FIXTURE, TEMP_WORKSPACE, 'snapshot-b');
  const list = listSnapshots(TEMP_WORKSPACE);
  // At least the 2 we just saved + previous ones in this test run
  assert(list.count >= 2, `should have >= 2 snapshots, got ${list.count}`);
});

test('handles missing entry file gracefully', () => {
  const result = saveSnapshot('/nonexistent/file.tsx', TEMP_WORKSPACE, 'bad-file');
  // Should still save (exportJson handles errors internally)
  assert(result.id, 'should still have an id');
});

// ============================================================================
// 3. List Snapshots
// ============================================================================
console.log('\n📋 List Snapshots');

test('lists saved snapshots', () => {
  const result = listSnapshots(TEMP_WORKSPACE);
  assert(result.count >= 1, `should have >= 1 snapshot, got ${result.count}`);
  assert(Array.isArray(result.snapshots), 'snapshots should be an array');
});

test('snapshot metadata has required fields', () => {
  const result = listSnapshots(TEMP_WORKSPACE);
  const snap = result.snapshots[0];
  assert(snap.id, 'should have id');
  assert(snap.label, 'should have label');
  assert(snap.timestamp, 'should have timestamp');
  assert(snap.entryFile, 'should have entryFile');
  assert(snap.fileName, 'should have fileName');
  assert(Array.isArray(snap.analysesIncluded), 'should have analysesIncluded array');
});

test('lists empty when no snapshots exist', () => {
  const emptyWorkspace = path.join(os.tmpdir(), `dendro-empty-${Date.now()}`);
  const result = listSnapshots(emptyWorkspace);
  assert(result.count === 0, `expected 0 snapshots, got ${result.count}`);
  assert(result.snapshots.length === 0, 'should have empty array');
  // Cleanup
  try { fs.rmSync(emptyWorkspace, { recursive: true, force: true }); } catch {}
});

test('filters out deleted snapshot files', () => {
  // Save a snapshot then manually delete its file
  const snap = saveSnapshot(APP_FIXTURE, TEMP_WORKSPACE, 'to-delete');
  const snapFile = snap.path;
  assert(fs.existsSync(snapFile), 'snapshot file should exist');
  fs.unlinkSync(snapFile);

  const result = listSnapshots(TEMP_WORKSPACE);
  const ids = result.snapshots.map(s => s.id);
  assert(!ids.includes(snap.id), 'deleted snapshot should not appear in list');
});

// ============================================================================
// 4. Load Snapshot (internal helper)
// ============================================================================
console.log('\n📂 Load Snapshot');

test('loads saved snapshot by id', () => {
  const saved = saveSnapshot(APP_FIXTURE, TEMP_WORKSPACE, 'loadable');
  const loaded = loadSnapshot(TEMP_WORKSPACE, saved.id);
  assert(loaded !== null, 'should load snapshot');
  assert(loaded.metadata.id === saved.id, 'id should match');
  assert(loaded.result.metadata, 'should have result metadata');
  assert(loaded.result.tree || loaded.result.complexity, 'should have analysis data');
});

test('returns null for nonexistent snapshot', () => {
  const loaded = loadSnapshot(TEMP_WORKSPACE, 'nonexistent-id');
  assert(loaded === null, 'should return null for nonexistent id');
});

// ============================================================================
// 5. Compare Snapshots
// ============================================================================
console.log('\n🔀 Compare Snapshots');

const { compareSnapshots } = require(path.join(ROOT, 'out/mcp/pro-tools/snapshot-compare'));

test('compares two saved snapshots', () => {
  const snap1 = saveSnapshot(APP_FIXTURE, TEMP_WORKSPACE, 'compare-base');
  const snap2 = saveSnapshot(APP_FIXTURE, TEMP_WORKSPACE, 'compare-target');

  const result = compareSnapshots(TEMP_WORKSPACE, snap1.id, snap2.id);
  assert(!result.error, `unexpected error: ${result.error}`);
  assert(result.base.id === snap1.id, 'base id should match');
  assert(result.target.id === snap2.id, 'target id should match');
  assert(result.tree, 'should have tree comparison');
  assert(result.complexity, 'should have complexity comparison');
  assert(result.context, 'should have context comparison');
  assert(result.summary, 'should have summary string');
});

test('compares snapshot vs current', () => {
  const snap = saveSnapshot(APP_FIXTURE, TEMP_WORKSPACE, 'vs-current');

  const result = compareSnapshots(TEMP_WORKSPACE, snap.id, 'current', APP_FIXTURE);
  assert(!result.error, `unexpected error: ${result.error}`);
  assert(result.base.id === snap.id, 'base should be snapshot');
  assert(result.target.id === 'current', 'target should be "current"');
  assert(result.summary.includes('Current'), 'summary should mention "Current"');
});

test('compares current vs snapshot', () => {
  const snap = saveSnapshot(APP_FIXTURE, TEMP_WORKSPACE, 'current-vs');

  const result = compareSnapshots(TEMP_WORKSPACE, 'current', snap.id, APP_FIXTURE);
  assert(!result.error, `unexpected error: ${result.error}`);
  assert(result.base.id === 'current', 'base should be "current"');
  assert(result.target.id === snap.id, 'target should be snapshot');
});

test('requires entryFile when using current', () => {
  const snap = saveSnapshot(APP_FIXTURE, TEMP_WORKSPACE, 'needs-entry');

  const result = compareSnapshots(TEMP_WORKSPACE, snap.id, 'current');
  assert(result.error, 'should error when entryFile missing for "current"');
  assert(result.error.includes('entryFile'), 'error should mention entryFile');
});

test('errors for nonexistent snapshot id', () => {
  const result = compareSnapshots(TEMP_WORKSPACE, 'fake-id', 'also-fake');
  assert(result.error, 'should error for nonexistent snapshot');
});

test('same-snapshot comparison shows no changes', () => {
  const snap = saveSnapshot(APP_FIXTURE, TEMP_WORKSPACE, 'same-twice');

  const result = compareSnapshots(TEMP_WORKSPACE, snap.id, snap.id);
  assert(!result.error, `unexpected error: ${result.error}`);
  assert(result.tree.added.length === 0, 'no files should be added');
  assert(result.tree.removed.length === 0, 'no files should be removed');
  assert(result.tree.delta === 0, 'delta should be 0');
  assert(result.complexity.improved.length === 0, 'no improved');
  assert(result.complexity.degraded.length === 0, 'no degraded');
});

test('compares different entry files and detects differences', () => {
  const STANDALONE = path.join(FIXTURES, 'Standalone.tsx');
  const snap1 = saveSnapshot(APP_FIXTURE, TEMP_WORKSPACE, 'app-snap', ['tree', 'complexity']);
  const snap2 = saveSnapshot(STANDALONE, TEMP_WORKSPACE, 'standalone-snap', ['tree', 'complexity']);

  const result = compareSnapshots(TEMP_WORKSPACE, snap1.id, snap2.id);
  assert(!result.error, `unexpected error: ${result.error}`);
  // App has many components, Standalone has just one — should see removals
  const hasDifferences = result.tree.added.length > 0 || result.tree.removed.length > 0 || result.tree.delta !== 0;
  assert(hasDifferences, 'should detect differences between App and Standalone trees');
});

test('summary is human-readable', () => {
  const snap1 = saveSnapshot(APP_FIXTURE, TEMP_WORKSPACE, 'summary-base');
  const snap2 = saveSnapshot(APP_FIXTURE, TEMP_WORKSPACE, 'summary-target');

  const result = compareSnapshots(TEMP_WORKSPACE, snap1.id, snap2.id);
  assert(result.summary.includes('summary-base'), 'summary should mention base label');
  assert(result.summary.includes('summary-target'), 'summary should mention target label');
});

// Restore workspace root after snapshot tests
process.env.DENDRO_WORKSPACE_ROOT = ROOT;
initWorkspaceRoot();

// ============================================================================
// 6. Pro Feature Gating — New Tools
// ============================================================================
console.log('\n🔒 Pro Feature Gating — New Tools');

const { isProFeature, getFeatureTier, getProFeatureList } = require(path.join(ROOT, 'out/licensing/feature-gate'));

test('batch_analysis is pro', () => {
  assert(isProFeature('batch_analysis'), 'batch_analysis should be pro');
  assert(getFeatureTier('batch_analysis') === 'pro', 'tier should be pro');
});

test('manage_snapshots is pro', () => {
  assert(isProFeature('manage_snapshots'), 'manage_snapshots should be pro');
});

test('pro list includes consolidated tools', () => {
  const proList = getProFeatureList();
  assert(proList.includes('batch_analysis'), 'missing batch_analysis');
  assert(proList.includes('manage_snapshots'), 'missing manage_snapshots');
});

test('old ext. prefixed entries are removed', () => {
  assert(!isProFeature('ext.batch_analysis'), 'ext.batch_analysis should not exist (defaults to free)');
  assert(!isProFeature('ext.historical_comparison'), 'ext.historical_comparison should not exist');
  assert(!isProFeature('ext.save_analysis_config'), 'ext.save_analysis_config should not exist');
});

test('gating blocks new tools when unlicensed', () => {
  // Ensure no license file
  const backup = LICENSE_FILE + '.backup';
  let hadFile = false;
  if (fs.existsSync(LICENSE_FILE)) {
    fs.renameSync(LICENSE_FILE, backup);
    hadFile = true;
  }
  try {
    delete require.cache[require.resolve(path.join(ROOT, 'out/licensing/license-file'))];
    const { isProLicensed } = require(path.join(ROOT, 'out/licensing/license-file'));
    assert(!isProLicensed(), 'should be unlicensed');

    const gatedBatch = isProFeature('batch_analysis') && !isProLicensed();
    const gatedSnapshots = isProFeature('manage_snapshots') && !isProLicensed();

    assert(gatedBatch, 'batch_analysis should be gated');
    assert(gatedSnapshots, 'manage_snapshots should be gated');
  } finally {
    if (hadFile) fs.renameSync(backup, LICENSE_FILE);
  }
});

test('gating allows new tools when licensed', () => {
  const backup = LICENSE_FILE + '.backup';
  const secretBackup = LICENSE_SECRET_PATH + '.backup';
  let hadFile = false;
  let hadSecret = false;
  if (fs.existsSync(LICENSE_FILE)) {
    fs.renameSync(LICENSE_FILE, backup);
    hadFile = true;
  }
  if (fs.existsSync(LICENSE_SECRET_PATH)) {
    fs.renameSync(LICENSE_SECRET_PATH, secretBackup);
    hadSecret = true;
  }
  try {
    writeSignedLicense(true, Date.now() + 86400000);
    delete require.cache[require.resolve(path.join(ROOT, 'out/licensing/license-file'))];
    const { isProLicensed } = require(path.join(ROOT, 'out/licensing/license-file'));
    assert(isProLicensed(), 'should be licensed');

    const gatedBatch = isProFeature('batch_analysis') && !isProLicensed();
    assert(!gatedBatch, 'batch_analysis should NOT be gated when licensed');
  } finally {
    cleanupLicense();
    if (hadFile) fs.renameSync(backup, LICENSE_FILE);
    if (hadSecret) fs.renameSync(secretBackup, LICENSE_SECRET_PATH);
  }
});

// ============================================================================
// Cleanup & Summary
// ============================================================================
cleanup();

console.log('\n' + '='.repeat(50));
console.log(`  ${passed + failed} tests | ${passed} passed | ${failed} failed`);
console.log('='.repeat(50));

if (failed > 0) {
  process.exit(1);
}
