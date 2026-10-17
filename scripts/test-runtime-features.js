#!/usr/bin/env node

// Hermetic IPC: a VS Code extension host leaks DENDRO_WORKSPACE_HASH into any
// terminal or agent it spawns, which redirects runtime-state reads to a
// per-workspace dir while these tests write the global fallback path — every
// state-dependent assertion then fails. Scrub it so results don't depend on
// where the test runner was launched from.
delete process.env.DENDRO_WORKSPACE_HASH;
/**
 * test-runtime-features.js
 *
 * End-to-end smoke test for the runtime integration (Phase 1A-1D).
 * Tests SourceMapper, runtime state file (cross-process bridge),
 * DevTools operations parser, feature gate for runtime tools,
 * and MCP runtime tool logic.
 *
 * Runs against compiled output — NO VS Code needed.
 *
 * Usage:
 *   npm run build && node scripts/test-runtime-features.js
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(ROOT, 'src/test/fixtures/mcp-tools');
const DENDRO_DIR = path.join(os.homedir(), '.dendro');
const RUNTIME_STATE_FILE = path.join(DENDRO_DIR, 'runtime-state.json');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \u2705 ${name}`);
  } catch (err) {
    failed++;
    console.log(`  \u274C ${name}`);
    console.log(`     ${err.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ============================================================================
// Helper: backup/restore runtime state file
// ============================================================================
let originalRuntimeState = null;

function backupRuntimeState() {
  try {
    originalRuntimeState = fs.readFileSync(RUNTIME_STATE_FILE, 'utf-8');
  } catch {
    originalRuntimeState = null;
  }
}

function restoreRuntimeState() {
  if (originalRuntimeState !== null) {
    fs.mkdirSync(DENDRO_DIR, { recursive: true });
    fs.writeFileSync(RUNTIME_STATE_FILE, originalRuntimeState, 'utf-8');
  } else {
    try { fs.unlinkSync(RUNTIME_STATE_FILE); } catch { /* ok */ }
  }
}

function writeTestState(snapshot) {
  fs.mkdirSync(DENDRO_DIR, { recursive: true });
  fs.writeFileSync(RUNTIME_STATE_FILE, JSON.stringify(snapshot), 'utf-8');
}

function removeTestState() {
  try { fs.unlinkSync(RUNTIME_STATE_FILE); } catch { /* ok */ }
}

// ============================================================================
// 1. SourceMapper
// ============================================================================
console.log('\n\ud83d\udccd SourceMapper');

const { SourceMapper } = require(path.join(ROOT, 'out/runtime/source-mapper'));

test('buildIndex scans fixtures and finds PascalCase components', () => {
  const mapper = new SourceMapper();
  mapper.buildIndex(FIXTURES);
  assert(mapper.size > 0, `Expected > 0 indexed components, got ${mapper.size}`);
});

test('mapToSource returns exact match for known component', () => {
  const mapper = new SourceMapper();
  mapper.buildIndex(FIXTURES);
  const result = mapper.mapToSource('App');
  assert(result !== null, 'App should be found');
  assert(result.endsWith('App.tsx'), `Expected path ending in App.tsx, got ${result}`);
});

test('mapToSource returns case-insensitive match', () => {
  const mapper = new SourceMapper();
  mapper.buildIndex(FIXTURES);
  // Header.tsx exists in fixtures
  const result = mapper.mapToSource('header');
  assert(result !== null, 'header (lowercase) should match Header.tsx');
  assert(result.endsWith('Header.tsx'), `Expected Header.tsx, got ${result}`);
});

test('mapToSource returns null for unknown component', () => {
  const mapper = new SourceMapper();
  mapper.buildIndex(FIXTURES);
  const result = mapper.mapToSource('NonExistentComponent');
  assertEqual(result, null, 'Should return null for unknown component');
});

test('mapToSource returns null before buildIndex', () => {
  const mapper = new SourceMapper();
  const result = mapper.mapToSource('App');
  assertEqual(result, null, 'Should return null when not yet indexed');
});

test('mapToSource returns null for empty string', () => {
  const mapper = new SourceMapper();
  mapper.buildIndex(FIXTURES);
  const result = mapper.mapToSource('');
  assertEqual(result, null, 'Should return null for empty string');
});

