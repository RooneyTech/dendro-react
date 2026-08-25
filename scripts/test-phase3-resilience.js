#!/usr/bin/env node

// Hermetic IPC: a VS Code extension host leaks DENDRO_WORKSPACE_HASH into any
// terminal or agent it spawns, which redirects runtime-state reads to a
// per-workspace dir while these tests write the global fallback path — every
// state-dependent assertion then fails. Scrub it so results don't depend on
// where the test runner was launched from.
delete process.env.DENDRO_WORKSPACE_HASH;

/**
 * Phase 3: Cross-Platform & Connection Resilience Test Suite
 *
 * Tests:
 * 1. Android emulator support (ADB reverse)
 * 2. Connection resilience (heartbeat, auto-restart, backoff)
 * 3. VP <-> TP integration (verify param)
 * 4. Verification badges (sidebar tree items)
 * 5. VS Code settings (platform, port)
 *
 * Run: node scripts/test-phase3-resilience.js
 */

const path = require('path');
const fs = require('fs');

// Load compiled modules
const {
  DevToolsConnector,
} = require('../out/runtime/devtools-connector');
const {
  projectFromRuntime,
  resetSnapshot,
} = require('../out/mcp/pro-tools/triggered-projection');
const { isProFeature } = require('../out/licensing/feature-gate');

let passed = 0;
let failed = 0;

function assert(condition, testName) {
  if (condition) {
    console.log(`  \u2705 ${testName}`);
    passed++;
  } else {
    console.log(`  \u274c ${testName}`);
    failed++;
  }
}

function makeElement(id, displayName, type, parentId, children, depth) {
  return {
    id,
    displayName,
    type: type || 'function',
    key: null,
    parentId: parentId !== undefined ? parentId : null,
    children: children || [],
    depth: depth || 0,
  };
}

function makeSnapshot(status, elements, sourceMap, roots) {
  return {
    status: status || 'connected',
    timestamp: Date.now(),
    componentCount: elements.length,
    roots: roots || [1],
    elements,
    sourceMap: sourceMap || {},
  };
}

// Helper to temporarily write runtime state for TP tests
function withRuntimeState(fn) {
  const dendroDir = path.join(require('os').homedir(), '.dendro');
  const stateFile = path.join(dendroDir, 'runtime-state.json');
  const existingState = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8') : null;

  try {
    if (!fs.existsSync(dendroDir)) fs.mkdirSync(dendroDir, { recursive: true });
    fn(stateFile);
  } finally {
    if (existingState) {
      fs.writeFileSync(stateFile, existingState);
    } else if (fs.existsSync(stateFile)) {
      fs.unlinkSync(stateFile);
    }
    resetSnapshot();
  }
}

