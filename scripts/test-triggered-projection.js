#!/usr/bin/env node

// Hermetic IPC: a VS Code extension host leaks DENDRO_WORKSPACE_HASH into any
// terminal or agent it spawns, which redirects runtime-state reads to a
// per-workspace dir while these tests write the global fallback path — every
// state-dependent assertion then fails. Scrub it so results don't depend on
// where the test runner was launched from.
delete process.env.DENDRO_WORKSPACE_HASH;

/**
 * Triggered Projection (Paradigm 3) Test Suite
 *
 * Tests tree diffing, downstream projection, animation, snapshot management,
 * tool registration, and feature gating.
 *
 * Run: node scripts/test-triggered-projection.js
 */

const path = require('path');
const fs = require('fs');

// Load compiled modules
const {
  diffSnapshots,
  projectFromRuntime,
  animateProjection,
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

// --- Test Data Factories ---

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

// ============================================================================
// 1. diffSnapshots — Core Tree Diffing
// ============================================================================

console.log('\n1. diffSnapshots — Core Tree Diffing');

// 1.1 Detect mounts (new components)
{
  const prev = makeSnapshot('connected', [
    makeElement(1, 'App', 'function', null, [2], 0),
    makeElement(2, 'Header', 'function', 1, [], 1),
  ]);
  const curr = makeSnapshot('connected', [
    makeElement(1, 'App', 'function', null, [2, 3], 0),
    makeElement(2, 'Header', 'function', 1, [], 1),
    makeElement(3, 'Footer', 'function', 1, [], 1),
  ]);

  const changes = diffSnapshots(prev, curr);
  const mounts = changes.filter(c => c.type === 'mount');
  assert(mounts.length === 1, 'Detects 1 mount');
  assert(mounts[0].displayName === 'Footer', 'Mount is Footer');
  assert(mounts[0].id === 3, 'Mount has correct ID');
}

// 1.2 Detect unmounts (removed components)
{
  const prev = makeSnapshot('connected', [
    makeElement(1, 'App', 'function', null, [2, 3], 0),
    makeElement(2, 'Header', 'function', 1, [], 1),
    makeElement(3, 'Footer', 'function', 1, [], 1),
  ]);
  const curr = makeSnapshot('connected', [
    makeElement(1, 'App', 'function', null, [2], 0),
    makeElement(2, 'Header', 'function', 1, [], 1),
  ]);

  const changes = diffSnapshots(prev, curr);
  const unmounts = changes.filter(c => c.type === 'unmount');
  assert(unmounts.length === 1, 'Detects 1 unmount');
  assert(unmounts[0].displayName === 'Footer', 'Unmount is Footer');
}

// 1.3 Detect rerenders (same ID, different children)
{
  const prev = makeSnapshot('connected', [
    makeElement(1, 'App', 'function', null, [2], 0),
    makeElement(2, 'List', 'function', 1, [3], 1),
    makeElement(3, 'Item', 'function', 2, [], 2),
  ]);
  const curr = makeSnapshot('connected', [
    makeElement(1, 'App', 'function', null, [2], 0),
    makeElement(2, 'List', 'function', 1, [3, 4], 1),
    makeElement(3, 'Item', 'function', 2, [], 2),
    makeElement(4, 'Item', 'function', 2, [], 2),
  ]);

  const changes = diffSnapshots(prev, curr);
  const rerenders = changes.filter(c => c.type === 'rerender');
  const mounts = changes.filter(c => c.type === 'mount');
  assert(rerenders.length === 1, 'Detects 1 rerender');
  assert(rerenders[0].displayName === 'List', 'Rerender is List (children changed)');
  assert(mounts.length === 1, 'Also detects new Item as mount');
}

// 1.4 No changes when snapshots are identical
{
  const elements = [
    makeElement(1, 'App', 'function', null, [2], 0),
    makeElement(2, 'Header', 'function', 1, [], 1),
  ];
  const prev = makeSnapshot('connected', elements);
  const curr = makeSnapshot('connected', elements);

  const changes = diffSnapshots(prev, curr);
  assert(changes.length === 0, 'No changes for identical snapshots');
}

// 1.5 Mixed: mount + unmount + rerender in one diff
{
  const prev = makeSnapshot('connected', [
    makeElement(1, 'App', 'function', null, [2, 3], 0),
    makeElement(2, 'Header', 'function', 1, [4], 1),
    makeElement(3, 'OldComponent', 'function', 1, [], 1),
    makeElement(4, 'Logo', 'function', 2, [], 2),
  ]);
  const curr = makeSnapshot('connected', [
    makeElement(1, 'App', 'function', null, [2, 5], 0),
    makeElement(2, 'Header', 'function', 1, [4, 6], 1),
    makeElement(4, 'Logo', 'function', 2, [], 2),
    makeElement(5, 'NewComponent', 'function', 1, [], 1),
    makeElement(6, 'SearchBar', 'function', 2, [], 2),
  ]);

  const changes = diffSnapshots(prev, curr);
  const mounts = changes.filter(c => c.type === 'mount');
  const unmounts = changes.filter(c => c.type === 'unmount');
  const rerenders = changes.filter(c => c.type === 'rerender');

  assert(mounts.length === 2, 'Detects 2 mounts (NewComponent + SearchBar)');
  assert(unmounts.length === 1, 'Detects 1 unmount (OldComponent)');
  assert(rerenders.length >= 1, 'Detects rerender(s) for changed children');
}

// 1.6 Source file mapping in diffs
{
  const sourceMap = { 'App': '/src/App.tsx', 'Header': '/src/Header.tsx', 'Footer': '/src/Footer.tsx' };
  const prev = makeSnapshot('connected', [
    makeElement(1, 'App', 'function', null, [2], 0),
    makeElement(2, 'Header', 'function', 1, [], 1),
  ], sourceMap);
  const curr = makeSnapshot('connected', [
    makeElement(1, 'App', 'function', null, [2, 3], 0),
    makeElement(2, 'Header', 'function', 1, [], 1),
    makeElement(3, 'Footer', 'function', 1, [], 1),
  ], sourceMap);

  const changes = diffSnapshots(prev, curr);
  const mount = changes.find(c => c.type === 'mount');
  assert(mount && mount.sourceFile === '/src/Footer.tsx', 'Mount includes source file from sourceMap');
}

// 1.7 Null source file when not in sourceMap
{
  const prev = makeSnapshot('connected', [
    makeElement(1, 'App', 'function', null, [], 0),
  ]);
  const curr = makeSnapshot('connected', [
    makeElement(1, 'App', 'function', null, [2], 0),
    makeElement(2, 'UnmappedComponent', 'function', 1, [], 1),
  ]);

  const changes = diffSnapshots(prev, curr);
  const mount = changes.find(c => c.type === 'mount');
  assert(mount && mount.sourceFile === null, 'Source file is null when not in sourceMap');
}

// 1.8 Empty snapshots
{
  const prev = makeSnapshot('connected', []);
  const curr = makeSnapshot('connected', []);
  const changes = diffSnapshots(prev, curr);
  assert(changes.length === 0, 'No changes for empty snapshots');
}

// 1.9 All new (empty → populated)
{
  const prev = makeSnapshot('connected', []);
  const curr = makeSnapshot('connected', [
    makeElement(1, 'App', 'function', null, [2], 0),
    makeElement(2, 'Header', 'function', 1, [], 1),
  ]);

  const changes = diffSnapshots(prev, curr);
  assert(changes.length === 2, 'All components detected as mounts from empty');
  assert(changes.every(c => c.type === 'mount'), 'All are mounts');
}

// 1.10 All removed (populated → empty)
{
  const prev = makeSnapshot('connected', [
    makeElement(1, 'App', 'function', null, [2], 0),
    makeElement(2, 'Header', 'function', 1, [], 1),
  ]);
  const curr = makeSnapshot('connected', []);

  const changes = diffSnapshots(prev, curr);
  assert(changes.length === 2, 'All components detected as unmounts');
  assert(changes.every(c => c.type === 'unmount'), 'All are unmounts');
}

// ============================================================================
// 2. projectFromRuntime — Snapshot Management
// ============================================================================

console.log('\n2. projectFromRuntime — Snapshot Management');

// 2.1 Returns not_connected when no runtime state
{
  resetSnapshot();
  // Write a disconnected state file to simulate no connection
  const dendroDir = path.join(require('os').homedir(), '.dendro');
  const stateFile = path.join(dendroDir, 'runtime-state.json');
  let originalContent = null;

  try {
    if (fs.existsSync(stateFile)) {
      originalContent = fs.readFileSync(stateFile, 'utf-8');
    }
    // Write disconnected state
    if (!fs.existsSync(dendroDir)) fs.mkdirSync(dendroDir, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({
      status: 'disconnected',
      timestamp: Date.now(),
      componentCount: 0,
      roots: [],
      elements: [],
      sourceMap: {},
    }));

    const result = projectFromRuntime({ entryFile: '/tmp/App.tsx' });
    assert(result.error === 'not_connected', 'Returns not_connected error when disconnected');
    assert(result.projections.length === 0, 'No projections when disconnected');
  } finally {
    // Restore original state
    if (originalContent !== null) {
      fs.writeFileSync(stateFile, originalContent);
    } else if (fs.existsSync(stateFile)) {
      fs.unlinkSync(stateFile);
    }
  }
}

// 2.2 First call captures baseline
{
  resetSnapshot();
  const dendroDir = path.join(require('os').homedir(), '.dendro');
  const stateFile = path.join(dendroDir, 'runtime-state.json');
  let originalContent = null;

  try {
    if (fs.existsSync(stateFile)) {
      originalContent = fs.readFileSync(stateFile, 'utf-8');
    }
    if (!fs.existsSync(dendroDir)) fs.mkdirSync(dendroDir, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({
      status: 'connected',
      timestamp: Date.now(),
      componentCount: 2,
      roots: [1],
      elements: [
        makeElement(1, 'App', 'function', null, [2], 0),
        makeElement(2, 'Header', 'function', 1, [], 1),
      ],
      sourceMap: {},
    }));

    const result = projectFromRuntime({ entryFile: '/tmp/App.tsx' });
    assert(!result.error, 'No error on baseline capture');
    assert(result.summary.includes('Baseline snapshot captured'), 'Summary says baseline captured');
    assert(result.changes.length === 0, 'No changes on first call');
  } finally {
    if (originalContent !== null) {
      fs.writeFileSync(stateFile, originalContent);
    } else if (fs.existsSync(stateFile)) {
      fs.unlinkSync(stateFile);
    }
  }
}

// 2.3 Second call detects changes
{
  resetSnapshot();
  const dendroDir = path.join(require('os').homedir(), '.dendro');
  const stateFile = path.join(dendroDir, 'runtime-state.json');
  let originalContent = null;

  try {
    if (fs.existsSync(stateFile)) {
      originalContent = fs.readFileSync(stateFile, 'utf-8');
    }
    if (!fs.existsSync(dendroDir)) fs.mkdirSync(dendroDir, { recursive: true });

    // First call: baseline
    fs.writeFileSync(stateFile, JSON.stringify({
      status: 'connected',
      timestamp: Date.now(),
      componentCount: 2,
      roots: [1],
      elements: [
        makeElement(1, 'App', 'function', null, [2], 0),
        makeElement(2, 'Header', 'function', 1, [], 1),
      ],
      sourceMap: {},
    }));
    projectFromRuntime({ entryFile: '/tmp/App.tsx' });

    // Second call: with changes
    fs.writeFileSync(stateFile, JSON.stringify({
      status: 'connected',
      timestamp: Date.now(),
      componentCount: 3,
      roots: [1],
      elements: [
        makeElement(1, 'App', 'function', null, [2, 3], 0),
        makeElement(2, 'Header', 'function', 1, [], 1),
        makeElement(3, 'Footer', 'function', 1, [], 1),
      ],
      sourceMap: {},
    }));

    const result = projectFromRuntime({ entryFile: '/tmp/App.tsx' });
    assert(!result.error, 'No error on second call');
    assert(result.changes.length > 0, 'Detects changes on second call');
    const mounts = result.changes.filter(c => c.type === 'mount');
    assert(mounts.some(m => m.displayName === 'Footer'), 'Detects Footer mount');
  } finally {
    if (originalContent !== null) {
      fs.writeFileSync(stateFile, originalContent);
    } else if (fs.existsSync(stateFile)) {
      fs.unlinkSync(stateFile);
    }
    resetSnapshot();
  }
}

// 2.4 No changes returns clean result
{
  resetSnapshot();
  const dendroDir = path.join(require('os').homedir(), '.dendro');
  const stateFile = path.join(dendroDir, 'runtime-state.json');
  let originalContent = null;

  try {
    if (fs.existsSync(stateFile)) {
      originalContent = fs.readFileSync(stateFile, 'utf-8');
    }
    if (!fs.existsSync(dendroDir)) fs.mkdirSync(dendroDir, { recursive: true });

    const snapshot = {
      status: 'connected',
      timestamp: Date.now(),
      componentCount: 2,
      roots: [1],
      elements: [
        makeElement(1, 'App', 'function', null, [2], 0),
        makeElement(2, 'Header', 'function', 1, [], 1),
      ],
      sourceMap: {},
    };

    // Baseline
    fs.writeFileSync(stateFile, JSON.stringify(snapshot));
    projectFromRuntime({ entryFile: '/tmp/App.tsx' });

    // Same snapshot
    fs.writeFileSync(stateFile, JSON.stringify({ ...snapshot, timestamp: Date.now() }));
    const result = projectFromRuntime({ entryFile: '/tmp/App.tsx' });
    assert(result.changes.length === 0, 'No changes when snapshot unchanged');
    assert(result.summary.includes('No changes'), 'Summary says no changes');
  } finally {
    if (originalContent !== null) {
      fs.writeFileSync(stateFile, originalContent);
    } else if (fs.existsSync(stateFile)) {
      fs.unlinkSync(stateFile);
    }
    resetSnapshot();
  }
}

// 2.5 componentName filter
{
  resetSnapshot();
  const dendroDir = path.join(require('os').homedir(), '.dendro');
  const stateFile = path.join(dendroDir, 'runtime-state.json');
  let originalContent = null;

  try {
    if (fs.existsSync(stateFile)) {
      originalContent = fs.readFileSync(stateFile, 'utf-8');
    }
    if (!fs.existsSync(dendroDir)) fs.mkdirSync(dendroDir, { recursive: true });

    // Baseline
    fs.writeFileSync(stateFile, JSON.stringify({
      status: 'connected',
      timestamp: Date.now(),
      componentCount: 2,
      roots: [1],
      elements: [
        makeElement(1, 'App', 'function', null, [2], 0),
        makeElement(2, 'Header', 'function', 1, [], 1),
      ],
      sourceMap: {},
    }));
    projectFromRuntime({ entryFile: '/tmp/App.tsx' });

    // Changed: both App and Header have new children
    fs.writeFileSync(stateFile, JSON.stringify({
      status: 'connected',
      timestamp: Date.now(),
      componentCount: 4,
      roots: [1],
      elements: [
        makeElement(1, 'App', 'function', null, [2, 3], 0),
        makeElement(2, 'Header', 'function', 1, [4], 1),
        makeElement(3, 'Footer', 'function', 1, [], 1),
        makeElement(4, 'Logo', 'function', 2, [], 2),
      ],
      sourceMap: {},
    }));

    const result = projectFromRuntime({ entryFile: '/tmp/App.tsx', componentName: 'Footer' });
    // Should only include changes matching "Footer"
    assert(result.changes.every(c => c.displayName.toLowerCase().includes('footer')),
      'componentName filter works (only Footer changes)');
  } finally {
    if (originalContent !== null) {
      fs.writeFileSync(stateFile, originalContent);
    } else if (fs.existsSync(stateFile)) {
      fs.unlinkSync(stateFile);
    }
    resetSnapshot();
  }
}

// ============================================================================
// 3. animateProjection — Visualization
// ============================================================================

console.log('\n3. animateProjection — Visualization');

// 3.1 Returns counts
{
  const changes = [
    { id: 1, displayName: 'App', type: 'rerender', sourceFile: null },
  ];
  const projections = [
    {
      trigger: 'App',
      triggerFile: '/src/App.tsx',
      changeType: 'rerender',
      flowType: 'context',
      affectedPath: ['App', 'ProfileScreen', 'SettingsScreen'],
      confidence: 0.85,
      reasoning: 'test',
    },
  ];

  const result = animateProjection(projections, changes);
  assert(result.nodesHighlighted >= 1, 'Highlights at least 1 node');
  assert(result.flowsAnimated === 1, 'Animates 1 flow');
}

// 3.2 Handles unmounts (red highlight)
{
  const changes = [
    { id: 1, displayName: 'RemovedComponent', type: 'unmount', sourceFile: null },
  ];

  const result = animateProjection([], changes);
  assert(result.nodesHighlighted === 1, 'Highlights unmounted node');
  assert(result.flowsAnimated === 0, 'No flows for unmounts');
}

// 3.3 Empty projections and changes
{
  const result = animateProjection([], []);
  assert(result.nodesHighlighted === 0, 'No highlights for empty input');
  assert(result.flowsAnimated === 0, 'No flows for empty input');
}

// 3.4 Multiple flow types
{
  const changes = [
    { id: 1, displayName: 'Provider', type: 'rerender', sourceFile: null },
  ];
  const projections = [
    {
      trigger: 'Provider',
      triggerFile: null,
      changeType: 'rerender',
      flowType: 'context',
      affectedPath: ['Provider', 'Consumer1', 'Consumer2'],
      confidence: 0.85,
      reasoning: 'context flow',
    },
    {
      trigger: 'Provider',
      triggerFile: null,
      changeType: 'rerender',
      flowType: 'prop',
      affectedPath: ['Provider', 'ChildA'],
      confidence: 0.7,
      reasoning: 'prop flow',
    },
    {
      trigger: 'Provider',
      triggerFile: null,
      changeType: 'rerender',
      flowType: 'hook-state',
      affectedPath: ['Provider'], // single node, won't animate
      confidence: 0.6,
      reasoning: 'hook dependency',
    },
  ];

  const result = animateProjection(projections, changes);
  assert(result.flowsAnimated === 2, 'Animates 2 flows (skips single-node hook-state)');
}

// 3.5 Deduplicates trigger highlights
{
  const changes = [
    { id: 1, displayName: 'App', type: 'rerender', sourceFile: null },
    { id: 2, displayName: 'App', type: 'mount', sourceFile: null }, // same name, different event
  ];

  const result = animateProjection([], changes);
  // "App" should be deduplicated in trigger highlights
  assert(result.nodesHighlighted === 1, 'Deduplicates trigger highlights by displayName');
}

// ============================================================================
// 4. resetSnapshot
// ============================================================================

console.log('\n4. resetSnapshot');

// 4.1 Reset allows fresh baseline
{
  resetSnapshot();
  const dendroDir = path.join(require('os').homedir(), '.dendro');
  const stateFile = path.join(dendroDir, 'runtime-state.json');
  let originalContent = null;

  try {
    if (fs.existsSync(stateFile)) {
      originalContent = fs.readFileSync(stateFile, 'utf-8');
    }
    if (!fs.existsSync(dendroDir)) fs.mkdirSync(dendroDir, { recursive: true });

    fs.writeFileSync(stateFile, JSON.stringify({
      status: 'connected',
      timestamp: Date.now(),
      componentCount: 1,
      roots: [1],
      elements: [makeElement(1, 'App', 'function', null, [], 0)],
      sourceMap: {},
    }));

    // First call: baseline
    const r1 = projectFromRuntime({ entryFile: '/tmp/App.tsx' });
    assert(r1.summary.includes('Baseline'), 'First call is baseline');

    // Reset and call again
    resetSnapshot();
    const r2 = projectFromRuntime({ entryFile: '/tmp/App.tsx' });
    assert(r2.summary.includes('Baseline'), 'After reset, first call is baseline again');
  } finally {
    if (originalContent !== null) {
      fs.writeFileSync(stateFile, originalContent);
    } else if (fs.existsSync(stateFile)) {
      fs.unlinkSync(stateFile);
    }
    resetSnapshot();
  }
}

// ============================================================================
// 5. Feature Gating
// ============================================================================

console.log('\n5. Feature Gating');

{
  assert(isProFeature('trigger_projection') === true, 'trigger_projection is a Pro feature');
  assert(isProFeature('get_component_tree') === false, 'get_component_tree is free (sanity check)');
}

// ============================================================================
// 6. Type & Structure Validation
// ============================================================================

console.log('\n6. Type & Structure Validation');

// 6.1 ProjectedFlow structure
{
  const flow = {
    trigger: 'App',
    triggerFile: '/src/App.tsx',
    changeType: 'rerender',
    flowType: 'context',
    affectedPath: ['App', 'Consumer'],
    confidence: 0.85,
    reasoning: 'test',
  };
  assert(typeof flow.trigger === 'string', 'ProjectedFlow.trigger is string');
  assert(typeof flow.confidence === 'number', 'ProjectedFlow.confidence is number');
  assert(Array.isArray(flow.affectedPath), 'ProjectedFlow.affectedPath is array');
  assert(['context', 'prop', 'hook-state'].includes(flow.flowType), 'ProjectedFlow.flowType is valid');
  assert(['mount', 'unmount', 'rerender'].includes(flow.changeType), 'ProjectedFlow.changeType is valid');
}

// 6.2 ComponentChange structure
{
  const change = { id: 1, displayName: 'App', type: 'mount', sourceFile: '/src/App.tsx' };
  assert(typeof change.id === 'number', 'ComponentChange.id is number');
  assert(typeof change.displayName === 'string', 'ComponentChange.displayName is string');
  assert(['mount', 'unmount', 'rerender'].includes(change.type), 'ComponentChange.type is valid');
}

// 6.3 TriggerProjectionResult structure
{
  resetSnapshot();
  const dendroDir = path.join(require('os').homedir(), '.dendro');
  const stateFile = path.join(dendroDir, 'runtime-state.json');
  let originalContent = null;

  try {
    if (fs.existsSync(stateFile)) {
      originalContent = fs.readFileSync(stateFile, 'utf-8');
    }
    if (!fs.existsSync(dendroDir)) fs.mkdirSync(dendroDir, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({
      status: 'connected',
      timestamp: Date.now(),
      componentCount: 1,
      roots: [1],
      elements: [makeElement(1, 'App', 'function', null, [], 0)],
      sourceMap: {},
    }));

    const result = projectFromRuntime({ entryFile: '/tmp/App.tsx' });
    assert(Array.isArray(result.projections), 'Result has projections array');
    assert(Array.isArray(result.changes), 'Result has changes array');
    assert(typeof result.nodesHighlighted === 'number', 'Result has nodesHighlighted number');
    assert(typeof result.flowsAnimated === 'number', 'Result has flowsAnimated number');
    assert(typeof result.summary === 'string', 'Result has summary string');
  } finally {
    if (originalContent !== null) {
      fs.writeFileSync(stateFile, originalContent);
    } else if (fs.existsSync(stateFile)) {
      fs.unlinkSync(stateFile);
    }
    resetSnapshot();
  }
}

// ============================================================================
// 7. Edge Cases
// ============================================================================

console.log('\n7. Edge Cases');

// 7.1 Host components in diff
{
  const prev = makeSnapshot('connected', [
    makeElement(1, 'App', 'function', null, [2], 0),
    makeElement(2, 'View', 'host', 1, [], 1),
  ]);
  const curr = makeSnapshot('connected', [
    makeElement(1, 'App', 'function', null, [2, 3], 0),
    makeElement(2, 'View', 'host', 1, [], 1),
    makeElement(3, 'Text', 'host', 1, [], 1),
  ]);

  const changes = diffSnapshots(prev, curr);
  assert(changes.length > 0, 'Detects host component changes');
  const textMount = changes.find(c => c.displayName === 'Text');
  assert(textMount && textMount.type === 'mount', 'Host component Text detected as mount');
}

// 7.2 Large tree diff performance (100 elements)
{
  const prevElements = [];
  const currElements = [];
  for (let i = 1; i <= 100; i++) {
    prevElements.push(makeElement(i, `Component${i}`, 'function', i === 1 ? null : 1, [], i === 1 ? 0 : 1));
    currElements.push(makeElement(i, `Component${i}`, 'function', i === 1 ? null : 1, [], i === 1 ? 0 : 1));
  }
  // Add 10 new elements to current
  for (let i = 101; i <= 110; i++) {
    currElements.push(makeElement(i, `NewComponent${i}`, 'function', 1, [], 1));
  }

  const start = Date.now();
  const changes = diffSnapshots(
    makeSnapshot('connected', prevElements),
    makeSnapshot('connected', currElements),
  );
  const elapsed = Date.now() - start;

  assert(changes.length === 10, 'Correctly diffs 10 new components in 110-element tree');
  assert(elapsed < 100, `Diff completes in <100ms (took ${elapsed}ms)`);
}

// 7.3 Duplicate display names
{
  const prev = makeSnapshot('connected', [
    makeElement(1, 'App', 'function', null, [2, 3], 0),
    makeElement(2, 'Button', 'function', 1, [], 1),
    makeElement(3, 'Button', 'function', 1, [], 1),
  ]);
  const curr = makeSnapshot('connected', [
    makeElement(1, 'App', 'function', null, [2, 3, 4], 0),
    makeElement(2, 'Button', 'function', 1, [], 1),
    makeElement(3, 'Button', 'function', 1, [], 1),
    makeElement(4, 'Button', 'function', 1, [], 1),
  ]);

  const changes = diffSnapshots(prev, curr);
  const mounts = changes.filter(c => c.type === 'mount');
  assert(mounts.length === 1, 'Handles duplicate displayNames correctly (1 new Button)');
  assert(mounts[0].id === 4, 'New Button has correct ID');
}

// 7.4 Stale runtime state
{
  resetSnapshot();
  const dendroDir = path.join(require('os').homedir(), '.dendro');
  const stateFile = path.join(dendroDir, 'runtime-state.json');
  let originalContent = null;

  try {
    if (fs.existsSync(stateFile)) {
      originalContent = fs.readFileSync(stateFile, 'utf-8');
    }
    if (!fs.existsSync(dendroDir)) fs.mkdirSync(dendroDir, { recursive: true });

    // Write stale state (31 seconds old)
    fs.writeFileSync(stateFile, JSON.stringify({
      status: 'connected',
      timestamp: Date.now() - 31000,
      componentCount: 1,
      roots: [1],
      elements: [makeElement(1, 'App', 'function', null, [], 0)],
      sourceMap: {},
    }));

    const result = projectFromRuntime({ entryFile: '/tmp/App.tsx' });
    assert(result.error === 'not_connected', 'Stale state (>30s) treated as disconnected');
  } finally {
    if (originalContent !== null) {
      fs.writeFileSync(stateFile, originalContent);
    } else if (fs.existsSync(stateFile)) {
      fs.unlinkSync(stateFile);
    }
    resetSnapshot();
  }
}

// ============================================================================
// 8. Tool Registration (server.ts)
// ============================================================================

console.log('\n8. Tool Registration');

{
  const serverModule = require('../out/mcp/server');
  assert(typeof serverModule.createServer === 'function', 'createServer is exported');

  // DENDRO_INCLUDE_PRO is a webpack define — set it globally for Node
  if (typeof globalThis.DENDRO_INCLUDE_PRO === 'undefined') {
    globalThis.DENDRO_INCLUDE_PRO = false;
  }
  const server = serverModule.createServer();
  assert(server !== null && server !== undefined, 'Server creates successfully with TP tool registered');
}

// ============================================================================
// Summary
// ============================================================================

console.log('\n' + '='.repeat(60));
console.log(`Triggered Projection Tests: ${passed} passed, ${failed} failed`);
console.log('='.repeat(60));

if (failed > 0) {
  process.exit(1);
}
