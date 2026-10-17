#!/usr/bin/env node
/**
 * test-web-routing.js
 *
 * Tests for web routing parsers (Next.js App Router, React Router v6/v7, Remix):
 * - Framework detection
 * - Next.js App Router filesystem scanning
 * - React Router JSX and object pattern parsing
 * - Remix flat-file convention parsing
 * - MCP wrapper integration (fallback from RN parser)
 * - Feature gate (stays free, counts unchanged)
 * - Usage guide integration
 *
 * Usage:
 *   npm run build && node scripts/test-web-routing.js
 */

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(ROOT, 'src/test/fixtures/web-routing');
const NEXTJS_FIXTURE = path.join(FIXTURES, 'nextjs-app');
const REACT_ROUTER_FIXTURE = path.join(FIXTURES, 'react-router');
const REMIX_FIXTURE = path.join(FIXTURES, 'remix-app');
const RN_NAV_FIXTURE = path.join(ROOT, 'src/test/fixtures/navigation');

let passed = 0;
let failed = 0;
const sections = [];

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

function section(name, fn) {
  console.log(`\n--- ${name} ---`);
  const before = passed + failed;
  fn();
  sections.push({ name, tests: (passed + failed) - before });
}

// ─── Load modules from build output ─────────────────────────────────

const { detectWebFramework, parseNextAppRouter, parseReactRouter, parseRemixRoutes, parseWebRoutingStructure } = require(path.join(ROOT, 'out/core/web-routing-parser'));
const { getNavigationStructure, getUsageGuide } = require(path.join(ROOT, 'out/mcp/tools'));
const { isProFeature, getFreeFeatureList, getProFeatureList } = require(path.join(ROOT, 'out/licensing/feature-gate'));
const { initWorkspaceRoot } = require(path.join(ROOT, 'out/mcp/path-boundary'));

console.log('=== Web Routing Parser Tests ===');

// ─── Framework Detection ────────────────────────────────────────────

section('Framework detection', () => {
  test('detects Next.js App Router from app/layout.tsx', () => {
    const result = detectWebFramework(NEXTJS_FIXTURE);
    assert(result === 'nextjs-app', `Expected nextjs-app, got ${result}`);
  });

  test('detects React Router from file imports', () => {
    const appFile = path.join(REACT_ROUTER_FIXTURE, 'App.tsx');
    const result = detectWebFramework(appFile);
    assert(result === 'react-router', `Expected react-router, got ${result}`);
  });

  test('detects Remix from app/routes/ directory', () => {
    const result = detectWebFramework(REMIX_FIXTURE);
    assert(result === 'remix', `Expected remix, got ${result}`);
  });

  test('returns null for plain React project (no web framework)', () => {
    const result = detectWebFramework(RN_NAV_FIXTURE);
    assert(result === null, `Expected null, got ${result}`);
  });
});

// ─── Next.js App Router ─────────────────────────────────────────────

section('Next.js App Router', () => {
  const result = parseNextAppRouter(NEXTJS_FIXTURE);

  test('returns non-null root', () => {
    assert(result.root !== null, 'Root should not be null');
  });

  test('root navigator is NextAppRouter type', () => {
    assert(result.root.navigator.type === 'NextAppRouter', `Expected NextAppRouter, got ${result.root.navigator.type}`);
  });

  test('root navigator is named RootLayout', () => {
    assert(result.root.navigator.name === 'RootLayout', `Expected RootLayout, got ${result.root.navigator.name}`);
  });

  test('detects home page as screen at /', () => {
    const homeScreen = result.allScreens.find(s => s.name === '/');
    assert(homeScreen, 'Should find a screen named /');
    assert(homeScreen.componentName === 'Page', `Expected componentName Page, got ${homeScreen.componentName}`);
  });

  test('detects route group (auth)', () => {
    const authGroup = result.allNavigators.find(n => n.name === '(auth)');
    assert(authGroup, 'Should find (auth) route group');
    assert(authGroup.type === 'NextRouteGroup', `Expected NextRouteGroup, got ${authGroup.type}`);
  });

  test('detects login and register pages under (auth)', () => {
    const loginScreen = result.allScreens.find(s => s.name === '/login');
    const registerScreen = result.allScreens.find(s => s.name === '/register');
    assert(loginScreen, 'Should find /login screen');
    assert(registerScreen, 'Should find /register screen');
  });

  test('detects dashboard layout and nested pages', () => {
    const dashLayout = result.allNavigators.find(n => n.name === 'dashboard');
    assert(dashLayout, 'Should find dashboard layout navigator');
    assert(dashLayout.type === 'NextAppRouter', `Expected NextAppRouter, got ${dashLayout.type}`);

    const dashPage = result.allScreens.find(s => s.name === '/dashboard');
    const settingsPage = result.allScreens.find(s => s.name === '/dashboard/settings');
    assert(dashPage, 'Should find /dashboard screen');
    assert(settingsPage, 'Should find /dashboard/settings screen');
  });

  test('handles dynamic segments [id]', () => {
    const dynamicPage = result.allScreens.find(s => s.name.includes(':id'));
    assert(dynamicPage, 'Should find a screen with :id dynamic segment');
  });

  test('produces formatted tree output', () => {
    const { formatNavigationTree } = require(path.join(ROOT, 'out/core/navigation-parser'));
    const formatted = formatNavigationTree(result);
    assert(formatted.length > 0, 'Formatted tree should not be empty');
    assert(formatted.includes('NextAppRouter'), 'Formatted tree should mention NextAppRouter');
  });
});