test('getSourceMap returns a copy of the index', () => {
  const mapper = new SourceMapper();
  mapper.buildIndex(FIXTURES);
  const sourceMap = mapper.getSourceMap();
  assert(sourceMap instanceof Map, 'Should return a Map');
  assert(sourceMap.size === mapper.size, 'Should have same size as index');
  // Mutation of returned map should not affect internal state
  sourceMap.set('TestMutation', '/fake/path');
  assert(mapper.size !== sourceMap.size, 'Internal index should be unaffected');
});

test('buildIndex skips node_modules and dot directories', () => {
  const mapper = new SourceMapper();
  // Use the full project root — it has node_modules etc.
  mapper.buildIndex(ROOT);
  const sourceMap = mapper.getSourceMap();
  for (const [, filePath] of sourceMap) {
    assert(!filePath.includes('node_modules'), `Should skip node_modules: ${filePath}`);
    assert(!filePath.includes('/.git/'), `Should skip .git: ${filePath}`);
  }
});

test('buildIndex skips index and test files', () => {
  const mapper = new SourceMapper();
  mapper.buildIndex(FIXTURES);
  const sourceMap = mapper.getSourceMap();
  for (const [name] of sourceMap) {
    assert(name !== 'index', 'Should skip index files');
    assert(!name.endsWith('.test'), 'Should skip test files');
    assert(!name.endsWith('.spec'), 'Should skip spec files');
  }
});

test('buildIndex finds expected fixture components', () => {
  const mapper = new SourceMapper();
  mapper.buildIndex(FIXTURES);
  const expectedComponents = ['App', 'Header', 'Footer', 'MainContent', 'UserProfile'];
  for (const name of expectedComponents) {
    const result = mapper.mapToSource(name);
    assert(result !== null, `Expected to find ${name} in fixtures`);
  }
});

// ============================================================================
// 2. Runtime State File (cross-process bridge)
// ============================================================================
console.log('\n\ud83d\udcc4 Runtime State File');

// Clear require cache so readRuntimeState reads fresh each call
function freshReadRuntimeState() {
  delete require.cache[require.resolve(path.join(ROOT, 'out/runtime/runtime-state-file'))];
  return require(path.join(ROOT, 'out/runtime/runtime-state-file')).readRuntimeState;
}

backupRuntimeState();

try {
  test('readRuntimeState returns null when no file exists', () => {
    removeTestState();
    const read = freshReadRuntimeState();
    const result = read();
    assertEqual(result, null, 'Should return null when file missing');
  });

  test('readRuntimeState returns connected state for fresh data', () => {
    const snapshot = {
      status: 'connected',
      timestamp: Date.now(),
      componentCount: 5,
      roots: [1],
      elements: [
        { id: 1, displayName: 'Root', type: 'other', key: null, parentId: null, children: [2], depth: 0 },
        { id: 2, displayName: 'App', type: 'function', key: null, parentId: 1, children: [3, 4, 5], depth: 1 },
        { id: 3, displayName: 'Header', type: 'function', key: null, parentId: 2, children: [], depth: 2 },
        { id: 4, displayName: 'MainContent', type: 'function', key: null, parentId: 2, children: [], depth: 2 },
        { id: 5, displayName: 'Footer', type: 'function', key: null, parentId: 2, children: [], depth: 2 },
      ],
      sourceMap: { App: '/src/App.tsx', Header: '/src/Header.tsx' },
    };
    writeTestState(snapshot);
    const read = freshReadRuntimeState();
    const result = read();
    assert(result !== null, 'Should read state');
    assertEqual(result.status, 'connected');
    assertEqual(result.componentCount, 5);
    assertEqual(result.roots.length, 1);
    assertEqual(result.elements.length, 5);
    assert(result.sourceMap.App === '/src/App.tsx', 'Source map should be preserved');
  });

  test('readRuntimeState marks stale data as disconnected', () => {
    const snapshot = {
      status: 'connected',
      timestamp: Date.now() - 60_000, // 60 seconds old (> 30s threshold)
      componentCount: 3,
      roots: [1],
      elements: [],
      sourceMap: {},
    };
    writeTestState(snapshot);
    const read = freshReadRuntimeState();
    const result = read();
    assert(result !== null, 'Should still return data');
    assertEqual(result.status, 'disconnected', 'Stale data should be marked disconnected');
    assertEqual(result.componentCount, 3, 'Component count should be preserved');
  });

  test('readRuntimeState returns null for malformed JSON', () => {
    fs.mkdirSync(DENDRO_DIR, { recursive: true });
    fs.writeFileSync(RUNTIME_STATE_FILE, 'not json at all', 'utf-8');
    const read = freshReadRuntimeState();
    const result = read();
    assertEqual(result, null, 'Should return null for malformed JSON');
  });

  test('readRuntimeState handles empty object', () => {
    writeTestState({});
    const read = freshReadRuntimeState();
    const result = read();
    // Empty object has no timestamp, so Date.now() - undefined = NaN > 30000 is false
    // Result should still be returned (no crash)
    assert(result !== null, 'Should not crash on empty object');
  });

  test('readRuntimeState preserves disconnected status', () => {
    const snapshot = {
      status: 'disconnected',
      timestamp: Date.now(), // Fresh timestamp
      componentCount: 0,
      roots: [],
      elements: [],
      sourceMap: {},
    };
    writeTestState(snapshot);
    const read = freshReadRuntimeState();
    const result = read();
    assert(result !== null, 'Should return data');
    assertEqual(result.status, 'disconnected', 'Should preserve disconnected status');
  });

} finally {
  restoreRuntimeState();
}

