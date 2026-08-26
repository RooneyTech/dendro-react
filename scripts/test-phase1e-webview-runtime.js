#!/usr/bin/env node
/**
 * Phase 1E Verification Tests — Webview Runtime Mode
 *
 * Tests the runtime tree → hierarchical converter, webview message types,
 * package.json command registration, and webview component support.
 */

const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  \u2705 ${name}`);
    passed++;
  } catch (e) {
    console.log(`  \u274c ${name}: ${e.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

// ============================================================
// 1. buildRuntimeHierarchy — test the converter
// ============================================================

console.log('\n\ud83c\udf33 Runtime Tree \u2192 Hierarchy Converter');

// Load the compiled extension to get the converter function
// Since it's a local function in activate(), we'll test the logic directly
function buildRuntimeHierarchy(tree, sourceMap) {
  function mapType(runtimeType) {
    if (runtimeType === 'function') return 'functional';
    if (runtimeType === 'class') return 'class';
    return null;
  }

  function buildNode(id) {
    const component = tree.elements.get(id);
    if (!component) return null;

    const children = component.children
      .map(childId => buildNode(childId))
      .filter(c => c !== null);

    return {
      file: component.displayName || '(anonymous)',
      type: mapType(component.type),
      state: [],
      children,
      _runtime: true,
      _runtimeId: component.id,
      _displayName: component.displayName,
      _sourceFile: sourceMap.get(component.displayName) || null,
      _runtimeType: component.type,
    };
  }

  const rootNodes = [];
  for (const rootId of tree.roots) {
    const root = tree.elements.get(rootId);
    if (!root) continue;
    for (const childId of root.children) {
      const node = buildNode(childId);
      if (node) rootNodes.push(node);
    }
  }

  if (rootNodes.length === 0) {
    return { file: 'Empty Tree', type: null, state: [], children: [], _runtime: true };
  } else if (rootNodes.length === 1) {
    return rootNodes[0];
  } else {
    return {
      file: 'App',
      type: 'functional',
      state: [],
      children: rootNodes,
      _runtime: true,
      _runtimeId: -1,
      _displayName: 'App',
      _runtimeType: 'other',
    };
  }
}

// Mock runtime tree (similar to what DevTools connector produces)
function createMockTree() {
  const elements = new Map();

  // Root (synthetic DevTools container)
  elements.set(1, {
    id: 1,
    displayName: '',
    type: 'other',
    key: null,
    parentId: null,
    children: [2],
    depth: 0,
  });

  // App component
  elements.set(2, {
    id: 2,
    displayName: 'App',
    type: 'function',
    key: null,
    parentId: 1,
    children: [3, 4, 5],
    depth: 1,
  });

  // NavigationContainer
  elements.set(3, {
    id: 3,
    displayName: 'NavigationContainer',
    type: 'function',
    key: null,
    parentId: 2,
    children: [],
    depth: 2,
  });

  // View (host component)
  elements.set(4, {
    id: 4,
    displayName: 'View',
    type: 'host',
    key: null,
    parentId: 2,
    children: [],
    depth: 2,
  });

  // ProfileScreen (class component)
  elements.set(5, {
    id: 5,
    displayName: 'ProfileScreen',
    type: 'class',
    key: null,
    parentId: 2,
    children: [],
    depth: 2,
  });

  return { roots: [1], elements, rendererVersion: '18.2.0' };
}

test('converts flat tree to hierarchical structure', () => {
  const tree = createMockTree();
  const sourceMap = new Map();
  const hierarchy = buildRuntimeHierarchy(tree, sourceMap);

  assert(hierarchy.file === 'App', `Expected root 'App', got '${hierarchy.file}'`);
  assert(hierarchy._runtime === true, 'Expected _runtime flag');
  assert(hierarchy.children.length === 3, `Expected 3 children, got ${hierarchy.children.length}`);
});

test('maps runtime types correctly', () => {
  const tree = createMockTree();
  const sourceMap = new Map();
  const hierarchy = buildRuntimeHierarchy(tree, sourceMap);

  assert(hierarchy.type === 'functional', `Expected 'functional' for App, got '${hierarchy.type}'`);

  const navChild = hierarchy.children.find(c => c.file === 'NavigationContainer');
  assert(navChild.type === 'functional', 'NavigationContainer should be functional');
  assert(navChild._runtimeType === 'function', '_runtimeType should be "function"');

  const viewChild = hierarchy.children.find(c => c.file === 'View');
  assert(viewChild.type === null, 'View (host) should have null type');
  assert(viewChild._runtimeType === 'host', '_runtimeType should be "host"');

  const profileChild = hierarchy.children.find(c => c.file === 'ProfileScreen');
  assert(profileChild.type === 'class', 'ProfileScreen should be class');
});

test('includes runtime metadata on nodes', () => {
  const tree = createMockTree();
  const sourceMap = new Map();
  const hierarchy = buildRuntimeHierarchy(tree, sourceMap);

  assert(hierarchy._runtimeId === 2, `Expected runtimeId 2 for App, got ${hierarchy._runtimeId}`);
  assert(hierarchy._displayName === 'App', 'Expected _displayName "App"');

  const navChild = hierarchy.children.find(c => c.file === 'NavigationContainer');
  assert(navChild._runtimeId === 3, 'Expected runtimeId 3');
});

test('resolves source file paths from source map', () => {
  const tree = createMockTree();
  const sourceMap = new Map([
    ['App', '/src/App.tsx'],
    ['ProfileScreen', '/src/screens/ProfileScreen.tsx'],
  ]);
  const hierarchy = buildRuntimeHierarchy(tree, sourceMap);

  assert(hierarchy._sourceFile === '/src/App.tsx', 'Expected source file for App');
  const profileChild = hierarchy.children.find(c => c.file === 'ProfileScreen');
  assert(profileChild._sourceFile === '/src/screens/ProfileScreen.tsx', 'Expected source file for ProfileScreen');
  const navChild = hierarchy.children.find(c => c.file === 'NavigationContainer');
  assert(navChild._sourceFile === null, 'Expected null source for unmapped component');
});

test('handles empty tree gracefully', () => {
  const tree = { roots: [], elements: new Map(), rendererVersion: null };
  const hierarchy = buildRuntimeHierarchy(tree, new Map());
  assert(hierarchy.file === 'Empty Tree', 'Expected "Empty Tree" for empty tree');
  assert(hierarchy.children.length === 0, 'Expected no children');
});

test('handles multiple roots with synthetic wrapper', () => {
  const elements = new Map();
  // Root 1
  elements.set(1, { id: 1, displayName: '', type: 'other', key: null, parentId: null, children: [10], depth: 0 });
  elements.set(10, { id: 10, displayName: 'App1', type: 'function', key: null, parentId: 1, children: [], depth: 1 });
  // Root 2
  elements.set(2, { id: 2, displayName: '', type: 'other', key: null, parentId: null, children: [20], depth: 0 });
  elements.set(20, { id: 20, displayName: 'App2', type: 'function', key: null, parentId: 2, children: [], depth: 1 });

  const tree = { roots: [1, 2], elements, rendererVersion: null };
  const hierarchy = buildRuntimeHierarchy(tree, new Map());

  assert(hierarchy.file === 'App', 'Multiple roots should create synthetic "App" wrapper');
  assert(hierarchy.children.length === 2, 'Expected 2 children (one from each root)');
});

test('handles anonymous components', () => {
  const elements = new Map();
  elements.set(1, { id: 1, displayName: '', type: 'other', key: null, parentId: null, children: [2], depth: 0 });
  elements.set(2, { id: 2, displayName: '', type: 'function', key: null, parentId: 1, children: [], depth: 1 });

  const tree = { roots: [1], elements, rendererVersion: null };
  const hierarchy = buildRuntimeHierarchy(tree, new Map());

  assert(hierarchy.file === '(anonymous)', 'Anonymous components should show "(anonymous)"');
});

test('produces D3-compatible hierarchy (all nodes have children array)', () => {
  const tree = createMockTree();
  const hierarchy = buildRuntimeHierarchy(tree, new Map());

  function checkChildren(node) {
    assert(Array.isArray(node.children), `Node ${node.file} must have children array`);
    node.children.forEach(checkChildren);
  }
  checkChildren(hierarchy);
});

// ============================================================
// 2. package.json — New command registered
// ============================================================

console.log('\n\ud83d\udce6 package.json — showRuntimeTree Command');

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));

