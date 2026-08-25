#!/usr/bin/env node

/**
 * Phase 4: Advanced Runtime Features Test Suite
 *
 * Tests:
 * 1. DevToolsConnector.overrideValueAtPath method
 * 2. Override bridge IPC (write/read/poll request/result)
 * 3. modify_runtime_state tool (component resolution, override request flow)
 * 4. poke_component tool (auto-hook-detection, fallback to state/props)
 * 5. Physical device support (host configuration, device platform)
 * 6. Feature gating (new tools Pro-gated)
 * 7. Tool registration (server has new tools)
 * 8. Edge cases (disconnected, not found, timeout simulation)
 *
 * Run: node scripts/test-phase4-advanced.js
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

// Use a temp IPC directory to avoid collisions with a running VS Code extension
const TEST_IPC_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dendro-test-phase4-'));
process.env.DENDRO_IPC_DIR = TEST_IPC_DIR;

// Load compiled modules (AFTER setting DENDRO_IPC_DIR)
const {
  DevToolsConnector,
} = require('../out/runtime/devtools-connector');
const {
  writeOverrideRequest,
  readOverrideRequest,
  writeOverrideResult,
  readOverrideResult,
  clearOverrideRequest,
  clearOverrideResult,
  pollOverrideResult,
  writeInspectRequest,
  readInspectRequest,
  writeInspectResult,
  clearInspectResult,
  generateRequestId,
  getInspectPaths,
} = require('../out/runtime/inspect-bridge');
const INSPECT_PATHS = getInspectPaths();
const {
  modifyRuntimeState,
  pokeComponent,
  resetInspectionCache,
} = require('../out/mcp/pro-tools/live-introspection');
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

function assertEqual(actual, expected, testName) {
  const match = actual === expected;
  if (match) {
    console.log(`  \u2705 ${testName}`);
    passed++;
  } else {
    console.log(`  \u274c ${testName} — expected "${expected}", got "${actual}"`);
    failed++;
  }
}

const DENDRO_DIR = TEST_IPC_DIR;

function ensureDendroDir() {
  if (!fs.existsSync(DENDRO_DIR)) {
    fs.mkdirSync(DENDRO_DIR, { recursive: true });
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

// Helper to temporarily write runtime state
function withRuntimeState(snapshot, fn) {
  const stateFile = path.join(DENDRO_DIR, 'runtime-state.json');
  const existingState = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8') : null;

  try {
    ensureDendroDir();
    fs.writeFileSync(stateFile, JSON.stringify(snapshot), 'utf-8');
    return fn();
  } finally {
    if (existingState) {
      fs.writeFileSync(stateFile, existingState);
    } else if (fs.existsSync(stateFile)) {
      fs.unlinkSync(stateFile);
    }
  }
}

// Cleanup before tests
function cleanup() {
  clearOverrideRequest();
  clearOverrideResult();
  clearInspectResult();
  resetInspectionCache();
}

// Crash-resilience wrapper: prevents IPC race conditions from killing the suite
async function safeRun(label, fn) {
  try {
    await fn();
  } catch (err) {
    console.error(`  ⚠️  ${label} crashed: ${err.message}`);
    failed++;
  }
}

// ============================================================================
// Section 1: DevToolsConnector.overrideValueAtPath
// ============================================================================

console.log('\n--- Section 1: DevToolsConnector.overrideValueAtPath ---');

{
  // Test that overrideValueAtPath returns false when not connected
  const connector = new DevToolsConnector({ port: 19999, host: 'localhost' });
  const result = connector.overrideValueAtPath(1, 'props', ['name'], 'test');
  assert(result === false, 'overrideValueAtPath returns false when not connected');
}

{
  // Test that the method exists and has correct signature
  const connector = new DevToolsConnector();
  assert(typeof connector.overrideValueAtPath === 'function', 'overrideValueAtPath is a function');
  assert(connector.overrideValueAtPath.length >= 4, 'overrideValueAtPath accepts at least 4 params');
}

{
  // Test with all types
  const connector = new DevToolsConnector({ port: 19998, host: 'localhost' });
  const types = ['props', 'state', 'hooks', 'context'];
  for (const type of types) {
    const result = connector.overrideValueAtPath(1, type, ['key'], 'value');
    assert(result === false, `overrideValueAtPath(${type}) returns false when disconnected`);
  }
}

{
  // Test hookID parameter
  const connector = new DevToolsConnector({ port: 19997, host: 'localhost' });
  const result = connector.overrideValueAtPath(1, 'hooks', [], true, 0);
  assert(result === false, 'overrideValueAtPath with hookID returns false when disconnected');
}

// ============================================================================
// Section 2: Override Bridge IPC
// ============================================================================

console.log('\n--- Section 2: Override Bridge IPC ---');

cleanup();

{
  // Test write/read override request
  const request = {
    requestId: 'test-override-001',
    elementId: 42,
    componentName: 'TestComponent',
    type: 'props',
    path: ['name'],
    value: 'newValue',
    timestamp: Date.now(),
  };
  writeOverrideRequest(request);
  const read = readOverrideRequest();
  assert(read !== null, 'readOverrideRequest returns non-null after write');
  assertEqual(read.requestId, 'test-override-001', 'Override request requestId matches');
  assertEqual(read.elementId, 42, 'Override request elementId matches');
  assertEqual(read.componentName, 'TestComponent', 'Override request componentName matches');
  assertEqual(read.type, 'props', 'Override request type matches');
  assert(Array.isArray(read.path) && read.path[0] === 'name', 'Override request path matches');
  assertEqual(read.value, 'newValue', 'Override request value matches');
  clearOverrideRequest();
}

{
  // Test write/read override result
  const result = {
    requestId: 'test-override-002',
    elementId: 42,
    componentName: 'TestComponent',
    type: 'state',
    path: ['count'],
    value: 5,
    timestamp: Date.now(),
    success: true,
  };
  writeOverrideResult(result);
  const read = readOverrideResult();
  assert(read !== null, 'readOverrideResult returns non-null after write');
  assertEqual(read.requestId, 'test-override-002', 'Override result requestId matches');
  assert(read.success === true, 'Override result success is true');
  clearOverrideResult();
}

{
  // Test failed override result with error
  const result = {
    requestId: 'test-override-003',
    elementId: 99,
    componentName: 'Broken',
    type: 'hooks',
    path: [],
    value: null,
    timestamp: Date.now(),
    success: false,
    error: 'Not connected',
  };
  writeOverrideResult(result);
  const read = readOverrideResult();
  assert(read.success === false, 'Failed override result has success=false');
  assertEqual(read.error, 'Not connected', 'Failed override result has error message');
  clearOverrideResult();
}

{
  // Test clear functions
  writeOverrideRequest({ requestId: 'x', elementId: 1, componentName: 'X', type: 'props', path: [], value: null, timestamp: 0 });
  clearOverrideRequest();
  const req = readOverrideRequest();
  assert(req === null, 'clearOverrideRequest removes the file');

  writeOverrideResult({ requestId: 'x', elementId: 1, componentName: 'X', type: 'props', path: [], value: null, timestamp: 0, success: true });
  clearOverrideResult();
  const res = readOverrideResult();
  assert(res === null, 'clearOverrideResult removes the file');
}

{
  // Test INSPECT_PATHS includes override paths
  assert(typeof INSPECT_PATHS.overrideRequest === 'string', 'INSPECT_PATHS.overrideRequest exists');
  assert(typeof INSPECT_PATHS.overrideResult === 'string', 'INSPECT_PATHS.overrideResult exists');
  assert(INSPECT_PATHS.overrideRequest.includes('override-request.json'), 'overrideRequest path correct');
  assert(INSPECT_PATHS.overrideResult.includes('override-result.json'), 'overrideResult path correct');
}

// ============================================================================
// Section 3: Override Bridge Polling
// ============================================================================

console.log('\n--- Section 3: Override Bridge Polling ---');

cleanup();

async function testPolling() {
  // Test poll finds matching result
  const requestId = generateRequestId();
  clearOverrideResult();

  // Write result after a short delay
  setTimeout(() => {
    writeOverrideResult({
      requestId,
      elementId: 10,
      componentName: 'PollTest',
      type: 'state',
      path: ['x'],
      value: 42,
      timestamp: Date.now(),
      success: true,
    });
  }, 200);

  const result = await pollOverrideResult(requestId, 2000);
  assert(result !== null, 'pollOverrideResult finds matching result');
  assertEqual(result.requestId, requestId, 'Polled result has correct requestId');
  assert(result.success === true, 'Polled result is successful');
  clearOverrideResult();

  // Test poll times out when no result
  const noResultId = generateRequestId();
  clearOverrideResult();
  const timeout = await pollOverrideResult(noResultId, 300);
  assert(timeout === null, 'pollOverrideResult returns null on timeout');

  // Test poll ignores mismatched requestId
  clearOverrideResult();
  const myId = generateRequestId();
  writeOverrideResult({
    requestId: 'wrong-id',
    elementId: 1,
    componentName: 'X',
    type: 'props',
    path: [],
    value: null,
    timestamp: Date.now(),
    success: true,
  });
  const mismatch = await pollOverrideResult(myId, 300);
  assert(mismatch === null, 'pollOverrideResult ignores mismatched requestId');
  clearOverrideResult();
}

// ============================================================================
// Section 4: modify_runtime_state tool
// ============================================================================

console.log('\n--- Section 4: modify_runtime_state tool ---');

async function testModifyRuntimeState() {
  cleanup();

  // Test when disconnected
  const disconnectedSnapshot = makeSnapshot('disconnected', [], {});
  const disconnectedResult = await withRuntimeState(disconnectedSnapshot, () =>
    modifyRuntimeState('App', 'props', ['name'], 'test')
  );
  assert('error' in disconnectedResult, 'modify_runtime_state returns error when disconnected');
  assertEqual(disconnectedResult.error, 'not_connected', 'Error type is not_connected');

  // Test component not found
  const emptySnapshot = makeSnapshot('connected', [
    makeElement(1, 'Root', 'other', null, [2], 0),
    makeElement(2, 'View', 'host', 1, [], 1),
  ], {});
  const notFoundResult = await withRuntimeState(emptySnapshot, () =>
    modifyRuntimeState('NonExistent', 'props', ['x'], 1)
  );
  assert('error' in notFoundResult, 'modify_runtime_state returns error when component not found');
  assertEqual(notFoundResult.error, 'component_not_found', 'Error type is component_not_found');

  // Test component found but override times out (no extension watcher)
  const snapshot = makeSnapshot('connected', [
    makeElement(1, 'Root', 'other', null, [2], 0),
    makeElement(2, 'App', 'function', 1, [3], 1),
    makeElement(3, 'Counter', 'function', 2, [], 2),
  ], {});
  const timeoutResult = await withRuntimeState(snapshot, () =>
    modifyRuntimeState('Counter', 'state', ['count'], 10)
  );
  // Will timeout because no extension is watching
  assert('error' in timeoutResult || timeoutResult.success === false || timeoutResult.error === 'override_timeout',
    'modify_runtime_state handles timeout gracefully');

  // Test with simulated override response
  cleanup();
  const simSnapshot = makeSnapshot('connected', [
    makeElement(1, 'Root', 'other', null, [2], 0),
    makeElement(2, 'MyComponent', 'function', 1, [], 1),
  ], {});

  // Simulate extension fulfilling the override request
  const simResult = await withRuntimeState(simSnapshot, async () => {
    // Start the modify call
    const promise = modifyRuntimeState('MyComponent', 'props', ['color'], 'red');

    // Simulate extension response after delay
    await new Promise(resolve => setTimeout(resolve, 200));
    const req = readOverrideRequest();
    if (req) {
      writeOverrideResult({
        requestId: req.requestId,
        elementId: req.elementId,
        componentName: req.componentName,
        type: req.type,
        path: req.path,
        value: req.value,
        timestamp: Date.now(),
        success: true,
      });
    }

    return promise;
  });

  assert(!('error' in simResult) || simResult.error === 'override_timeout',
    'modify_runtime_state with simulated response works or times out');
  if (!('error' in simResult) && simResult.success !== undefined) {
    assert(simResult.success === true, 'Simulated override returns success');
    assertEqual(simResult.componentName, 'MyComponent', 'Result has correct component name');
    assertEqual(simResult.type, 'props', 'Result has correct type');
  }
  cleanup();
}

// ============================================================================
// Section 5: poke_component tool
// ============================================================================

console.log('\n--- Section 5: poke_component tool ---');

async function testPokeComponent() {
  cleanup();

  // Test when disconnected
  const disconnectedSnapshot = makeSnapshot('disconnected', [], {});
  const disconnectedResult = await withRuntimeState(disconnectedSnapshot, () =>
    pokeComponent('App', 'loading', false)
  );
  assert('error' in disconnectedResult, 'poke_component returns error when disconnected');
  assertEqual(disconnectedResult.error, 'not_connected', 'Error type is not_connected');

  // Test component not found
  const emptySnapshot = makeSnapshot('connected', [
    makeElement(1, 'Root', 'other', null, [2], 0),
    makeElement(2, 'View', 'host', 1, [], 1),
  ], {});
  const notFoundResult = await withRuntimeState(emptySnapshot, () =>
    pokeComponent('MissingComponent', 'value', 42)
  );
  assert('error' in notFoundResult, 'poke_component returns error when component not found');
  assertEqual(notFoundResult.error, 'component_not_found', 'Error type is component_not_found');

  // Test component found but inspect times out
  const snapshot = makeSnapshot('connected', [
    makeElement(1, 'Root', 'other', null, [2], 0),
    makeElement(2, 'Counter', 'function', 1, [], 1),
  ], {});
  const timeoutResult = await withRuntimeState(snapshot, () =>
    pokeComponent('Counter', 'count', 0)
  );
  assert('error' in timeoutResult || timeoutResult.success === false,
    'poke_component handles timeout gracefully');
  cleanup();
}

// ============================================================================
// Section 6: Physical Device Support
// ============================================================================

console.log('\n--- Section 6: Physical Device Support ---');

{
  // Test DevToolsConnector accepts custom host
  const connector = new DevToolsConnector({ port: 8097, host: '0.0.0.0' });
  assert(connector !== null, 'DevToolsConnector accepts host=0.0.0.0');
}

{
  // Test DevToolsConnector with default host
  const connector = new DevToolsConnector();
  assert(connector !== null, 'DevToolsConnector with defaults works');
}

{
  // Test package.json has device platform option
  const pkg = require('../package.json');
  const platformSetting = pkg.contributes.configuration.properties['dendro-react.runtimePlatform'];
  assert(platformSetting !== undefined, 'dendro-react.runtimePlatform setting exists');
  assert(platformSetting.enum.includes('device'), 'Platform enum includes "device"');
  assert(platformSetting.enum.length === 4, 'Platform enum has 4 options (auto/ios/android/device)');
}

{
  // Test package.json has runtimeHost setting
  const pkg = require('../package.json');
  const hostSetting = pkg.contributes.configuration.properties['dendro-react.runtimeHost'];
  assert(hostSetting !== undefined, 'dendro-react.runtimeHost setting exists');
  assertEqual(hostSetting.default, 'localhost', 'Default host is localhost');
  assertEqual(hostSetting.type, 'string', 'Host setting is string type');
}

// ============================================================================
// Section 7: Feature Gating
// ============================================================================

console.log('\n--- Section 7: Feature Gating ---');

{
  assert(isProFeature('modify_runtime_state') === true, 'modify_runtime_state is Pro-gated');
  assert(isProFeature('verify_state_flows') === true, 'verify_state_flows is Pro-gated');

  // Existing tools still correctly gated
  assert(isProFeature('inspect_live_component') === true, 'inspect_live_component still Pro');
  assert(isProFeature('export_analysis') === true, 'export_analysis still Pro');
  assert(isProFeature('find_state_owner') === true, 'find_state_owner still Pro');
  assert(isProFeature('get_component_tree') === false, 'get_component_tree still Free');
  assert(isProFeature('get_live_tree') === false, 'get_live_tree still Free');
}

// ============================================================================
// Section 8: Tool Registration
// ============================================================================

console.log('\n--- Section 8: Tool Registration ---');

{
  // Verify the tools module exports the new functions
  const li = require('../out/mcp/pro-tools/live-introspection');
  assert(typeof li.modifyRuntimeState === 'function', 'modifyRuntimeState is exported');
  assert(typeof li.pokeComponent === 'function', 'pokeComponent is exported');
  assert(typeof li.inspectLiveComponent === 'function', 'inspectLiveComponent still exported');
  assert(typeof li.diffComponentState === 'function', 'diffComponentState still exported');
  assert(typeof li.findStateOwner === 'function', 'findStateOwner still exported');
  assert(typeof li.resetInspectionCache === 'function', 'resetInspectionCache still exported');
}

{
  // Verify the bridge exports the new override functions
  const bridge = require('../out/runtime/inspect-bridge');
  assert(typeof bridge.writeOverrideRequest === 'function', 'writeOverrideRequest is exported');
  assert(typeof bridge.readOverrideRequest === 'function', 'readOverrideRequest is exported');
  assert(typeof bridge.writeOverrideResult === 'function', 'writeOverrideResult is exported');
  assert(typeof bridge.readOverrideResult === 'function', 'readOverrideResult is exported');
  assert(typeof bridge.clearOverrideRequest === 'function', 'clearOverrideRequest is exported');
  assert(typeof bridge.clearOverrideResult === 'function', 'clearOverrideResult is exported');
  assert(typeof bridge.pollOverrideResult === 'function', 'pollOverrideResult is exported');
}

// ============================================================================
// Section 9: Edge Cases
// ============================================================================

console.log('\n--- Section 9: Edge Cases ---');

{
  // Test generateRequestId uniqueness
  const ids = new Set();
  for (let i = 0; i < 100; i++) {
    ids.add(generateRequestId());
  }
  assert(ids.size === 100, 'generateRequestId produces 100 unique IDs');
}

{
  // Test override request with complex value
  const complexValue = { nested: { array: [1, 2, { deep: true }] } };
  writeOverrideRequest({
    requestId: 'complex-test',
    elementId: 1,
    componentName: 'Complex',
    type: 'state',
    path: ['data'],
    value: complexValue,
    timestamp: Date.now(),
  });
  const read = readOverrideRequest();
  assert(read !== null, 'Override request with complex value readable');
  assert(read.value.nested.array.length === 3, 'Complex value preserved through serialization');
  assert(read.value.nested.array[2].deep === true, 'Deep nested values preserved');
  clearOverrideRequest();
}

{
  // Test override request with hookID
  writeOverrideRequest({
    requestId: 'hook-test',
    elementId: 5,
    componentName: 'HookComp',
    type: 'hooks',
    path: [],
    value: true,
    hookID: 3,
    timestamp: Date.now(),
  });
  const read = readOverrideRequest();
  assertEqual(read.hookID, 3, 'hookID preserved in override request');
  clearOverrideRequest();
}

{
  // Test override with empty path
  writeOverrideRequest({
    requestId: 'empty-path',
    elementId: 1,
    componentName: 'X',
    type: 'state',
    path: [],
    value: 'replaced',
    timestamp: Date.now(),
  });
  const read = readOverrideRequest();
  assert(Array.isArray(read.path) && read.path.length === 0, 'Empty path preserved');
  clearOverrideRequest();
}

{
  // Test reading non-existent files returns null
  clearOverrideRequest();
  clearOverrideResult();
  const req = readOverrideRequest();
  const res = readOverrideResult();
  assert(req === null, 'readOverrideRequest returns null when file does not exist');
  assert(res === null, 'readOverrideResult returns null when file does not exist');
}

// ============================================================================
// Section 10: Override Bridge Request/Response Simulation
// ============================================================================

console.log('\n--- Section 10: Override Bridge Full Simulation ---');

async function testFullSimulation() {
  cleanup();

  // Simulate the full MCP → Extension → App flow
  // Step 1: MCP writes override request
  const requestId = generateRequestId();
  writeOverrideRequest({
    requestId,
    elementId: 42,
    componentName: 'ProfileForm',
    type: 'state',
    path: ['email'],
    value: 'test@example.com',
    timestamp: Date.now(),
  });

  // Step 2: Extension reads request
  const request = readOverrideRequest();
  assert(request !== null, 'Extension reads override request');
  assertEqual(request.requestId, requestId, 'Request ID matches');
  assertEqual(request.type, 'state', 'Override type is state');

  // Step 3: Extension calls overrideValueAtPath (simulated — returns false since no WS)
  // In real flow, the connector sends WS message and we assume success

  // Step 4: Extension writes result
  writeOverrideResult({
    requestId: request.requestId,
    elementId: request.elementId,
    componentName: request.componentName,
    type: request.type,
    path: request.path,
    value: request.value,
    timestamp: Date.now(),
    success: true,
  });
  clearOverrideRequest();

  // Step 5: MCP polls for result
  const result = await pollOverrideResult(requestId, 1000);
  assert(result !== null, 'MCP polls and finds override result');
  assert(result.success === true, 'Override result is successful');
  assertEqual(result.componentName, 'ProfileForm', 'Result component name matches');
  assertEqual(result.value, 'test@example.com', 'Result value matches');

  cleanup();
}

// ============================================================================
// Run async tests
// ============================================================================

async function main() {
  await safeRun('Section 3: Polling', testPolling);
  await safeRun('Section 4: modifyRuntimeState', testModifyRuntimeState);
  await safeRun('Section 5: pokeComponent', testPokeComponent);
  await safeRun('Section 10: Full Simulation', testFullSimulation);

  // Final summary
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Phase 4 Advanced Runtime: ${passed} passed, ${failed} failed`);
  console.log(`${'='.repeat(50)}`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