// ============================================================================
// 3. DevTools Operations Parser
// ============================================================================
console.log('\n\ud83d\udd27 DevTools Operations Parser');

// We test the parser by creating a DevToolsConnector and feeding it operations
// via the private handleOperations method. Since it's private, we access it
// through the class's internal tree state after emitting events.

const { DevToolsConnector } = require(path.join(ROOT, 'out/runtime/devtools-connector'));

test('connector initializes with disconnected status', () => {
  const connector = new DevToolsConnector({ port: 0 });
  assertEqual(connector.status, 'disconnected');
  assertEqual(connector.componentTree.elements.size, 0);
  assertEqual(connector.componentTree.roots.length, 0);
});

test('connector getAllComponents returns empty array initially', () => {
  const connector = new DevToolsConnector({ port: 0 });
  const components = connector.getAllComponents();
  assert(Array.isArray(components), 'Should return array');
  assertEqual(components.length, 0);
});

test('connector getTreeHierarchy returns empty array initially', () => {
  const connector = new DevToolsConnector({ port: 0 });
  const roots = connector.getTreeHierarchy();
  assert(Array.isArray(roots), 'Should return array');
  assertEqual(roots.length, 0);
});

test('connector getComponent returns undefined for unknown id', () => {
  const connector = new DevToolsConnector({ port: 0 });
  const component = connector.getComponent(999);
  assertEqual(component, undefined);
});

// Test the operations parser by directly invoking the private method.
// The DevToolsConnector uses handleOperations privately, but we can
// access it for testing since JS doesn't enforce private at runtime.
test('operations parser handles root ADD correctly', () => {
  const connector = new DevToolsConnector({ port: 0 });

  // Simulate operations array: [rendererID, rootID, stringTableByteLength, ...ops]
  // Root ADD: [TREE_OPERATION_ADD(1), id, ElementTypeRoot(11), isStrictMode, profilingFlags, isProductionBuild, hasOwnerMetadata]
  const operations = [
    1,  // rendererID
    10, // rootID
    0,  // stringTableByteLength (empty)
    // Operations:
    1,  // TREE_OPERATION_ADD
    10, // id
    11, // ElementTypeRoot
    0,  // isStrictMode
    0,  // profilingFlags
    0,  // isProductionBuild
    0,  // hasOwnerMetadata
  ];

  // Access private method directly
  connector.handleOperations(operations);

  assertEqual(connector.componentTree.roots.length, 1, 'Should have 1 root');
  assertEqual(connector.componentTree.roots[0], 10);
  const root = connector.getComponent(10);
  assert(root !== undefined, 'Root component should exist');
  assertEqual(root.displayName, 'Root');
  assertEqual(root.type, 'other');
  assertEqual(root.parentId, null);
});

test('operations parser handles regular ADD with string table', () => {
  const connector = new DevToolsConnector({ port: 0 });

  // Build string table: "App" (3 chars) encoded as [3, 65, 112, 112]
  // String table is 1-indexed, size is in BYTE LENGTH = 4 (length byte + chars)
  const stringTable = [3, 65, 112, 112]; // "App"

  const operations = [
    1,  // rendererID
    10, // rootID
    stringTable.length, // stringTableByteLength
    ...stringTable,
    // Root ADD first
    1,  // TREE_OPERATION_ADD
    10, // id
    11, // ElementTypeRoot
    0, 0, 0, 0, // root fields
    // Regular ADD
    1,  // TREE_OPERATION_ADD
    20, // id
    5,  // ElementTypeFunction
    10, // parentID
    0,  // ownerID
    1,  // displayNameStringID (1-indexed → "App")
    0,  // keyStringID
    0,  // namePropStringID (v7)
  ];

  connector.handleOperations(operations);

  const app = connector.getComponent(20);
  assert(app !== undefined, 'App component should exist');
  assertEqual(app.displayName, 'App');
  assertEqual(app.type, 'function');
  assertEqual(app.parentId, 10);

  // Root should have App as child
  const root = connector.getComponent(10);
  assert(root.children.includes(20), 'Root should have App as child');
});