test('has showRuntimeTree command registered', () => {
  const commands = pkg.contributes.commands;
  const found = commands.find(c => c.command === 'dendro-react.showRuntimeTree');
  assert(found, 'dendro-react.showRuntimeTree command not found in package.json');
});

test('showRuntimeTree has correct title', () => {
  const cmd = pkg.contributes.commands.find(c => c.command === 'dendro-react.showRuntimeTree');
  assert(cmd.title.includes('Runtime'), `Expected title to include "Runtime", got "${cmd.title}"`);
});

test('showRuntimeTree has icon', () => {
  const cmd = pkg.contributes.commands.find(c => c.command === 'dendro-react.showRuntimeTree');
  assert(cmd.icon, 'Expected showRuntimeTree to have an icon');
});

test('repo URL is RooneyTech', () => {
  assert(
    pkg.repository.url.includes('RooneyTech'),
    `Expected repo URL to contain "RooneyTech", got "${pkg.repository.url}"`
  );
});

// ============================================================
// 3. Extension source — showRuntimeTree wiring
// ============================================================

console.log('\n\ud83d\udd0c Extension Source — Runtime Webview Wiring');

const extensionSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'server', 'extension.ts'),
  'utf-8'
);

test('extension has buildRuntimeHierarchy function', () => {
  assert(extensionSrc.includes('function buildRuntimeHierarchy'), 'Missing buildRuntimeHierarchy');
});

