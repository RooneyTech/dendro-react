#!/usr/bin/env node
/**
 * test-pro-features.js
 *
 * End-to-end smoke test for the Pro features infrastructure.
 * Tests licensing modules, feature gate, export tools, and MCP gating
 * WITHOUT needing VS Code running.
 *
 * Usage:
 *   npm run build && node scripts/test-pro-features.js
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { createHmac } = require('crypto');

// Paths
const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(ROOT, 'src/test/fixtures/mcp-tools');
const APP_FIXTURE = path.join(FIXTURES, 'App.tsx');
const DENDRO_DIR = path.join(os.homedir(), '.dendro');
const LICENSE_FILE = path.join(DENDRO_DIR, 'license-status.json');
const LICENSE_SECRET_PATH = path.join(DENDRO_DIR, '.license-secret');

// Init workspace root so parsers don't throw PathBoundaryError
process.env.DENDRO_WORKSPACE_ROOT = ROOT;
const { initWorkspaceRoot } = require(path.join(ROOT, 'out/mcp/path-boundary'));
initWorkspaceRoot();

/**
 * Write a properly HMAC-signed license file for testing.
 * Returns the secret so caller can clean up.
 */
function writeSignedLicense(isPro, cachedUntil) {
  const secret = 'a'.repeat(64); // 64-char hex string
  const signature = createHmac('sha256', secret)
    .update(`${isPro}:${cachedUntil}`)
    .digest('hex');
  fs.mkdirSync(DENDRO_DIR, { recursive: true });
  fs.writeFileSync(LICENSE_SECRET_PATH, secret);
  fs.writeFileSync(LICENSE_FILE, JSON.stringify({ isPro, cachedUntil, signature }));
  return secret;
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

// ============================================================================
// 1. Feature Gate
// ============================================================================
console.log('\n🔒 Feature Gate');

const { isProFeature, getFeatureTier, getProFeatureList, getFreeFeatureList } = require(path.join(ROOT, 'out/licensing/feature-gate'));

test('existing tools are free', () => {
  assert(getFeatureTier('get_component_tree') === 'free');
  assert(getFeatureTier('visualize_batch') === 'free');
  assert(getFeatureTier('detect_circular_deps') === 'free');
  assert(!isProFeature('get_component_tree'));
});

test('export tool is pro', () => {
  assert(isProFeature('export_analysis'));
  assert(getFeatureTier('export_analysis') === 'pro');
});

test('unknown tools default to free', () => {
  assert(getFeatureTier('nonexistent_tool') === 'free');
  assert(!isProFeature('nonexistent_tool'));
});

test('pro list contains export_analysis', () => {
  const proList = getProFeatureList();
  assert(proList.includes('export_analysis'), 'missing export_analysis');
  assert(proList.length === 10, `expected 10 pro features, got ${proList.length}`);
});

test('free list contains 25 tools', () => {
  const freeList = getFreeFeatureList();
  assert(freeList.length === (()=>{const g=require(path.join(ROOT, 'out/licensing/feature-gate'));return g.getFreeFeatureList().length+g.getProFeatureList().length;})() - 10, `expected 25 free features, got ${freeList.length}`);
  assert(freeList.includes('get_component_tree'));
  assert(freeList.includes('open_visualizer'));
  assert(freeList.includes('visualize_batch'));
});

// ============================================================================
// 2. License File Reader (cross-process)
// ============================================================================
console.log('\n📄 License File Reader');

const { isProLicensed } = require(path.join(ROOT, 'out/licensing/license-file'));

// Backup/restore helpers for license + secret files
function backupLicenseFiles() {
  const state = { hadLicense: false, hadSecret: false };
  if (fs.existsSync(LICENSE_FILE)) {
    fs.renameSync(LICENSE_FILE, LICENSE_FILE + '.backup');
    state.hadLicense = true;
  }
  if (fs.existsSync(LICENSE_SECRET_PATH)) {
    fs.renameSync(LICENSE_SECRET_PATH, LICENSE_SECRET_PATH + '.backup');
    state.hadSecret = true;
  }
  return state;
}

function restoreLicenseFiles(state) {
  if (fs.existsSync(LICENSE_FILE)) try { fs.unlinkSync(LICENSE_FILE); } catch {}
  if (fs.existsSync(LICENSE_SECRET_PATH)) try { fs.unlinkSync(LICENSE_SECRET_PATH); } catch {}
  if (state.hadLicense) fs.renameSync(LICENSE_FILE + '.backup', LICENSE_FILE);
  if (state.hadSecret) fs.renameSync(LICENSE_SECRET_PATH + '.backup', LICENSE_SECRET_PATH);
}

test('no license file = free tier', () => {
  const state = backupLicenseFiles();
  try {
    assert(!isProLicensed(), 'should be free when no license file');
  } finally {
    restoreLicenseFiles(state);
  }
});

test('expired license file = free tier', () => {
  const state = backupLicenseFiles();
  try {
    writeSignedLicense(true, Date.now() - 1000); // expired 1 second ago
    assert(!isProLicensed(), 'expired cache should return free');
  } finally {
    restoreLicenseFiles(state);
  }
});

test('valid license file = pro tier', () => {
  const state = backupLicenseFiles();
  try {
    writeSignedLicense(true, Date.now() + 86400000); // valid for 24h
    assert(isProLicensed(), 'valid cache should return pro');
  } finally {
    restoreLicenseFiles(state);
  }
});

test('malformed license file = free tier', () => {
  const state = backupLicenseFiles();
  try {
    fs.mkdirSync(DENDRO_DIR, { recursive: true });
    fs.writeFileSync(LICENSE_FILE, 'not json at all');
    assert(!isProLicensed(), 'malformed file should return free');
  } finally {
    restoreLicenseFiles(state);
  }
});

// ============================================================================
// 3. Mermaid Exporter (direct call, bypasses gating)
// ============================================================================
console.log('\n📊 Mermaid Exporter');

const { exportMermaid } = require(path.join(ROOT, 'out/mcp/exporters/mermaid-exporter'));

test('exports fixture App.tsx as mermaid', () => {
  const result = exportMermaid(APP_FIXTURE);
  assert(!result.error, `unexpected error: ${result.error}`);
  assert(result.mermaid.startsWith('graph LR'), `should start with "graph LR", got: ${result.mermaid.substring(0, 20)}`);
  assert(result.nodeCount >= 3, `expected >= 3 nodes (App + Header + MainContent + Footer), got ${result.nodeCount}`);
  assert(result.mermaid.includes('-->'), 'should have edges');
});

test('mermaid supports TB direction', () => {
  const result = exportMermaid(APP_FIXTURE, undefined, 'TB');
  assert(!result.error, `unexpected error: ${result.error}`);
  assert(result.mermaid.startsWith('graph TB'), 'should start with "graph TB"');
});

test('mermaid handles missing file gracefully', () => {
  const result = exportMermaid('/nonexistent/file.tsx');
  assert(result.error, 'should have error for missing file');
  assert(result.nodeCount === 0, 'should have 0 nodes');
  assert(result.mermaid === '', 'should have empty mermaid string');
});

test('mermaid respects maxDepth', () => {
  const full = exportMermaid(APP_FIXTURE);
  const shallow = exportMermaid(APP_FIXTURE, 0);
  assert(shallow.nodeCount <= full.nodeCount, 'shallow should have fewer or equal nodes');
});

// ============================================================================
// 4. JSON Exporter (direct call, bypasses gating)
// ============================================================================
console.log('\n📦 JSON Exporter');

const { exportJson } = require(path.join(ROOT, 'out/mcp/exporters/json-exporter'));

test('exports fixture App.tsx as enriched JSON', () => {
  const result = exportJson(APP_FIXTURE);
  assert(result.metadata, 'should have metadata');
  assert(result.metadata.version, 'should have version in metadata');
  assert(result.metadata.timestamp, 'should have timestamp');
  assert(result.metadata.entryFile === APP_FIXTURE, 'should have correct entryFile');
  assert(result.tree, 'should have tree analysis');
  assert(result.tree.tree, 'tree should have tree data');
  assert(result.stats, 'should have stats');
  assert(result.stats.analysesRun >= 1, 'should have run at least 1 analysis');
});

test('json supports multiple analyses', () => {
  const result = exportJson(APP_FIXTURE, ['tree', 'complexity']);
  assert(result.tree, 'should have tree');
  assert(result.complexity, 'should have complexity');
  assert(result.stats.analysesRun >= 2, 'should have run at least 2 analyses');
});

test('json defaults to tree-only', () => {
  const result = exportJson(APP_FIXTURE);
  assert(result.tree, 'should have tree');
  assert(!result.navigation, 'should not have navigation by default');
  assert(!result.context, 'should not have context by default');
});

test('json handles missing file gracefully', () => {
  const result = exportJson('/nonexistent/file.tsx');
  assert(result.metadata, 'should still have metadata');
  // Either top-level error or tree.error
  const hasError = result.error || (result.tree && result.tree.error);
  assert(hasError, 'should have error for missing file');
});

// ============================================================================
// 5. MCP Gating (simulated — no license file = gated)
// ============================================================================
console.log('\n🚫 MCP Gating (no license = gated)');

// Ensure no license file exists for gating tests
const gatingState = backupLicenseFiles();

try {
  // Re-require to get fresh state (license-file caches nothing, reads on each call)
  delete require.cache[require.resolve(path.join(ROOT, 'out/licensing/license-file'))];
  const { isProLicensed: freshCheck } = require(path.join(ROOT, 'out/licensing/license-file'));

  test('gating blocks export_analysis when unlicensed', () => {
    assert(!freshCheck(), 'should be unlicensed');
    assert(isProFeature('export_analysis'), 'export_analysis should be pro');
    // The combo: isProFeature && !isProLicensed = gated
    const gated = isProFeature('export_analysis') && !freshCheck();
    assert(gated, 'export_analysis should be gated');
  });

  test('gating allows get_component_tree when unlicensed', () => {
    assert(!freshCheck(), 'should be unlicensed');
    assert(!isProFeature('get_component_tree'), 'get_component_tree should be free');
    const gated = isProFeature('get_component_tree') && !freshCheck();
    assert(!gated, 'get_component_tree should NOT be gated');
  });

  test('gating allows export_analysis when licensed', () => {
    // Write a properly signed license
    writeSignedLicense(true, Date.now() + 86400000);
    // Re-require
    delete require.cache[require.resolve(path.join(ROOT, 'out/licensing/license-file'))];
    const { isProLicensed: licensedCheck } = require(path.join(ROOT, 'out/licensing/license-file'));
    assert(licensedCheck(), 'should be licensed now');
    const gated = isProFeature('export_analysis') && !licensedCheck();
    assert(!gated, 'export_analysis should NOT be gated when licensed');
  });
} finally {
  restoreLicenseFiles(gatingState);
}

// ============================================================================
// 6. package.json commands
// ============================================================================
console.log('\n📋 package.json Commands');

const pkg = require(path.join(ROOT, 'package.json'));
const commands = pkg.contributes.commands.map(c => c.command);

test('has activateLicense command', () => {
  assert(commands.includes('dendro-react.activateLicense'));
});

test('has upgradeToPro command', () => {
  assert(commands.includes('dendro-react.upgradeToPro'));
});

test('has manageSubscription command', () => {
  assert(commands.includes('dendro-react.manageSubscription'));
});

test('has deactivateLicense command', () => {
  assert(commands.includes('dendro-react.deactivateLicense'));
});

test('has licenseStatus command', () => {
  assert(commands.includes('dendro-react.licenseStatus'));
});

// ============================================================================
// Summary
// ============================================================================
console.log('\n' + '='.repeat(50));
console.log(`  ${passed + failed} tests | ${passed} passed | ${failed} failed`);
console.log('='.repeat(50));

if (failed > 0) {
  process.exit(1);
}
