#!/usr/bin/env node

/**
 * Live Introspection (Paradigm 4) Test Suite
 *
 * Tests inspect bridge, live component inspection, state diffing,
 * state owner search, feature gating, and edge cases.
 *
 * Run: node scripts/test-live-introspection.js
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

// Use an isolated temp directory for IPC files so the running VS Code extension
// doesn't consume inspect requests written by the test interceptors.
const TEST_IPC_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dendro-test-ipc-'));
process.env.DENDRO_IPC_DIR = TEST_IPC_DIR;

// Load compiled modules (AFTER setting DENDRO_IPC_DIR)
const {
  writeInspectRequest,
  readInspectRequest,
  writeInspectResult,
  readInspectResult,
  clearInspectRequest,
  clearInspectResult,
  pollInspectResult,
  generateRequestId,
  getInspectPaths,
} = require('../out/runtime/inspect-bridge');
const INSPECT_PATHS = getInspectPaths();

const {
  inspectLiveComponent,
  diffComponentState,
  findStateOwner,
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

// --- Test Data Factories ---

function makeElement(id, displayName, type, parentId, children, depth, sourceFilePath) {
  return {
    id,
    displayName,
    type: type || 'function',
    key: null,
    parentId: parentId !== undefined ? parentId : null,
    children: children || [],
    depth: depth || 0,
    sourceFilePath,
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

function makeInspectResult(requestId, elementId, componentName, overrides) {
  return {
    requestId,
    elementId,
    componentName,
    props: { title: 'Hello' },
    state: { count: 0, loading: false },
    hooks: [{ id: 0, name: 'useState', value: 0, subHooks: [] }],
    context: { ThemeContext: { dark: true } },
    timestamp: Date.now(),
    success: true,
    ...overrides,
  };
}

// --- Runtime state file mock ---

const DENDRO_DIR = TEST_IPC_DIR;
const RUNTIME_STATE_FILE = path.join(DENDRO_DIR, 'runtime-state.json');

function writeTestRuntimeState(snapshot) {
  if (!fs.existsSync(DENDRO_DIR)) {
    fs.mkdirSync(DENDRO_DIR, { recursive: true });
  }
  fs.writeFileSync(RUNTIME_STATE_FILE, JSON.stringify(snapshot), 'utf-8');
}

function backupRuntimeState() {
  const backupFile = RUNTIME_STATE_FILE + '.backup';
  if (fs.existsSync(RUNTIME_STATE_FILE)) {
    fs.copyFileSync(RUNTIME_STATE_FILE, backupFile);
    return backupFile;
  }
  return null;
}

function restoreRuntimeState(backupFile) {
  if (backupFile && fs.existsSync(backupFile)) {
    fs.copyFileSync(backupFile, RUNTIME_STATE_FILE);
    fs.unlinkSync(backupFile);
  } else if (!backupFile) {
    // No backup means file didn't exist — remove it
    try { fs.unlinkSync(RUNTIME_STATE_FILE); } catch {}
  }
}

// Backup existing state before tests
const runtimeStateBackup = backupRuntimeState();

// Clean up bridge files before tests
clearInspectRequest();
clearInspectResult();
resetInspectionCache();

// ============================================================================
// 1. Inspect Bridge — File I/O
// ============================================================================

console.log('\n1. Inspect Bridge — File I/O');

// 1.1 generateRequestId returns unique IDs
{
  const id1 = generateRequestId();
  const id2 = generateRequestId();
  assert(typeof id1 === 'string', 'generateRequestId returns string');
  assert(id1.startsWith('inspect-'), 'Request ID has correct prefix');
  assert(id1 !== id2, 'Request IDs are unique');
}

// 1.2 Write and read inspect request
{
  const request = {
    requestId: 'test-req-001',
    elementId: 42,
    componentName: 'LoginScreen',
    timestamp: Date.now(),
  };
  writeInspectRequest(request);
  const readBack = readInspectRequest();
  assert(readBack !== null, 'Request file is readable');
  assert(readBack.requestId === 'test-req-001', 'Request ID matches');
  assert(readBack.elementId === 42, 'Element ID matches');
  assert(readBack.componentName === 'LoginScreen', 'Component name matches');
  clearInspectRequest();
}

// 1.3 Write and read inspect result
{
  const result = makeInspectResult('test-req-002', 42, 'LoginScreen');
  writeInspectResult(result);
  const readBack = readInspectResult();
  assert(readBack !== null, 'Result file is readable');
  assert(readBack.requestId === 'test-req-002', 'Result request ID matches');
  assert(readBack.success === true, 'Result success flag correct');
  assert(readBack.props.title === 'Hello', 'Props data preserved');
  assert(readBack.state.count === 0, 'State data preserved');
  assert(readBack.hooks.length === 1, 'Hooks data preserved');
  assert(readBack.context.ThemeContext.dark === true, 'Context data preserved');
  clearInspectResult();
}

// 1.4 Clear functions work
{
  writeInspectRequest({ requestId: 'tmp', elementId: 1, componentName: 'X', timestamp: 0 });
  clearInspectRequest();
  const req = readInspectRequest();
  assert(req === null, 'clearInspectRequest removes file');

  writeInspectResult(makeInspectResult('tmp', 1, 'X'));
  clearInspectResult();
  const res = readInspectResult();
  assert(res === null, 'clearInspectResult removes file');
}

// 1.5 Read returns null when file doesn't exist
{
  clearInspectRequest();
  clearInspectResult();
  assert(readInspectRequest() === null, 'readInspectRequest returns null when no file');
  assert(readInspectResult() === null, 'readInspectResult returns null when no file');
}

// 1.6 INSPECT_PATHS are correct
{
  assert(INSPECT_PATHS.request.includes(DENDRO_DIR), 'Request path includes IPC dir');
  assert(INSPECT_PATHS.result.includes(DENDRO_DIR), 'Result path includes IPC dir');
  assert(INSPECT_PATHS.request.endsWith('inspect-request.json'), 'Request file name correct');
  assert(INSPECT_PATHS.result.endsWith('inspect-result.json'), 'Result file name correct');
}

// ============================================================================
// 2. Inspect Bridge — Polling
// ============================================================================

console.log('\n2. Inspect Bridge — Polling');

// 2.1 pollInspectResult finds matching result
async function testPolling() {
  clearInspectResult();
  const requestId = 'poll-test-001';

  // Write result after a short delay
  setTimeout(() => {
    writeInspectResult(makeInspectResult(requestId, 10, 'TestComponent'));
  }, 200);

  const result = await pollInspectResult(requestId, 2000);
  assert(result !== null, 'pollInspectResult finds result');
  assert(result.requestId === requestId, 'Poll returns matching requestId');
  assert(result.componentName === 'TestComponent', 'Poll returns correct component');
  clearInspectResult();
}

// 2.2 pollInspectResult returns null on timeout
async function testPollingTimeout() {
  clearInspectResult();
  const result = await pollInspectResult('nonexistent-request', 300);
  assert(result === null, 'pollInspectResult returns null on timeout');
}

// 2.3 pollInspectResult ignores non-matching requestId
async function testPollingMismatch() {
  clearInspectResult();
  writeInspectResult(makeInspectResult('other-request', 10, 'Other'));
  const result = await pollInspectResult('my-request', 300);
  assert(result === null, 'pollInspectResult ignores mismatched requestId');
  clearInspectResult();
}

// ============================================================================
// 3. inspectLiveComponent — Disconnected State
// ============================================================================

console.log('\n3. inspectLiveComponent — Disconnected State');

async function testInspectDisconnected() {
  // Write disconnected state
  writeTestRuntimeState(makeSnapshot('disconnected', []));

  const result = await inspectLiveComponent('LoginScreen');
  assert(result.error === 'not_connected', 'Returns not_connected when disconnected');
  assert(result.message.includes('No running'), 'Error message mentions no running app');
}

// 3.2 No runtime state file
async function testInspectNoState() {
  // Remove runtime state file
  try { fs.unlinkSync(RUNTIME_STATE_FILE); } catch {}

  const result = await inspectLiveComponent('LoginScreen');
  assert(result.error === 'not_connected', 'Returns not_connected when no state file');
}

// ============================================================================
// 4. inspectLiveComponent — Component Not Found
// ============================================================================

console.log('\n4. inspectLiveComponent — Component Not Found');

async function testInspectNotFound() {
  writeTestRuntimeState(makeSnapshot('connected', [
    makeElement(1, 'Root', 'other', null, [2], 0),
    makeElement(2, 'App', 'function', 1, [], 1),
  ]));

  const result = await inspectLiveComponent('NonExistentComponent');
  assert(result.error === 'component_not_found', 'Returns component_not_found');
  assert(result.message.includes('NonExistentComponent'), 'Error message includes search term');
}

// 4.2 Host components are excluded
async function testInspectHostExcluded() {
  writeTestRuntimeState(makeSnapshot('connected', [
    makeElement(1, 'Root', 'other', null, [2], 0),
    makeElement(2, 'View', 'host', 1, [], 1),
  ]));

  const result = await inspectLiveComponent('View');
  assert(result.error === 'component_not_found', 'Host components excluded from search');
}

// ============================================================================
// 5. inspectLiveComponent — Successful Inspection (Simulated)
// ============================================================================

console.log('\n5. inspectLiveComponent — Successful Inspection (Simulated)');

async function testInspectSuccess() {
  resetInspectionCache();

  writeTestRuntimeState(makeSnapshot('connected', [
    makeElement(1, 'Root', 'other', null, [2], 0),
    makeElement(2, 'App', 'function', 1, [3, 4], 1),
    makeElement(3, 'LoginScreen', 'function', 2, [], 2),
    makeElement(4, 'Header', 'function', 2, [], 2),
  ], { 'LoginScreen': '/src/screens/LoginScreen.tsx' }));

  // Simulate extension fulfilling the request
  const interceptAndFulfill = setInterval(() => {
    const req = readInspectRequest();
    if (req && req.componentName === 'LoginScreen') {
      writeInspectResult(makeInspectResult(req.requestId, req.elementId, 'LoginScreen', {
        props: { navigation: { navigate: '[Function]' } },
        state: { email: '', password: '', loading: false },
        hooks: [
          { id: 0, name: 'useState', value: '', subHooks: [] },
          { id: 1, name: 'useState', value: '', subHooks: [] },
          { id: 2, name: 'useState', value: false, subHooks: [] },
        ],
        context: { AuthContext: { user: null, isLoggedIn: false } },
      }));
      clearInterval(interceptAndFulfill);
    }
  }, 50);

  const result = await inspectLiveComponent('LoginScreen');

  assert(!result.error, 'No error on successful inspect');
  assert(result.componentName === 'LoginScreen', 'Component name correct');
  assert(result.runtimeId === 3, 'Runtime ID correct');
  assert(result.sourceFile === '/src/screens/LoginScreen.tsx', 'Source file resolved');
  assert(result.props.navigation !== undefined, 'Props returned');
  assert(result.state.email === '', 'State returned');
  assert(result.state.loading === false, 'State values correct');
  assert(result.hooks.length === 3, 'Hooks returned');
  assert(result.context.AuthContext.user === null, 'Context returned');
  assert(result.parent.displayName === 'App', 'Parent info correct');
  assert(result.childCount === 0, 'Child count correct');
  assert(typeof result.inspectedAt === 'number', 'inspectedAt is a timestamp');

  clearInspectRequest();
  clearInspectResult();
}

// 5.2 Partial name match (case-insensitive)
async function testInspectPartialMatch() {
  resetInspectionCache();

  writeTestRuntimeState(makeSnapshot('connected', [
    makeElement(1, 'Root', 'other', null, [2], 0),
    makeElement(2, 'ProfileScreen', 'function', 1, [], 1),
  ]));

  const interceptAndFulfill = setInterval(() => {
    const req = readInspectRequest();
    if (req) {
      writeInspectResult(makeInspectResult(req.requestId, req.elementId, 'ProfileScreen'));
      clearInterval(interceptAndFulfill);
    }
  }, 50);

  const result = await inspectLiveComponent('profile');
  assert(!result.error, 'Partial name match works');
  assert(result.componentName === 'ProfileScreen', 'Resolved to full name');

  clearInspectRequest();
  clearInspectResult();
}

// 5.3 Best match selection — exact > shortest
async function testInspectBestMatch() {
  resetInspectionCache();

  writeTestRuntimeState(makeSnapshot('connected', [
    makeElement(1, 'Root', 'other', null, [2, 3], 0),
    makeElement(2, 'Button', 'function', 1, [], 1),
    makeElement(3, 'ButtonGroup', 'function', 1, [], 1),
  ]));

  const interceptAndFulfill = setInterval(() => {
    const req = readInspectRequest();
    if (req) {
      writeInspectResult(makeInspectResult(req.requestId, req.elementId, req.componentName));
      clearInterval(interceptAndFulfill);
    }
  }, 50);

  const result = await inspectLiveComponent('button');
  assert(!result.error, 'Best match works');
  assert(result.componentName === 'Button', 'Exact match preferred over longer name');

  clearInspectRequest();
  clearInspectResult();
}

// ============================================================================
// 6. inspectLiveComponent — Timeout Handling
// ============================================================================

console.log('\n6. inspectLiveComponent — Timeout Handling');

async function testInspectTimeout() {
  resetInspectionCache();

  writeTestRuntimeState(makeSnapshot('connected', [
    makeElement(1, 'Root', 'other', null, [2], 0),
    makeElement(2, 'SlowComponent', 'function', 1, [], 1),
  ]));

  // Don't simulate extension response — let it timeout
  clearInspectResult();

  const result = await inspectLiveComponent('SlowComponent');
  assert(result.error === 'inspect_timeout', 'Returns timeout error when no response');
  assert(result.message.includes('SlowComponent'), 'Timeout message includes component name');

  clearInspectRequest();
}

// ============================================================================
// 7. diffComponentState — No Previous Inspection
// ============================================================================

console.log('\n7. diffComponentState — State Diffing');

async function testDiffNoPrevious() {
  resetInspectionCache();

  writeTestRuntimeState(makeSnapshot('connected', [
    makeElement(1, 'Root', 'other', null, [2], 0),
    makeElement(2, 'Counter', 'function', 1, [], 1),
  ]));

  const interceptAndFulfill = setInterval(() => {
    const req = readInspectRequest();
    if (req) {
      writeInspectResult(makeInspectResult(req.requestId, req.elementId, 'Counter', {
        state: { count: 0 },
      }));
      clearInterval(interceptAndFulfill);
    }
  }, 50);

  const result = await diffComponentState('Counter');
  assert(!result.error, 'No error on first diff call');
  assert(result.hasPreviousInspection === false, 'Reports no previous inspection');
  assert(result.diffs.length === 0, 'No diffs on first call');
  assert(result.summary.includes('First inspection'), 'Summary mentions first inspection');

  clearInspectRequest();
  clearInspectResult();
}

// 7.2 Detect state changes
async function testDiffDetectsChanges() {
  // Previous inspection was cached from testDiffNoPrevious
  // Now simulate a state change

  writeTestRuntimeState(makeSnapshot('connected', [
    makeElement(1, 'Root', 'other', null, [2], 0),
    makeElement(2, 'Counter', 'function', 1, [], 1),
  ]));

  const interceptAndFulfill = setInterval(() => {
    const req = readInspectRequest();
    if (req) {
      writeInspectResult(makeInspectResult(req.requestId, req.elementId, 'Counter', {
        state: { count: 5 },
      }));
      clearInterval(interceptAndFulfill);
    }
  }, 50);

  const result = await diffComponentState('Counter');
  assert(!result.error, 'No error on second diff call');
  assert(result.hasPreviousInspection === true, 'Reports previous inspection exists');
  assert(result.diffs.length > 0, 'Diffs detected');

  const countDiff = result.diffs.find(d => d.field === 'count' && d.location === 'state');
  assert(countDiff !== undefined, 'Count state change detected');
  if (countDiff) {
    assert(countDiff.previous === 0, 'Previous value correct');
    assert(countDiff.current === 5, 'Current value correct');
    assert(countDiff.changeType === 'modified', 'Change type is modified');
  }

  clearInspectRequest();
  clearInspectResult();
}

// 7.3 Disconnected returns error
async function testDiffDisconnected() {
  writeTestRuntimeState(makeSnapshot('disconnected', []));
  const result = await diffComponentState('Counter');
  assert(result.error === 'not_connected', 'Diff returns not_connected when disconnected');
}

// ============================================================================
// 8. findStateOwner — Static Analysis + Runtime Cross-Reference
// ============================================================================

console.log('\n8. findStateOwner — State Owner Search');

// 8.1 No runtime state
function testFindStateNoRuntime() {
  try { fs.unlinkSync(RUNTIME_STATE_FILE); } catch {}
  const result = findStateOwner('loading');
  assert(result.query === 'loading', 'Query preserved in result');
  assert(Array.isArray(result.matches), 'Matches is an array');
  assert(typeof result.summary === 'string', 'Summary is a string');
}

// 8.2 With runtime state but no source-mapped files
function testFindStateNoSourceMap() {
  writeTestRuntimeState(makeSnapshot('connected', [
    makeElement(1, 'Root', 'other', null, [2], 0),
    makeElement(2, 'App', 'function', 1, [], 1),
  ]));

  const result = findStateOwner('loading');
  assert(result.query === 'loading', 'Query preserved');
  assert(result.matches.length === 0, 'No matches without source-mapped files');
}

// 8.3 With source-mapped files that have matching state
function testFindStateWithSourceMap() {
  // Use a fixture file that has useState
  const fixtureDir = path.join(__dirname, '..', 'src', 'test', 'fixtures');
  const complexityDir = path.join(fixtureDir, 'complexity-fixtures');

  // Check if fixture exists
  if (!fs.existsSync(complexityDir)) {
    console.log('  ⏭️  Skipping source-mapped test (no complexity fixtures)');
    return;
  }

  // Find any .tsx file in the fixture dir
  const files = fs.readdirSync(complexityDir).filter(f => f.endsWith('.tsx') || f.endsWith('.jsx'));
  if (files.length === 0) {
    console.log('  ⏭️  Skipping source-mapped test (no .tsx/.jsx fixtures)');
    return;
  }

  const testFile = path.join(complexityDir, files[0]);
  const componentName = files[0].replace(/\.(tsx|jsx)$/, '');

  writeTestRuntimeState(makeSnapshot('connected', [
    makeElement(1, 'Root', 'other', null, [2], 0),
    makeElement(2, componentName, 'function', 1, [], 1),
  ], { [componentName]: testFile }));

  const result = findStateOwner('count');

  assert(result.query === 'count', 'Query is correct');
  assert(typeof result.totalComponentsSearched === 'number', 'totalComponentsSearched is number');
  assert(typeof result.summary === 'string', 'Summary returned');
  // Matches depend on fixture content — just verify structure
  if (result.matches.length > 0) {
    const match = result.matches[0];
    assert(typeof match.componentName === 'string', 'Match has componentName');
    assert(typeof match.sourceFile === 'string', 'Match has sourceFile');
    assert(typeof match.confidence === 'number', 'Match has confidence score');
    assert(match.confidence >= 0 && match.confidence <= 1, 'Confidence in valid range');
    assert(Array.isArray(match.stateVariables), 'Match has stateVariables array');
    assert(typeof match.matchedVariable === 'string', 'Match has matchedVariable');
    assert(['static-analysis', 'runtime-tree'].includes(match.source), 'Source is valid');
  }
}

// 8.4 Result structure validation
function testFindStateResultStructure() {
  writeTestRuntimeState(makeSnapshot('connected', [
    makeElement(1, 'Root', 'other', null, [2], 0),
    makeElement(2, 'App', 'function', 1, [], 1),
  ]));

  const result = findStateOwner('anyState');
  assert('query' in result, 'Result has query field');
  assert('matches' in result, 'Result has matches field');
  assert('totalComponentsSearched' in result, 'Result has totalComponentsSearched field');
  assert('summary' in result, 'Result has summary field');
}

// ============================================================================
// 9. Feature Gating
// ============================================================================

console.log('\n9. Feature Gating');

// 9.1 Live-introspection tools are Pro-gated
// (diff_component_state retired as a tool — its coverage lives in
// inspect_live_component's diffFromPrevious flag)
{
  assert(isProFeature('inspect_live_component'), 'inspect_live_component is Pro');
  assert(isProFeature('find_state_owner'), 'find_state_owner is Pro');
}

// 9.2 Existing tools still correct
{
  assert(isProFeature('trigger_projection'), 'trigger_projection still Pro');
  assert(!isProFeature('get_runtime_state'), 'get_runtime_state still free');
  assert(!isProFeature('get_live_tree'), 'get_live_tree still free');
  assert(isProFeature('export_analysis'), 'export_analysis still Pro');
}

// ============================================================================
// 10. Edge Cases — Inspect Bridge
// ============================================================================

console.log('\n10. Edge Cases');

// 10.1 Inspect result with error
{
  const errorResult = makeInspectResult('err-001', 5, 'BrokenComponent', {
    success: false,
    error: 'Component not found',
    props: {},
    state: null,
    hooks: null,
    context: null,
  });
  writeInspectResult(errorResult);
  const readBack = readInspectResult();
  assert(readBack.success === false, 'Error result preserves success=false');
  assert(readBack.error === 'Component not found', 'Error message preserved');
  clearInspectResult();
}

// 10.2 Multiple rapid writes don't corrupt
{
  for (let i = 0; i < 10; i++) {
    writeInspectRequest({
      requestId: `rapid-${i}`,
      elementId: i,
      componentName: `Component${i}`,
      timestamp: Date.now(),
    });
  }
  const last = readInspectRequest();
  assert(last !== null, 'Last rapid write is readable');
  assert(last.requestId === 'rapid-9', 'Last write wins');
  clearInspectRequest();
}

// 10.3 Empty state/hooks/context handled
{
  const minimalResult = {
    requestId: 'min-001',
    elementId: 1,
    componentName: 'Minimal',
    props: {},
    state: null,
    hooks: null,
    context: null,
    timestamp: Date.now(),
    success: true,
  };
  writeInspectResult(minimalResult);
  const readBack = readInspectResult();
  assert(readBack.state === null, 'Null state preserved');
  assert(readBack.hooks === null, 'Null hooks preserved');
  assert(readBack.context === null, 'Null context preserved');
  assert(Object.keys(readBack.props).length === 0, 'Empty props preserved');
  clearInspectResult();
}

// ============================================================================
// 11. Diff Helpers — Unit Tests
// ============================================================================

console.log('\n11. Diff Helpers — Unit Tests');

// Test diffing logic by simulating cached results directly
{
  resetInspectionCache();

  // We test the diff detection via the public diff tool
  // Setup: write a connected runtime state with a component
  writeTestRuntimeState(makeSnapshot('connected', [
    makeElement(1, 'Root', 'other', null, [2], 0),
    makeElement(2, 'Form', 'function', 1, [], 1),
  ]));
}

// Helper: create an interceptor that tracks processed requestIds to avoid races
function createInterceptor(componentName, responses) {
  const processedIds = new Set();
  let responseIndex = 0;
  const interval = setInterval(() => {
    const req = readInspectRequest();
    if (req && req.componentName === componentName && !processedIds.has(req.requestId)) {
      processedIds.add(req.requestId);
      const responseData = responses[Math.min(responseIndex, responses.length - 1)];
      responseIndex++;
      writeInspectResult(makeInspectResult(req.requestId, req.elementId, componentName, responseData));
      if (responseIndex >= responses.length) {
        clearInterval(interval);
      }
    }
  }, 50);
  return interval;
}

// 11.1 Added prop detected
async function testDiffAddedProp() {
  resetInspectionCache();

  writeTestRuntimeState(makeSnapshot('connected', [
    makeElement(1, 'Root', 'other', null, [2], 0),
    makeElement(2, 'FormTest', 'function', 1, [], 1),
  ]));

  const interceptor = createInterceptor('FormTest', [
    { props: { name: 'Colin' }, state: {}, hooks: [], context: {} },
    { props: { name: 'Colin', email: 'test@test.com' }, state: {}, hooks: [], context: {} },
  ]);

  // Baseline
  await diffComponentState('FormTest');
  clearInspectRequest();
  clearInspectResult();

  // Second call — should show added prop
  const result = await diffComponentState('FormTest');
  clearInterval(interceptor);
  const addedDiff = result.diffs ? result.diffs.find(d => d.field === 'email' && d.changeType === 'added') : null;
  assert(addedDiff !== undefined && addedDiff !== null, 'Added prop detected');
  if (addedDiff) {
    assert(addedDiff.location === 'props', 'Added prop in correct location');
    assert(addedDiff.current === 'test@test.com', 'Added prop value correct');
  }

  clearInspectRequest();
  clearInspectResult();
}

// 11.2 Removed prop detected
async function testDiffRemovedProp() {
  resetInspectionCache();

  writeTestRuntimeState(makeSnapshot('connected', [
    makeElement(1, 'Root', 'other', null, [2], 0),
    makeElement(2, 'RmTest', 'function', 1, [], 1),
  ]));

  const interceptor = createInterceptor('RmTest', [
    { props: { a: 1, b: 2 }, state: {}, hooks: [], context: {} },
    { props: { a: 1 }, state: {}, hooks: [], context: {} },
  ]);

  await diffComponentState('RmTest');
  clearInspectRequest();
  clearInspectResult();

  const result = await diffComponentState('RmTest');
  clearInterval(interceptor);
  const removedDiff = result.diffs ? result.diffs.find(d => d.field === 'b' && d.changeType === 'removed') : null;
  assert(removedDiff !== undefined && removedDiff !== null, 'Removed prop detected');
  if (removedDiff) {
    assert(removedDiff.previous === 2, 'Removed prop previous value correct');
  }

  clearInspectRequest();
  clearInspectResult();
}

// 11.3 Hook value change detected
async function testDiffHookChange() {
  resetInspectionCache();

  writeTestRuntimeState(makeSnapshot('connected', [
    makeElement(1, 'Root', 'other', null, [2], 0),
    makeElement(2, 'HookTest', 'function', 1, [], 1),
  ]));

  const interceptor = createInterceptor('HookTest', [
    { props: {}, state: {}, hooks: [{ id: 0, name: 'useState', value: 0, subHooks: [] }], context: {} },
    { props: {}, state: {}, hooks: [{ id: 0, name: 'useState', value: 42, subHooks: [] }], context: {} },
  ]);

  await diffComponentState('HookTest');
  clearInspectRequest();
  clearInspectResult();

  const result = await diffComponentState('HookTest');
  clearInterval(interceptor);
  const hookDiff = result.diffs ? result.diffs.find(d => d.location === 'hooks') : null;
  assert(hookDiff !== undefined && hookDiff !== null, 'Hook value change detected');
  if (hookDiff) {
    assert(hookDiff.previous === 0, 'Hook previous value correct');
    assert(hookDiff.current === 42, 'Hook current value correct');
    assert(hookDiff.changeType === 'modified', 'Hook change type is modified');
  }

  clearInspectRequest();
  clearInspectResult();
}

// ============================================================================
// 12. Type Validation
// ============================================================================

console.log('\n12. Type Validation');

// 12.1 InspectResult shape
{
  const result = makeInspectResult('type-001', 1, 'Test');
  assert(typeof result.requestId === 'string', 'InspectResult.requestId is string');
  assert(typeof result.elementId === 'number', 'InspectResult.elementId is number');
  assert(typeof result.componentName === 'string', 'InspectResult.componentName is string');
  assert(typeof result.props === 'object', 'InspectResult.props is object');
  assert(typeof result.timestamp === 'number', 'InspectResult.timestamp is number');
  assert(typeof result.success === 'boolean', 'InspectResult.success is boolean');
}

// 12.2 findStateOwner result shape
{
  writeTestRuntimeState(makeSnapshot('connected', [
    makeElement(1, 'Root', 'other', null, [2], 0),
    makeElement(2, 'Test', 'function', 1, [], 1),
  ]));

  const result = findStateOwner('test');
  assert(typeof result.query === 'string', 'FindStateOwnerResult.query is string');
  assert(Array.isArray(result.matches), 'FindStateOwnerResult.matches is array');
  assert(typeof result.totalComponentsSearched === 'number', 'FindStateOwnerResult.totalComponentsSearched is number');
  assert(typeof result.summary === 'string', 'FindStateOwnerResult.summary is string');
}

// ============================================================================
// 13. resetInspectionCache
// ============================================================================

console.log('\n13. Cache Management');

// 13.1 resetInspectionCache clears cached inspections
async function testResetCache() {
  resetInspectionCache();

  writeTestRuntimeState(makeSnapshot('connected', [
    makeElement(1, 'Root', 'other', null, [2], 0),
    makeElement(2, 'CacheTest', 'function', 1, [], 1),
  ]));

  // First inspect — should be cached
  const interceptor = setInterval(() => {
    const req = readInspectRequest();
    if (req) {
      writeInspectResult(makeInspectResult(req.requestId, req.elementId, 'CacheTest', {
        state: { val: 1 },
      }));
      // Don't clear interval — will be used for second call too
    }
  }, 50);

  await inspectLiveComponent('CacheTest');
  clearInspectRequest();
  clearInspectResult();

  // Reset cache
  resetInspectionCache();

  // Now diff should report no previous inspection
  const result = await diffComponentState('CacheTest');
  clearInterval(interceptor);
  assert(result.hasPreviousInspection === false, 'Cache reset means no previous inspection');

  clearInspectRequest();
  clearInspectResult();
}

// ============================================================================
// Run all async tests
// ============================================================================

// Wrap async test functions to prevent crashes from killing the entire suite.
// File-based IPC is inherently racy in tests — a timeout may cause result
// properties to be undefined, which crashes without this guard.
async function safeRun(fn) {
  try {
    await fn();
  } catch (err) {
    console.error(`  ⚠️  Test function crashed: ${err.message}`);
    failed++;
  }
}

async function runAsyncTests() {
  // Section 2
  await safeRun(testPolling);
  await safeRun(testPollingTimeout);
  await safeRun(testPollingMismatch);

  // Section 3
  await safeRun(testInspectDisconnected);
  await safeRun(testInspectNoState);

  // Section 4
  await safeRun(testInspectNotFound);
  await safeRun(testInspectHostExcluded);

  // Section 5
  await safeRun(testInspectSuccess);
  await safeRun(testInspectPartialMatch);
  await safeRun(testInspectBestMatch);

  // Section 6
  await safeRun(testInspectTimeout);

  // Section 7
  await safeRun(testDiffNoPrevious);
  await safeRun(testDiffDetectsChanges);
  await safeRun(testDiffDisconnected);

  // Section 8
  testFindStateNoRuntime();
  testFindStateNoSourceMap();
  testFindStateWithSourceMap();
  testFindStateResultStructure();

  // Section 11
  await safeRun(testDiffAddedProp);
  await safeRun(testDiffRemovedProp);
  await safeRun(testDiffHookChange);

  // Section 13
  await safeRun(testResetCache);

  // Clean up test IPC directory
  clearInspectRequest();
  clearInspectResult();
  try { fs.rmSync(TEST_IPC_DIR, { recursive: true, force: true }); } catch {}

  // Summary
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Live Introspection (Paradigm 4) Tests: ${passed} passed, ${failed} failed`);
  console.log(`${'='.repeat(60)}`);

  if (failed > 0) {
    process.exit(1);
  }
}

runAsyncTests().catch(err => {
  console.error('Test runner error:', err);
  try { fs.rmSync(TEST_IPC_DIR, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