test('extension registers showRuntimeTree command', () => {
  assert(extensionSrc.includes("'dendro-react.showRuntimeTree'"), 'Missing showRuntimeTree command registration');
});

test('extension tracks runtime webview panels', () => {
  assert(extensionSrc.includes('runtimeWebviewPanels'), 'Missing runtimeWebviewPanels tracking');
});

test('extension pushes runtimeTreeData to webviews on tree-update', () => {
  assert(extensionSrc.includes("type: 'runtimeTreeData'"), 'Missing runtimeTreeData message send');
});

test('extension sends runtimeStatus on disconnect', () => {
  assert(extensionSrc.includes("type: 'runtimeStatus'"), 'Missing runtimeStatus message send');
});

test('extension handles inspectComponent message from webview', () => {
  assert(extensionSrc.includes("'inspectComponent'"), 'Missing inspectComponent handler');
});

test('extension handles openSourceFile message from webview', () => {
  assert(extensionSrc.includes("'openSourceFile'"), 'Missing openSourceFile handler');
});

test('extension has getRuntimeWebviewContent function', () => {
  assert(extensionSrc.includes('getRuntimeWebviewContent'), 'Missing getRuntimeWebviewContent');
});

test('runtime webview sets window.dendroRuntimeMode', () => {
  assert(extensionSrc.includes('dendroRuntimeMode'), 'Missing dendroRuntimeMode flag in runtime HTML');
});

// ============================================================
// 4. Webview index.js — Message handling
// ============================================================

console.log('\n\ud83d\udcf1 Webview index.js — Runtime Message Handling');

const indexSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'webview', 'index.js'),
  'utf-8'
);

test('webview handles runtimeTreeData message', () => {
  assert(indexSrc.includes('"runtimeTreeData"'), 'Missing runtimeTreeData handler');
});

test('webview handles runtimeStatus message', () => {
  assert(indexSrc.includes('"runtimeStatus"'), 'Missing runtimeStatus handler');
});

test('webview has calculateRuntimeStats function', () => {
  assert(indexSrc.includes('calculateRuntimeStats'), 'Missing calculateRuntimeStats');
});

test('webview initializes runtime mode from window flag', () => {
  assert(indexSrc.includes('window.dendroRuntimeMode'), 'Missing runtime mode initialization');
});

test('webview passes isRuntime prop to Dendrogram', () => {
  assert(indexSrc.includes('isRuntime={true}'), 'Missing isRuntime prop');
});

test('webview passes isRuntime prop to AppHeader', () => {
  assert(indexSrc.includes('isRuntime={true}'), 'Missing isRuntime prop on AppHeader');
});