test('operations parser handles class component type', () => {
  const connector = new DevToolsConnector({ port: 0 });

  // String: "MyClass" = [7, 77, 121, 67, 108, 97, 115, 115]
  const stringTable = [7, 77, 121, 67, 108, 97, 115, 115];

  const operations = [
    1, 10, stringTable.length, ...stringTable,
    1, 10, 11, 0, 0, 0, 0,    // Root
    1, 30, 1, 10, 0, 1, 0, 0, // ElementTypeClass = 1
  ];

  connector.handleOperations(operations);

  const cls = connector.getComponent(30);
  assert(cls !== undefined, 'Class component should exist');
  assertEqual(cls.type, 'class');
  assertEqual(cls.displayName, 'MyClass');
});

test('operations parser handles host component type', () => {
  const connector = new DevToolsConnector({ port: 0 });

  // String: "View" = [4, 86, 105, 101, 119]
  const stringTable = [4, 86, 105, 101, 119];

  const operations = [
    1, 10, stringTable.length, ...stringTable,
    1, 10, 11, 0, 0, 0, 0,    // Root
    1, 40, 7, 10, 0, 1, 0, 0, // ElementTypeHostComponent = 7
  ];

  connector.handleOperations(operations);

  const view = connector.getComponent(40);
  assert(view !== undefined, 'Host component should exist');
  assertEqual(view.type, 'host');
  assertEqual(view.displayName, 'View');
});

test('operations parser handles REMOVE operation', () => {
  const connector = new DevToolsConnector({ port: 0 });

  // String: "App" = [3, 65, 112, 112]
  const stringTable = [3, 65, 112, 112];

  // First add root + component
  const addOps = [
    1, 10, stringTable.length, ...stringTable,
    1, 10, 11, 0, 0, 0, 0,
    1, 20, 5, 10, 0, 1, 0, 0,
  ];
  connector.handleOperations(addOps);
  assert(connector.getComponent(20) !== undefined, 'App should exist after add');

  // Now remove it
  const removeOps = [
    1, 10, 0, // header (no string table)
    2,  // TREE_OPERATION_REMOVE
    1,  // count
    20, // id to remove
  ];
  connector.handleOperations(removeOps);
  assertEqual(connector.getComponent(20), undefined, 'App should be gone after remove');
});

test('operations parser handles REORDER_CHILDREN', () => {
  const connector = new DevToolsConnector({ port: 0 });

  // Strings: "A" = [1, 65], "B" = [1, 66], "C" = [1, 67]
  const stringTable = [1, 65, 1, 66, 1, 67]; // A, B, C

  // Add root + 3 children
  const addOps = [
    1, 10, stringTable.length, ...stringTable,
    1, 10, 11, 0, 0, 0, 0,              // Root
    1, 21, 5, 10, 0, 1, 0, 0,           // A (string 1)
    1, 22, 5, 10, 0, 2, 0, 0,           // B (string 2)
    1, 23, 5, 10, 0, 3, 0, 0,           // C (string 3)
  ];
  connector.handleOperations(addOps);

  const rootBefore = connector.getComponent(10);
  assert(rootBefore.children.includes(21), 'Root should have A');
  assert(rootBefore.children.includes(22), 'Root should have B');
  assert(rootBefore.children.includes(23), 'Root should have C');

  // Reorder: C, A, B
  const reorderOps = [
    1, 10, 0,
    3,  // TREE_OPERATION_REORDER_CHILDREN
    10, // parentId
    3,  // numChildren
    23, 21, 22, // new order: C, A, B
  ];
  connector.handleOperations(reorderOps);

  const rootAfter = connector.getComponent(10);
  assertEqual(rootAfter.children[0], 23, 'First child should be C');
  assertEqual(rootAfter.children[1], 21, 'Second child should be A');
  assertEqual(rootAfter.children[2], 22, 'Third child should be B');
});