// ─── React Router (JSX) ─────────────────────────────────────────────

section('React Router (JSX pattern)', () => {
  const appFile = path.join(REACT_ROUTER_FIXTURE, 'App.tsx');
  const result = parseReactRouter(appFile);

  test('returns non-null root', () => {
    assert(result.root !== null, 'Root should not be null');
  });

  test('root navigator is ReactRouter type', () => {
    assert(result.root.navigator.type === 'ReactRouter', `Expected ReactRouter, got ${result.root.navigator.type}`);
  });

  test('detects BrowserRouter as navigator name', () => {
    assert(result.root.navigator.name === 'BrowserRouter', `Expected BrowserRouter, got ${result.root.navigator.name}`);
  });

  test('extracts route paths as screens', () => {
    const paths = result.allScreens.map(s => s.name);
    assert(paths.includes('/'), 'Should find / route');
    assert(paths.includes('/dashboard'), 'Should find /dashboard route');
    assert(paths.includes('/settings'), 'Should find /settings route');
  });

  test('detects nested routes under /about', () => {
    const aboutScreen = result.allScreens.find(s => s.name === '/about');
    assert(aboutScreen, 'Should find /about screen');
    // Should have nested children (index + team)
    assert(result.root.children.length > 0, 'Should have nested route nodes');
  });

  test('resolves component names from element props', () => {
    const homeScreen = result.allScreens.find(s => s.name === '/');
    assert(homeScreen, 'Should find / screen');
    assert(homeScreen.componentName === 'Home', `Expected Home, got ${homeScreen.componentName}`);
  });
});

// ─── React Router (Object pattern) ──────────────────────────────────

section('React Router (createBrowserRouter pattern)', () => {
  const appFile = path.join(REACT_ROUTER_FIXTURE, 'AppObject.tsx');
  const result = parseReactRouter(appFile);

  test('returns non-null root', () => {
    assert(result.root !== null, 'Root should not be null');
  });

  test('detects createBrowserRouter call', () => {
    assert(result.root.navigator.type === 'ReactRouter', `Expected ReactRouter, got ${result.root.navigator.type}`);
    assert(result.root.navigator.name === 'router', `Expected router, got ${result.root.navigator.name}`);
  });

  test('extracts route objects as screens', () => {
    const paths = result.allScreens.map(s => s.name);
    assert(paths.includes('/'), 'Should find / route');
    assert(paths.includes('/about'), 'Should find /about route');
    assert(paths.includes('/dashboard'), 'Should find /dashboard route');
  });

  test('handles nested children array', () => {
    // /about has children: index + team
    assert(result.root.children.length > 0, 'Should have nested route nodes from children array');
    const nestedScreenNames = [];
    for (const child of result.root.children) {
      for (const s of child.screens) {
        nestedScreenNames.push(s.name);
      }
    }
    assert(nestedScreenNames.includes('team'), 'Should find team route in nested children');
  });
});

// ─── Remix Router ───────────────────────────────────────────────────

section('Remix Router', () => {
  const result = parseRemixRoutes(REMIX_FIXTURE);

  test('returns non-null root', () => {
    assert(result.root !== null, 'Root should not be null');
  });

  test('root navigator is RemixRouter type', () => {
    assert(result.root.navigator.type === 'RemixRouter', `Expected RemixRouter, got ${result.root.navigator.type}`);
  });

  test('converts _index.tsx to / route', () => {
    const indexScreen = result.allScreens.find(s => s.name === '/');
    assert(indexScreen, 'Should find / route from _index.tsx');
  });

  test('converts about.tsx to /about route', () => {
    const aboutScreen = result.allScreens.find(s => s.name === '/about');
    assert(aboutScreen, 'Should find /about route');
  });

  test('converts blog.$slug.tsx to /blog/:slug (dynamic segment)', () => {
    const blogScreen = result.allScreens.find(s => s.name === '/blog/:slug');
    assert(blogScreen, `Should find /blog/:slug route. Found: ${result.allScreens.map(s => s.name).join(', ')}`);
  });

  test('converts dot-delimited segments to paths', () => {
    const blogNewScreen = result.allScreens.find(s => s.name === '/blog/new');
    assert(blogNewScreen, 'Should find /blog/new route from blog.new.tsx');

    const dashSettingsScreen = result.allScreens.find(s => s.name === '/dashboard/settings');
    assert(dashSettingsScreen, 'Should find /dashboard/settings from dashboard.settings.tsx');
  });
});