async function main() {
  // ============================================================================
  // Section 1: DevToolsConnector — Constructor & Config
  // ============================================================================

  console.log('\n--- Section 1: DevToolsConnector Constructor & Config ---');

  {
    const connector = new DevToolsConnector();
    assert(connector.status === 'disconnected', 'Default status is disconnected');

    const customConnector = new DevToolsConnector({ port: 9097, host: '0.0.0.0' });
    assert(customConnector.status === 'disconnected', 'Custom config connector starts disconnected');
  }

  // ============================================================================
  // Section 2: ADB Reverse Methods
  // ============================================================================

  console.log('\n--- Section 2: ADB Reverse Methods ---');

  {
    const connector = new DevToolsConnector();

    const result = await connector.setupAdbReverse(true);
    assert(typeof result === 'boolean', 'setupAdbReverse(silent=true) returns boolean');

    await connector.removeAdbReverse();
    assert(true, 'removeAdbReverse does not throw when no tunnel exists');

    const result2 = await connector.setupAdbReverse(true);
    assert(typeof result2 === 'boolean', 'Second setupAdbReverse call returns boolean');
  }

  // ============================================================================
  // Section 3: Connection Resilience — Stop Cleanup
  // ============================================================================

  console.log('\n--- Section 3: Connection Resilience — Stop & Cleanup ---');

  {
    const connector = new DevToolsConnector({ port: 19097 });

    await connector.stop();
    assert(connector.status === 'disconnected', 'Stop sets status to disconnected');

    await connector.stop();
    assert(connector.status === 'disconnected', 'Double stop is safe');
  }

  // ============================================================================
  // Section 4: Heartbeat & Method Existence
  // ============================================================================

  console.log('\n--- Section 4: Heartbeat & Method Existence ---');

  {
    const connector = new DevToolsConnector();
    assert(typeof connector.start === 'function', 'start() method exists');
    assert(typeof connector.stop === 'function', 'stop() method exists');
    assert(typeof connector.setupAdbReverse === 'function', 'setupAdbReverse() method exists');
    assert(typeof connector.removeAdbReverse === 'function', 'removeAdbReverse() method exists');
    assert(typeof connector.inspectElement === 'function', 'inspectElement() method exists');
    assert(typeof connector.getAllComponents === 'function', 'getAllComponents() method exists');
    assert(typeof connector.getComponent === 'function', 'getComponent() method exists');
    assert(typeof connector.getTreeHierarchy === 'function', 'getTreeHierarchy() method exists');
  }

  // ============================================================================
  // Section 5: VP <-> TP Integration — Verify Param
  // ============================================================================

  console.log('\n--- Section 5: VP <-> TP Integration ---');

  // 5a: verify=true with no changes
  withRuntimeState((stateFile) => {
    const snap1 = makeSnapshot('connected', [
      makeElement(1, 'Root', 'other', null, [2], 0),
      makeElement(2, 'App', 'function', 1, [3], 1),
      makeElement(3, 'Header', 'function', 2, [], 2),
    ], {}, [1]);

    fs.writeFileSync(stateFile, JSON.stringify(snap1));
    const r1 = projectFromRuntime({ entryFile: '/tmp/App.tsx', verify: true });
    assert(r1.summary.includes('Baseline'), 'Baseline captured with verify=true');

    const r2 = projectFromRuntime({ entryFile: '/tmp/App.tsx', verify: true });
    assert(r2.changes.length === 0, 'No changes detected on identical snapshot');
    assert(r2.verification === undefined, 'No verification when no changes');
  });

  // 5b: verify=true with changes
  withRuntimeState((stateFile) => {
    const snap1 = makeSnapshot('connected', [
      makeElement(1, 'Root', 'other', null, [2], 0),
      makeElement(2, 'App', 'function', 1, [3], 1),
      makeElement(3, 'Header', 'function', 2, [], 2),
    ], {}, [1]);

    fs.writeFileSync(stateFile, JSON.stringify(snap1));
    projectFromRuntime({ entryFile: '/tmp/App.tsx' });

    const snap2 = makeSnapshot('connected', [
      makeElement(1, 'Root', 'other', null, [2], 0),
      makeElement(2, 'App', 'function', 1, [3, 4], 1),
      makeElement(3, 'Header', 'function', 2, [], 2),
      makeElement(4, 'Footer', 'function', 2, [], 2),
    ], {}, [1]);

    fs.writeFileSync(stateFile, JSON.stringify(snap2));
    const r2 = projectFromRuntime({ entryFile: '/tmp/App.tsx', verify: true });
    assert(r2.changes.length > 0, 'Changes detected on modified snapshot');
    assert(true, 'verify=true does not crash on changes');
  });

  // ============================================================================
  // Section 6: Feature Gating
  // ============================================================================

  console.log('\n--- Section 6: Feature Gating ---');

  assert(isProFeature('trigger_projection') === true, 'trigger_projection is Pro-gated');
  assert(isProFeature('inspect_live_component') === true, 'inspect_live_component is Pro-gated');
  assert(isProFeature('manage_snapshots') === true, 'manage_snapshots is Pro-gated');
  assert(isProFeature('find_state_owner') === true, 'find_state_owner is Pro-gated');

  // ============================================================================
  // Section 7: VS Code Settings Schema
  // ============================================================================

  console.log('\n--- Section 7: Settings Schema ---');

  {
    const packageJson = require('../package.json');
    const config = packageJson.contributes?.configuration;

    assert(config !== undefined, 'package.json has configuration section');
    assert(config.properties !== undefined, 'Configuration has properties');

    const platformSetting = config.properties?.['dendro-react.runtimePlatform'];
    assert(platformSetting !== undefined, 'dendro-react.runtimePlatform setting exists');
    assert(platformSetting.default === 'auto', 'runtimePlatform default is auto');
    assert(platformSetting.enum.includes('ios'), 'runtimePlatform includes ios option');
    assert(platformSetting.enum.includes('android'), 'runtimePlatform includes android option');
    assert(platformSetting.enum.includes('auto'), 'runtimePlatform includes auto option');

    const portSetting = config.properties?.['dendro-react.runtimePort'];
    assert(portSetting !== undefined, 'dendro-react.runtimePort setting exists');
    assert(portSetting.default === 8097, 'runtimePort default is 8097');
    assert(portSetting.type === 'number', 'runtimePort type is number');
  }

  // ============================================================================
  // Section 8: Verification Badge Types (source-level validation)
  // ============================================================================

  console.log('\n--- Section 8: Verification Badge Types ---');

  {
    const tvpSource = fs.readFileSync(
      path.join(__dirname, '../out/server/tree-view-provider.js'),
      'utf8'
    );

    assert(tvpSource.includes('verificationStatus'), 'tree-view-provider includes verificationStatus field');
    assert(tvpSource.includes('verificationMap'), 'tree-view-provider includes verificationMap');
    assert(tvpSource.includes('setVerificationResults'), 'tree-view-provider exports setVerificationResults');
    assert(tvpSource.includes('clearVerificationResults'), 'tree-view-provider exports clearVerificationResults');
    assert(tvpSource.includes('errorForeground'), 'tree-view-provider uses error color for failed');
    assert(tvpSource.includes('editorWarning.foreground'), 'tree-view-provider uses warning color for inconclusive');
  }

  // ============================================================================
  // Section 9: Connector Server Lifecycle
  // ============================================================================

  console.log('\n--- Section 9: Connector Server Lifecycle ---');

  {
    // Helper: wait for connector to reach a given status (with timeout)
    function waitForStatus(conn, target, ms = 3000) {
      return new Promise((resolve, reject) => {
        if (conn.status === target) return resolve();
        const timeout = setTimeout(() => reject(new Error(`Timed out waiting for status "${target}", current: "${conn.status}"`)), ms);
        conn.on('status-change', function handler(s) {
          if (s === target) {
            clearTimeout(timeout);
            conn.removeListener('status-change', handler);
            resolve();
          }
        });
      });
    }

    const connector = new DevToolsConnector({ port: 19098 });
    assert(connector.status === 'disconnected', 'Starts disconnected');

    await connector.start();
    await waitForStatus(connector, 'listening');
    assert(connector.status === 'listening', 'After start, status is listening');

    await connector.stop();
    assert(connector.status === 'disconnected', 'After stop, status is disconnected');

    await connector.start();
    await waitForStatus(connector, 'listening');
    assert(connector.status === 'listening', 'Can restart after stop');
    await connector.stop();
    assert(connector.status === 'disconnected', 'Clean stop after restart');
  }

  // ============================================================================
  // Section 10: TP verify=false (default) doesn't run VP
  // ============================================================================

  console.log('\n--- Section 10: TP Default (No Verification) ---');

  withRuntimeState((stateFile) => {
    const snap1 = makeSnapshot('connected', [
      makeElement(1, 'Root', 'other', null, [2], 0),
      makeElement(2, 'App', 'function', 1, [], 1),
    ], {}, [1]);

    const snap2 = makeSnapshot('connected', [
      makeElement(1, 'Root', 'other', null, [2], 0),
      makeElement(2, 'App', 'function', 1, [3], 1),
      makeElement(3, 'New', 'function', 2, [], 2),
    ], {}, [1]);

    fs.writeFileSync(stateFile, JSON.stringify(snap1));
    projectFromRuntime({ entryFile: '/tmp/App.tsx' });
    fs.writeFileSync(stateFile, JSON.stringify(snap2));

    const r = projectFromRuntime({ entryFile: '/tmp/App.tsx' });
    assert(r.verification === undefined, 'verify=undefined does not include verification');
    assert(r.changes.length > 0, 'Changes still detected without verify');
  });

  withRuntimeState((stateFile) => {
    const snap1 = makeSnapshot('connected', [
      makeElement(1, 'Root', 'other', null, [2], 0),
      makeElement(2, 'App', 'function', 1, [], 1),
    ], {}, [1]);

    const snap2 = makeSnapshot('connected', [
      makeElement(1, 'Root', 'other', null, [2], 0),
      makeElement(2, 'App', 'function', 1, [3], 1),
      makeElement(3, 'New', 'function', 2, [], 2),
    ], {}, [1]);

    fs.writeFileSync(stateFile, JSON.stringify(snap1));
    projectFromRuntime({ entryFile: '/tmp/App.tsx' });
    fs.writeFileSync(stateFile, JSON.stringify(snap2));

    const r2 = projectFromRuntime({ entryFile: '/tmp/App.tsx', verify: false });
    assert(r2.verification === undefined, 'verify=false does not include verification');
  });

  // ============================================================================
  // Summary
  // ============================================================================

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Phase 3 Resilience Tests: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log('='.repeat(60));
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