test('operations parser handles multiple strings in string table', () => {
  const connector = new DevToolsConnector({ port: 0 });

  // Strings: "Header" (6), "Footer" (6)
  // Header: [6, 72, 101, 97, 100, 101, 114]
  // Footer: [6, 70, 111, 111, 116, 101, 114]
  const stringTable = [
    6, 72, 101, 97, 100, 101, 114,  // "Header"
    6, 70, 111, 111, 116, 101, 114,  // "Footer"
  ];

  const operations = [
    1, 10, stringTable.length, ...stringTable,
    1, 10, 11, 0, 0, 0, 0,
    1, 50, 5, 10, 0, 1, 0, 0, // displayNameStringID=1 → "Header"
    1, 51, 5, 10, 0, 2, 0, 0, // displayNameStringID=2 → "Footer"
  ];

  connector.handleOperations(operations);

  assertEqual(connector.getComponent(50).displayName, 'Header');
  assertEqual(connector.getComponent(51).displayName, 'Footer');
});

test('operations parser calculates depth correctly', () => {
  const connector = new DevToolsConnector({ port: 0 });

  // Strings: "App" "Child" "GrandChild"
  const stringTable = [
    3, 65, 112, 112,                      // "App"
    5, 67, 104, 105, 108, 100,            // "Child"
    10, 71, 114, 97, 110, 100, 67, 104, 105, 108, 100, // "GrandChild"
  ];

  const operations = [
    1, 10, stringTable.length, ...stringTable,
    1, 10, 11, 0, 0, 0, 0,           // Root (depth 0)
    1, 20, 5, 10, 0, 1, 0, 0,        // App under Root (depth 1)
    1, 30, 5, 20, 0, 2, 0, 0,        // Child under App (depth 2)
    1, 40, 5, 30, 0, 3, 0, 0,        // GrandChild under Child (depth 3)
  ];

  connector.handleOperations(operations);

  assertEqual(connector.getComponent(10).depth, 0, 'Root depth should be 0');
  assertEqual(connector.getComponent(20).depth, 1, 'App depth should be 1');
  assertEqual(connector.getComponent(30).depth, 2, 'Child depth should be 2');
  assertEqual(connector.getComponent(40).depth, 3, 'GrandChild depth should be 3');
});

test('operations parser handles empty operations array gracefully', () => {
  const connector = new DevToolsConnector({ port: 0 });
  // Should not throw
  connector.handleOperations([]);
  connector.handleOperations(null);
  connector.handleOperations(undefined);
  assertEqual(connector.componentTree.elements.size, 0, 'Tree should stay empty');
});

test('operations parser skips profiling ops (UPDATE_TREE_BASE_DURATION)', () => {
  const connector = new DevToolsConnector({ port: 0 });

  const operations = [
    1, 10, 0,
    1, 10, 11, 0, 0, 0, 0,  // Root
    4,  // TREE_OPERATION_UPDATE_TREE_BASE_DURATION
    10, // fiberId
    42, // duration
  ];

  // Should not throw, and root should exist
  connector.handleOperations(operations);
  assert(connector.getComponent(10) !== undefined, 'Root should exist after profiling op');
});

test('operations parser handles errors/warnings op (UPDATE_ERRORS_OR_WARNINGS)', () => {
  const connector = new DevToolsConnector({ port: 0 });

  const operations = [
    1, 10, 0,
    1, 10, 11, 0, 0, 0, 0,  // Root
    5,  // TREE_OPERATION_UPDATE_ERRORS_OR_WARNINGS
    10, // fiberId
    2,  // errorCount
    1,  // warningCount
  ];

  connector.handleOperations(operations);
  assert(connector.getComponent(10) !== undefined, 'Root should exist after error/warning op');
});

// ============================================================================
// 4. Feature Gate — Runtime Tools
// ============================================================================
console.log('\n\ud83d\udd12 Feature Gate — Runtime Tools');

const { isProFeature, getFeatureTier, getFreeFeatureList } = require(path.join(ROOT, 'out/licensing/feature-gate'));

test('get_runtime_status is free', () => {
  assertEqual(isProFeature('get_runtime_status'), false);
  assertEqual(getFeatureTier('get_runtime_status'), 'free');
});

test('get_live_tree is free', () => {
  assertEqual(isProFeature('get_live_tree'), false);
  assertEqual(getFeatureTier('get_live_tree'), 'free');
});

test('get_runtime_state is free', () => {
  assertEqual(isProFeature('get_runtime_state'), false);
  assertEqual(getFeatureTier('get_runtime_state'), 'free');
});