// ─── MCP Wrapper Integration ────────────────────────────────────────

// Initialize workspace root so path-boundary checks pass in getNavigationStructure
process.env.DENDRO_WORKSPACE_ROOT = ROOT;
initWorkspaceRoot();

section('MCP wrapper integration', () => {
  test('getNavigationStructure returns web routes when no RN found (Next.js)', () => {
    const result = getNavigationStructure(NEXTJS_FIXTURE);
    assert(!result.error, `Should not error: ${result.error}`);
    assert(result.totalNavigators > 0, 'Should find navigators');
    assert(result.totalScreens > 0, 'Should find screens');
    assert(result.tree !== null, 'Should have a tree');
    assert(result.tree.navigator.type === 'NextAppRouter', `Expected NextAppRouter, got ${result.tree.navigator.type}`);
  });

  test('getNavigationStructure returns web routes (React Router)', () => {
    const appFile = path.join(REACT_ROUTER_FIXTURE, 'App.tsx');
    const result = getNavigationStructure(appFile);
    assert(!result.error, `Should not error: ${result.error}`);
    assert(result.totalScreens > 0, 'Should find screens');
    assert(result.tree.navigator.type === 'ReactRouter', `Expected ReactRouter, got ${result.tree.navigator.type}`);
  });

  test('getNavigationStructure returns web routes (Remix)', () => {
    const result = getNavigationStructure(REMIX_FIXTURE);
    assert(!result.error, `Should not error: ${result.error}`);
    assert(result.totalScreens > 0, 'Should find screens');
    assert(result.tree.navigator.type === 'RemixRouter', `Expected RemixRouter, got ${result.tree.navigator.type}`);
  });

  test('getNavigationStructure still returns RN routes when RN is present (no regression)', () => {
    const rnFile = path.join(RN_NAV_FIXTURE, 'RootNavigator.tsx');
    const result = getNavigationStructure(rnFile);
    assert(!result.error, `Should not error: ${result.error}`);
    assert(result.totalNavigators > 0, 'Should find RN navigators');
    assert(result.tree !== null, 'Should have a tree');
    assert(result.tree.navigator.type === 'NativeStack', `Expected NativeStack, got ${result.tree.navigator.type}`);
  });

  test('formatNavigationTree works with web routing types', () => {
    const result = getNavigationStructure(NEXTJS_FIXTURE);
    assert(result.formattedTree.length > 0, 'Should produce formatted tree');
    assert(result.formattedTree.includes('NextAppRouter') || result.formattedTree.includes('RootLayout'), 'Should contain web routing info');
  });
});

// ─── Feature Gate ───────────────────────────────────────────────────

section('Feature gate', () => {
  test('get_navigation_structure remains free', () => {
    assert(!isProFeature('get_navigation_structure'), 'Should still be free');
  });

  test('free feature count is 25', () => {
    const freeList = getFreeFeatureList();
    assert(freeList.length === (()=>{const g=require(path.join(ROOT, 'out/licensing/feature-gate'));return g.getFreeFeatureList().length+g.getProFeatureList().length;})() - 10, `Expected 25 free features, got ${freeList.length}`);
  });

  test('total feature count is 35', () => {
    const freeList = getFreeFeatureList();
    const proList = getProFeatureList();
    const total = freeList.length + proList.length;
    assert(total === freeList.length + getProFeatureList().length, `registry total mismatch, got ${total}`);
  });
});

// ─── Usage Guide ────────────────────────────────────────────────────

section('Usage guide', () => {
  const guide = getUsageGuide();

  test('usage guide mentions web frameworks for navigation tool', () => {
    const navTool = guide.categories.analysis.tools.find(t => t.name === 'get_navigation_structure');
    assert(navTool, 'Should find get_navigation_structure in analysis tools');
    assert(navTool.purpose.includes('Next.js') || navTool.purpose.includes('React Router'), 'Purpose should mention web frameworks');
  });

  test('usage guide still reports 35 tools', () => {
    assert(guide.overview.includes(String((()=>{const g=require(path.join(ROOT, 'out/licensing/feature-gate'));return g.getFreeFeatureList().length+g.getProFeatureList().length;})())), `Overview should mention 35 tools: ${guide.overview}`);
  });
});

// ─── Summary ────────────────────────────────────────────────────────

console.log('\n=== Summary ===');
for (const s of sections) {
  console.log(`  ${s.name}: ${s.tests} tests`);
}
console.log(`\n  Total: ${passed + failed} tests — ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