test('webview passes runtimeStatus prop to AppHeader', () => {
  assert(indexSrc.includes('runtimeStatus='), 'Missing runtimeStatus prop');
});

// ============================================================
// 5. Dendrogram.jsx — Runtime mode support
// ============================================================

console.log('\n\ud83c\udf10 Dendrogram.jsx — Runtime Mode');

const dendrogramSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'webview', 'Dendrogram.jsx'),
  'utf-8'
);

test('Dendrogram accepts isRuntime prop', () => {
  assert(dendrogramSrc.includes('isRuntime'), 'Missing isRuntime prop');
});

test('Dendrogram shows LIVE badge in runtime mode', () => {
  assert(dendrogramSrc.includes('LIVE'), 'Missing LIVE badge');
});

test('Dendrogram handles inspectComponent click', () => {
  assert(dendrogramSrc.includes('inspectComponent'), 'Missing inspectComponent click handler');
});

test('Dendrogram handles openSourceFile click', () => {
  assert(dendrogramSrc.includes('openSourceFile'), 'Missing openSourceFile click handler');
});

test('Dendrogram shows runtime type info on nodes', () => {
  assert(dendrogramSrc.includes('_runtimeType'), 'Missing _runtimeType display');
});

test('Dendrogram maps runtime nodes by displayName for command lookups', () => {
  assert(dendrogramSrc.includes('_displayName'), 'Missing _displayName node mapping');
});

test('Dendrogram has live-pulse animation', () => {
  assert(dendrogramSrc.includes('live-pulse'), 'Missing live-pulse animation');
});

// ============================================================
// 6. AppHeader.jsx — Runtime mode support
// ============================================================

console.log('\n\ud83d\udcca AppHeader.jsx — Runtime Mode');

const appHeaderSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'webview', 'AppHeader.jsx'),
  'utf-8'
);

test('AppHeader accepts isRuntime prop', () => {
  assert(appHeaderSrc.includes('isRuntime'), 'Missing isRuntime prop');
});

test('AppHeader accepts runtimeStatus prop', () => {
  assert(appHeaderSrc.includes('runtimeStatus'), 'Missing runtimeStatus prop');
});

test('AppHeader shows runtime status badge', () => {
  assert(appHeaderSrc.includes('LIVE'), 'Missing LIVE status badge');
  assert(appHeaderSrc.includes('WAITING'), 'Missing WAITING status badge');
  assert(appHeaderSrc.includes('OFFLINE'), 'Missing OFFLINE status badge');
});

test('AppHeader shows Native pill for runtime host components', () => {
  assert(appHeaderSrc.includes('Native'), 'Missing Native pill');
  assert(appHeaderSrc.includes('hostCount'), 'Missing hostCount handling');
});

test('AppHeader handles zero totalComponents without NaN', () => {
  assert(appHeaderSrc.includes('totalComponents > 0'), 'Missing zero-division guard');
});

// ============================================================
// 7. Webpack build output
// ============================================================

console.log('\n\ud83d\udce6 Build Output');

test('dist/extension.js exists and contains runtime webview code', () => {
  const distPath = path.join(__dirname, '..', 'dist', 'extension.js');
  assert(fs.existsSync(distPath), 'dist/extension.js not found');
  const content = fs.readFileSync(distPath, 'utf-8');
  assert(content.includes('showRuntimeTree'), 'dist/extension.js missing showRuntimeTree');
  assert(content.includes('runtimeWebviewPanels'), 'dist/extension.js missing runtimeWebviewPanels');
});

test('dist/webview.js exists and contains runtime message handling', () => {
  const distPath = path.join(__dirname, '..', 'dist', 'webview.js');
  assert(fs.existsSync(distPath), 'dist/webview.js not found');
  const content = fs.readFileSync(distPath, 'utf-8');
  assert(content.includes('runtimeTreeData'), 'dist/webview.js missing runtimeTreeData');
});

// ============================================================
// Summary
// ============================================================

console.log(`\n${'='.repeat(50)}`);
console.log(`  ${passed + failed} tests | ${passed} passed | ${failed} failed`);
console.log(`${'='.repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