test('runtime tools are in the free feature list', () => {
  const freeList = getFreeFeatureList();
  assert(freeList.includes('get_runtime_status'), 'get_runtime_status should be in free list');
  assert(freeList.includes('get_live_tree'), 'get_live_tree should be in free list');
  assert(freeList.includes('get_runtime_state'), 'get_runtime_state should be in free list');
});

test('free list now has 22 tools (19 original + 3 runtime)', () => {
  const freeList = getFreeFeatureList();
  assert(freeList.length >= 22, `Expected >= 22 free features, got ${freeList.length}`);
});

// ============================================================================
// 5. MCP Runtime Tool Logic (simulated via runtime state file)
// ============================================================================
console.log('\n\ud83d\udee0\ufe0f  MCP Runtime Tool Logic');

backupRuntimeState();

try {
  // Simulate a connected state with a real tree
  const testSnapshot = {
    status: 'connected',
    timestamp: Date.now(),
    componentCount: 6,
    roots: [1],
    elements: [
      { id: 1, displayName: 'Root', type: 'other', key: null, parentId: null, children: [2], depth: 0 },
      { id: 2, displayName: 'App', type: 'function', key: null, parentId: 1, children: [3, 4, 5], depth: 1 },
      { id: 3, displayName: 'Header', type: 'function', key: null, parentId: 2, children: [], depth: 2 },
      { id: 4, displayName: 'MainContent', type: 'function', key: null, parentId: 2, children: [6], depth: 2 },
      { id: 5, displayName: 'Footer', type: 'function', key: null, parentId: 2, children: [], depth: 2 },
      { id: 6, displayName: 'UserProfile', type: 'function', key: null, parentId: 4, children: [], depth: 3 },
    ],
    sourceMap: {
      App: '/src/App.tsx',
      Header: '/src/Header.tsx',
      UserProfile: '/src/UserProfile.tsx',
    },
  };

  // --- get_runtime_status logic ---
  test('get_runtime_status: returns connected when state is fresh', () => {
    writeTestState(testSnapshot);
    const read = freshReadRuntimeState();
    const state = read();
    assert(state !== null, 'State should exist');
    assertEqual(state.status, 'connected');
    assertEqual(state.componentCount, 6);
    assert(state.roots.length === 1, 'Should have 1 root');
    assertEqual(Object.keys(state.sourceMap).length, 3);
  });

  test('get_runtime_status: returns disconnected when no file', () => {
    removeTestState();
    const read = freshReadRuntimeState();
    const state = read();
    assertEqual(state, null, 'Should be null when no file');
  });

  // --- get_live_tree logic ---
  test('get_live_tree: builds tree from elements', () => {
    writeTestState(testSnapshot);
    const read = freshReadRuntimeState();
    const state = read();

    // Replicate the tree-building logic from server.ts
    const elementMap = new Map();
    for (const el of state.elements) {
      elementMap.set(el.id, el);
    }

    function buildTreeNode(id, depth) {
      const el = elementMap.get(id);
      if (!el) return null;
      const children = [];
      for (const childId of el.children) {
        const child = buildTreeNode(childId, depth + 1);
        if (child) children.push(child);
      }
      return {
        id: el.id,
        displayName: el.displayName,
        type: el.type,
        sourceFile: state.sourceMap[el.displayName] || null,
        children,
      };
    }

    const roots = [];
    for (const rootId of state.roots) {
      const node = buildTreeNode(rootId, 0);
      if (node) roots.push(node);
    }

    assertEqual(roots.length, 1, 'Should have 1 root');
    assertEqual(roots[0].displayName, 'Root');
    assertEqual(roots[0].children.length, 1, 'Root should have App child');
    assertEqual(roots[0].children[0].displayName, 'App');
    assertEqual(roots[0].children[0].children.length, 3, 'App should have 3 children');
  });

  test('get_live_tree: filters out host components when includeNative=false', () => {
    const snapshotWithNative = {
      ...testSnapshot,
      elements: [
        // Copy all elements, but update Header to have View as child
        ...testSnapshot.elements.map(el =>
          el.id === 3 ? { ...el, children: [7] } : el
        ),
        { id: 7, displayName: 'View', type: 'host', key: null, parentId: 3, children: [], depth: 3 },
      ],
      componentCount: 7,
    };
    writeTestState(snapshotWithNative);
    const read = freshReadRuntimeState();
    const state = read();

    const elementMap = new Map();
    for (const el of state.elements) {
      elementMap.set(el.id, el);
    }

    function buildTreeNode(id, depth, includeNative) {
      const el = elementMap.get(id);
      if (!el) return null;
      if (includeNative === false && el.type === 'host') return null;
      const children = [];
      for (const childId of el.children) {
        const child = buildTreeNode(childId, depth + 1, includeNative);
        if (child) children.push(child);
      }
      return { id: el.id, displayName: el.displayName, type: el.type, children };
    }

    // With native
    const rootsWithNative = [];
    for (const rootId of state.roots) {
      const node = buildTreeNode(rootId, 0, true);
      if (node) rootsWithNative.push(node);
    }

    // Without native
    const rootsNoNative = [];
    for (const rootId of state.roots) {
      const node = buildTreeNode(rootId, 0, false);
      if (node) rootsNoNative.push(node);
    }

    // Count total nodes
    function countNodes(node) {
      let count = 1;
      for (const child of node.children) count += countNodes(child);
      return count;
    }

    const countWith = rootsWithNative.reduce((sum, r) => sum + countNodes(r), 0);
    const countWithout = rootsNoNative.reduce((sum, r) => sum + countNodes(r), 0);
    assert(countWith > countWithout, `With native (${countWith}) should have more nodes than without (${countWithout})`);
  });

  test('get_live_tree: respects maxDepth filter', () => {
    writeTestState(testSnapshot);
    const read = freshReadRuntimeState();
    const state = read();

    const elementMap = new Map();
    for (const el of state.elements) {
      elementMap.set(el.id, el);
    }

    function buildTreeNode(id, depth, maxDepth) {
      const el = elementMap.get(id);
      if (!el) return null;
      if (maxDepth !== undefined && depth > maxDepth) return null;
      const children = [];
      for (const childId of el.children) {
        const child = buildTreeNode(childId, depth + 1, maxDepth);
        if (child) children.push(child);
      }
      return { id: el.id, displayName: el.displayName, children };
    }

    // maxDepth=1: Root(0) + App(1) only
    const roots = [];
    for (const rootId of state.roots) {
      const node = buildTreeNode(rootId, 0, 1);
      if (node) roots.push(node);
    }

    assertEqual(roots.length, 1);
    assertEqual(roots[0].children.length, 1, 'Root should have App');
    assertEqual(roots[0].children[0].children.length, 0, 'App should have no children at maxDepth=1');
  });

  // --- get_runtime_state logic ---
  test('get_runtime_state: finds component by name (case-insensitive)', () => {
    writeTestState(testSnapshot);
    const read = freshReadRuntimeState();
    const state = read();

    const searchLower = 'header';
    const matches = state.elements.filter(el =>
      el.displayName.toLowerCase().includes(searchLower)
    );

    assertEqual(matches.length, 1);
    assertEqual(matches[0].displayName, 'Header');
    assertEqual(matches[0].id, 3);
  });

  test('get_runtime_state: partial name match finds multiple results', () => {
    writeTestState(testSnapshot);
    const read = freshReadRuntimeState();
    const state = read();

    // "oo" matches "Root" and "Footer"
    const searchLower = 'oo';
    const matches = state.elements.filter(el =>
      el.displayName.toLowerCase().includes(searchLower)
    );

    assert(matches.length >= 2, `Expected >= 2 matches for "oo", got ${matches.length}`);
    const names = matches.map(m => m.displayName);
    assert(names.includes('Root'), 'Should match Root');
    assert(names.includes('Footer'), 'Should match Footer');
  });

  test('get_runtime_state: returns empty matches for unknown component', () => {
    writeTestState(testSnapshot);
    const read = freshReadRuntimeState();
    const state = read();

    const matches = state.elements.filter(el =>
      el.displayName.toLowerCase().includes('nonexistent')
    );

    assertEqual(matches.length, 0);
  });

  test('get_runtime_state: includes parent context', () => {
    writeTestState(testSnapshot);
    const read = freshReadRuntimeState();
    const state = read();

    const elementMap = new Map();
    for (const el of state.elements) {
      elementMap.set(el.id, el);
    }

    // Find UserProfile
    const matches = state.elements.filter(el =>
      el.displayName.toLowerCase().includes('userprofile')
    );
    assertEqual(matches.length, 1);

    const match = matches[0];
    const parent = match.parentId !== null ? elementMap.get(match.parentId) : null;

    assert(parent !== null, 'UserProfile should have a parent');
    assertEqual(parent.displayName, 'MainContent');
  });

  test('get_runtime_state: includes children context', () => {
    writeTestState(testSnapshot);
    const read = freshReadRuntimeState();
    const state = read();

    const elementMap = new Map();
    for (const el of state.elements) {
      elementMap.set(el.id, el);
    }

    // Find App
    const matches = state.elements.filter(el =>
      el.displayName === 'App'
    );
    assertEqual(matches.length, 1);

    const children = matches[0].children.map(childId => {
      const child = elementMap.get(childId);
      return child ? { id: child.id, displayName: child.displayName, type: child.type } : null;
    }).filter(Boolean);

    assertEqual(children.length, 3);
    const childNames = children.map(c => c.displayName);
    assert(childNames.includes('Header'), 'Should have Header child');
    assert(childNames.includes('MainContent'), 'Should have MainContent child');
    assert(childNames.includes('Footer'), 'Should have Footer child');
  });

  test('get_runtime_state: source map resolves for matched component', () => {
    writeTestState(testSnapshot);
    const read = freshReadRuntimeState();
    const state = read();

    const matches = state.elements.filter(el =>
      el.displayName === 'UserProfile'
    );
    assertEqual(matches.length, 1);

    const sourceFile = state.sourceMap[matches[0].displayName] || null;
    assertEqual(sourceFile, '/src/UserProfile.tsx');
  });

  test('get_runtime_state: source map returns null for unmapped component', () => {
    writeTestState(testSnapshot);
    const read = freshReadRuntimeState();
    const state = read();

    const matches = state.elements.filter(el =>
      el.displayName === 'Footer'
    );
    assertEqual(matches.length, 1);

    const sourceFile = state.sourceMap[matches[0].displayName] || null;
    assertEqual(sourceFile, null, 'Footer is not in the source map');
  });

} finally {
  restoreRuntimeState();
}

// ============================================================================
// 6. package.json — Runtime Commands
// ============================================================================
console.log('\n\ud83d\udccb package.json — Runtime Commands');

const pkg = require(path.join(ROOT, 'package.json'));
const commands = pkg.contributes.commands.map(c => c.command);

test('has connectRuntime command', () => {
  assert(commands.includes('dendro-react.connectRuntime'), 'Should have dendro.connectRuntime');
});

test('has disconnectRuntime command', () => {
  assert(commands.includes('dendro-react.disconnectRuntime'), 'Should have dendro.disconnectRuntime');
});

// ============================================================================
// 7. Integration: SourceMapper + Runtime State
// ============================================================================
console.log('\n\ud83d\udd17 Integration: SourceMapper + Runtime State');

test('source mapper index can populate runtime state sourceMap', () => {
  const mapper = new SourceMapper();
  mapper.buildIndex(FIXTURES);
  const sourceMap = mapper.getSourceMap();

  // Convert to the Record<string, string> format used in RuntimeStateSnapshot
  const serialized = Object.fromEntries(sourceMap);

  assert(typeof serialized === 'object', 'Should be a plain object');
  assert(serialized.App !== undefined, 'Should have App mapping');
  assert(serialized.App.endsWith('App.tsx'), `App path should end with App.tsx, got ${serialized.App}`);
  assert(serialized.Header !== undefined, 'Should have Header mapping');
});

test('full flow: mapper → state file → read back → lookup', () => {
  const mapper = new SourceMapper();
  mapper.buildIndex(FIXTURES);
  const sourceMap = mapper.getSourceMap();
  const serialized = Object.fromEntries(sourceMap);

  const snapshot = {
    status: 'connected',
    timestamp: Date.now(),
    componentCount: 2,
    roots: [1],
    elements: [
      { id: 1, displayName: 'Root', type: 'other', key: null, parentId: null, children: [2], depth: 0 },
      { id: 2, displayName: 'Header', type: 'function', key: null, parentId: 1, children: [], depth: 1 },
    ],
    sourceMap: serialized,
  };

  backupRuntimeState();
  try {
    writeTestState(snapshot);
    const read = freshReadRuntimeState();
    const state = read();

    assert(state !== null, 'Should read state');
    assertEqual(state.status, 'connected');

    // Lookup Header's source via the state's source map
    const headerSource = state.sourceMap['Header'];
    assert(headerSource !== undefined, 'Header should be in source map');
    assert(headerSource.endsWith('Header.tsx'), `Header source should end with Header.tsx, got ${headerSource}`);
  } finally {
    restoreRuntimeState();
  }
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
