/**
 * Web Routing Parser
 *
 * Detects and extracts routing patterns from web React frameworks.
 * Supports: Next.js App Router, React Router v6/v7, Remix v2.
 * Falls back from navigation-parser.ts when no React Navigation found.
 *
 * @module web-routing-parser
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseSync } from 'oxc-parser';
import { resolveImportPath, EXTENSIONS } from '../server/parser-oxc';
import { walkASTSimple, type ESTreeNode } from './utils/ast-walker';
import { scanComponentFiles } from './utils/file-scanner';
import type {
  NavigatorType,
  NavigatorInfo,
  ScreenInfo,
  NavigationNode,
  NavigationStructure,
} from './navigation-parser';

// ─── Types ──────────────────────────────────────────────────────────

export type WebFramework = 'nextjs-app' | 'nextjs-pages' | 'react-router' | 'remix' | 'expo-router';

// Extended ESTree node types used by this parser

interface Identifier extends ESTreeNode {
  type: 'Identifier';
  name: string;
}

// Next.js special files
const NEXTJS_PAGE_FILE = 'page';
const NEXTJS_LAYOUT_FILE = 'layout';
const NEXTJS_SPECIAL_FILES = new Set([
  'loading', 'error', 'not-found', 'template', 'default',
  'route', 'middleware', 'instrumentation',
]);

// React Router creator functions
const REACT_ROUTER_CREATORS = new Set([
  'createBrowserRouter',
  'createHashRouter',
  'createMemoryRouter',
]);

// React Router JSX wrapper components
const REACT_ROUTER_WRAPPERS = new Set([
  'BrowserRouter',
  'HashRouter',
  'MemoryRouter',
  'RouterProvider',
]);

const VALID_EXTENSIONS = new Set(EXTENSIONS);

// ─── Helpers ────────────────────────────────────────────────────────

// walkAST replaced by walkASTSimple from utils/ast-walker
const walkAST = walkASTSimple;

function getLineNumber(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length;
}

/**
 * Check if a file exists with any valid extension
 */
function findFileWithExtension(basePath: string): string | null {
  for (const ext of EXTENSIONS) {
    const fullPath = `${basePath}${ext}`;
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      return fullPath;
    }
  }
  return null;
}

/**
 * Find nearest package.json walking up from a directory
 */
function findPackageJson(startDir: string): Record<string, unknown> | null {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        return JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      } catch {
        return null;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Check if a dependency exists in package.json
 */
function hasDependency(pkg: Record<string, unknown>, name: string): boolean {
  const deps = pkg.dependencies as Record<string, string> | undefined;
  const devDeps = pkg.devDependencies as Record<string, string> | undefined;
  return !!(deps?.[name] || devDeps?.[name]);
}

/**
 * Scan directory for component files (non-recursive helper for single-level)
 */
// findComponentFilesInDir replaced by scanComponentFiles from utils/file-scanner
function findComponentFilesInDir(dir: string, maxDepth = 5): string[] {
  return scanComponentFiles(dir, { maxDepth });
}

// ─── Framework Detection ────────────────────────────────────────────

/**
 * Detect which web framework a project uses.
 * Returns null if no recognized web framework is found.
 */
export function detectWebFramework(rootPath: string): WebFramework | null {
  const stats = fs.existsSync(rootPath) ? fs.statSync(rootPath) : null;
  if (!stats) return null;

  if (stats.isDirectory()) {
    // Check filesystem indicators
    const appDir = path.join(rootPath, 'app');
    const pkg = findPackageJson(rootPath);

    if (fs.existsSync(appDir) && fs.statSync(appDir).isDirectory()) {
      // Expo Router uses app/_layout.* + app/index.* — check BEFORE Next.js,
      // since both frameworks live in an app/ directory.
      if (findFileWithExtension(path.join(appDir, '_layout')) ||
          (pkg && hasDependency(pkg, 'expo-router'))) {
        return 'expo-router';
      }

      // Check for Next.js App Router: app/layout.tsx or app/page.tsx
      if (findFileWithExtension(path.join(appDir, NEXTJS_LAYOUT_FILE)) ||
          findFileWithExtension(path.join(appDir, NEXTJS_PAGE_FILE))) {
        return 'nextjs-app';
      }

      // Check for Remix: app/routes/ directory
      const routesDir = path.join(appDir, 'routes');
      if (fs.existsSync(routesDir) && fs.statSync(routesDir).isDirectory()) {
        return 'remix';
      }
    }

    // Next.js Pages Router: pages/ (or src/pages/) directory
    for (const pagesDir of [path.join(rootPath, 'pages'), path.join(rootPath, 'src', 'pages')]) {
      if (fs.existsSync(pagesDir) && fs.statSync(pagesDir).isDirectory() &&
          pkg && hasDependency(pkg, 'next')) {
        return 'nextjs-pages';
      }
    }

    // Fallback: check package.json
    if (pkg) {
      if (hasDependency(pkg, 'expo-router')) return 'expo-router';
      // `next` alone doesn't say WHICH router — the app/ and pages/ checks
      // above already ran, so default to App Router (its parser emits a clear
      // warning when app/ is absent instead of a silent empty result).
      if (hasDependency(pkg, 'next')) return 'nextjs-app';
      if (hasDependency(pkg, '@remix-run/react') || hasDependency(pkg, '@remix-run/node')) return 'remix';
      if (hasDependency(pkg, 'react-router-dom') || hasDependency(pkg, 'react-router')) return 'react-router';
    }

    // Scan files for React Router imports
    const files = findComponentFilesInDir(rootPath, 3);
    for (const file of files.slice(0, 50)) { // Limit scan to first 50 files
      try {
        const content = fs.readFileSync(file, 'utf-8');
        if (content.includes('react-router-dom') || content.includes('react-router')) {
          return 'react-router';
        }
      } catch { /* skip */ }
    }
  } else {
    // Single file: check for React Router imports
    try {
      const content = fs.readFileSync(rootPath, 'utf-8');
      if (content.includes('react-router-dom') || content.includes('react-router')) {
        return 'react-router';
      }
    } catch { /* skip */ }
  }

  return null;
}

// ─── Next.js App Router Parser ──────────────────────────────────────

/**
 * Convert a Next.js directory segment to a route path segment.
 * (auth) → route group (no path segment)
 * [param] → :param
 * [...catchAll] → :catchAll*
 * [[...optional]] → :optional?
 * @slot → parallel route (skip in path)
 */
function nextjsSegmentToPath(segment: string): { path: string; isGroup: boolean; isParallel: boolean } {
  // Route group: (groupName)
  if (segment.startsWith('(') && segment.endsWith(')')) {
    return { path: '', isGroup: true, isParallel: false };
  }

  // Parallel route: @slotName
  if (segment.startsWith('@')) {
    return { path: '', isGroup: false, isParallel: true };
  }

  // Optional catch-all: [[...param]]
  if (segment.startsWith('[[...') && segment.endsWith(']]')) {
    const param = segment.slice(5, -2);
    return { path: `:${param}?`, isGroup: false, isParallel: false };
  }

  // Catch-all: [...param]
  if (segment.startsWith('[...') && segment.endsWith(']')) {
    const param = segment.slice(4, -1);
    return { path: `:${param}*`, isGroup: false, isParallel: false };
  }

  // Dynamic segment: [param]
  if (segment.startsWith('[') && segment.endsWith(']')) {
    const param = segment.slice(1, -1);
    return { path: `:${param}`, isGroup: false, isParallel: false };
  }

  // Static segment
  return { path: segment, isGroup: false, isParallel: false };
}

/**
 * Parse a Next.js App Router directory structure into NavigationStructure.
 */
export function parseNextAppRouter(rootPath: string): NavigationStructure {
  const warnings: string[] = [];
  const allNavigators: NavigatorInfo[] = [];
  const allScreens: ScreenInfo[] = [];

  // Find the app/ directory
  let appDir: string;
  const appSubDir = path.join(rootPath, 'app');
  if (fs.existsSync(appSubDir) && fs.statSync(appSubDir).isDirectory()) {
    appDir = appSubDir;
  } else if (path.basename(rootPath) === 'app') {
    appDir = rootPath;
  } else {
    return { root: null, allNavigators: [], allScreens: [], warnings: ['No app/ directory found for Next.js App Router'] };
  }

  function scanDir(dir: string, routePrefix: string, parentName: string, depth = 0): NavigationNode | null {
    if (depth > 20) return null;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      warnings.push(`Cannot read directory: ${dir}`);
      return null;
    }
    const layoutFile = findFileWithExtension(path.join(dir, NEXTJS_LAYOUT_FILE));
    const pageFile = findFileWithExtension(path.join(dir, NEXTJS_PAGE_FILE));

    // Determine navigator name from directory
    const dirName = path.basename(dir);
    const isRoot = dir === appDir;
    const navigatorName = isRoot ? 'RootLayout' : parentName || dirName;
    const segmentInfo = nextjsSegmentToPath(dirName);

    const navigatorType: NavigatorType = segmentInfo.isGroup ? 'NextRouteGroup' : 'NextAppRouter';

    // Only create a navigator node if there's a layout or this is a route group
    const hasLayout = !!layoutFile;
    const isGroup = segmentInfo.isGroup;
    const isParallel = segmentInfo.isParallel;

    if (isParallel) {
      warnings.push(`Parallel route @${dirName.slice(1)} detected at ${dir}`);
    }

    const navigator: NavigatorInfo = {
      name: isRoot ? 'RootLayout' : isGroup ? dirName : navigatorName,
      type: navigatorType,
      variableName: isRoot ? 'app' : dirName,
      filePath: layoutFile || dir,
      line: 1,
    };
    allNavigators.push(navigator);

    const screens: ScreenInfo[] = [];
    const children: NavigationNode[] = [];

    // Add page as a screen
    if (pageFile) {
      const routePath = routePrefix || '/';
      const screen: ScreenInfo = {
        name: routePath,
        componentName: 'Page',
        componentPath: pageFile,
        navigatorName: navigator.variableName,
        filePath: pageFile,
        line: 1,
      };
      screens.push(screen);
      allScreens.push(screen);
    }

    // Note special files
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const nameWithoutExt = path.parse(entry.name).name;
      if (NEXTJS_SPECIAL_FILES.has(nameWithoutExt)) {
        // Not added as screens — just noted
      }
    }

    // Recurse into subdirectories
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

      const subDir = path.join(dir, entry.name);
      const subSegment = nextjsSegmentToPath(entry.name);

      let subRoutePrefix: string;
      if (subSegment.isGroup || subSegment.isParallel) {
        subRoutePrefix = routePrefix; // Groups don't add to the path
      } else if (subSegment.path) {
        subRoutePrefix = `${routePrefix}/${subSegment.path}`;
      } else {
        subRoutePrefix = routePrefix;
      }

      const childNode = scanDir(subDir, subRoutePrefix, entry.name, depth + 1);
      if (childNode) {
        children.push(childNode);
      }
    }

    // Only return a node if it has content
    if (screens.length === 0 && children.length === 0 && !hasLayout && !isGroup) {
      // Remove the navigator we added since this dir has no routing content
      allNavigators.pop();
      return null;
    }

    return { navigator, screens, children };
  }

  const root = scanDir(appDir, '', 'RootLayout');

  return { root, allNavigators, allScreens, warnings };
}

// ─── React Router Parser ────────────────────────────────────────────

/**
 * Parse React Router v6/v7 route definitions from source files.
 * Supports both JSX (<Route>) and object (createBrowserRouter) patterns.
 */
export function parseReactRouter(rootPath: string): NavigationStructure {
  const warnings: string[] = [];
  const allNavigators: NavigatorInfo[] = [];
  const allScreens: ScreenInfo[] = [];

  if (!fs.existsSync(rootPath)) {
    return { root: null, allNavigators: [], allScreens: [], warnings: [`Path not found: ${rootPath}`] };
  }
  const stats = fs.statSync(rootPath);
  let filesToScan: string[];

  if (stats.isDirectory()) {
    // Find files that import from react-router
    filesToScan = findComponentFilesInDir(rootPath, 5).filter((file) => {
      try {
        const content = fs.readFileSync(file, 'utf-8');
        return content.includes('react-router');
      } catch {
        return false;
      }
    });
  } else {
    filesToScan = [rootPath];
  }

  if (filesToScan.length === 0) {
    return { root: null, allNavigators: [], allScreens: [], warnings: ['No React Router files found'] };
  }

  let rootNode: NavigationNode | null = null;

  for (const filePath of filesToScan) {
    let source: string;
    try {
      source = fs.readFileSync(filePath, 'utf-8');
    } catch {
      warnings.push(`Failed to read ${filePath}`);
      continue;
    }
    const filename = path.basename(filePath);

    let ast;
    try {
      ast = parseSync(filename, source);
    } catch {
      warnings.push(`Failed to parse ${filePath}`);
      continue;
    }

    const fileDir = path.dirname(filePath);

    // Build import map for component resolution
    const imports = new Map<string, string>();
    const module = ast.module;
    if (module?.staticImports) {
      for (const imp of module.staticImports) {
        const importPath = imp.moduleRequest.value;
        if (imp.entries) {
          for (const entry of imp.entries) {
            const localName = (entry.localName as { value?: string })?.value;
            if (localName) imports.set(localName, importPath);
          }
        }
      }
    }

    // Try JSX pattern: <BrowserRouter>/<Routes>/<Route>
    const jsxRoutes = parseReactRouterJSX(ast.program, source, filePath, fileDir, imports);
    if (jsxRoutes) {
      allNavigators.push(jsxRoutes.navigator);
      for (const s of jsxRoutes.screens) allScreens.push(s);
      collectNestedScreens(jsxRoutes.children, allNavigators, allScreens);
      if (!rootNode) rootNode = jsxRoutes;
    }

    // Try object pattern: createBrowserRouter([...])
    const objRoutes = parseReactRouterObject(ast.program, source, filePath, fileDir, imports);
    if (objRoutes) {
      allNavigators.push(objRoutes.navigator);
      for (const s of objRoutes.screens) allScreens.push(s);
      collectNestedScreens(objRoutes.children, allNavigators, allScreens);
      if (!rootNode) rootNode = objRoutes;
    }
  }

  return { root: rootNode, allNavigators, allScreens, warnings };
}

function collectNestedScreens(
  nodes: NavigationNode[],
  allNavigators: NavigatorInfo[],
  allScreens: ScreenInfo[]
): void {
  for (const node of nodes) {
    allNavigators.push(node.navigator);
    for (const s of node.screens) allScreens.push(s);
    collectNestedScreens(node.children, allNavigators, allScreens);
  }
}

/**
 * Parse JSX-based React Router patterns:
 * <BrowserRouter><Routes><Route path="..." element={<Comp />} /></Routes></BrowserRouter>
 */
function parseReactRouterJSX(
  program: unknown,
  source: string,
  filePath: string,
  fileDir: string,
  imports: Map<string, string>
): NavigationNode | null {
  let routerName: string | null = null;
  let routesNode: ESTreeNode | null = null;

  // Find the router wrapper and Routes element
  walkAST(program, (node) => {
    if (node.type !== 'JSXElement') return;
    const opening = (node as Record<string, unknown>).openingElement as ESTreeNode | undefined;
    if (!opening) return;
    const nameNode = (opening as Record<string, unknown>).name as ESTreeNode | undefined;
    if (!nameNode) return;

    let elementName: string | null = null;
    if (nameNode.type === 'JSXIdentifier' || nameNode.type === 'Identifier') {
      elementName = (nameNode as Identifier).name;
    }

    if (elementName && REACT_ROUTER_WRAPPERS.has(elementName)) {
      routerName = elementName;
    }
    if (elementName === 'Routes') {
      routesNode = node;
    }
  });

  if (!routesNode) return null;

  const navigator: NavigatorInfo = {
    name: routerName || 'Routes',
    type: 'ReactRouter' as NavigatorType,
    variableName: routerName || 'Routes',
    filePath,
    line: getLineNumber(source, (routesNode as ESTreeNode).start || 0),
  };

  const { screens, children } = extractRoutesFromJSX(routesNode, source, filePath, fileDir, imports, navigator.variableName);

  return { navigator, screens, children };
}

/**
 * Recursively extract Route elements from a JSX subtree
 */
function extractRoutesFromJSX(
  node: ESTreeNode,
  source: string,
  filePath: string,
  fileDir: string,
  imports: Map<string, string>,
  navigatorName: string
): { screens: ScreenInfo[]; children: NavigationNode[] } {
  const screens: ScreenInfo[] = [];
  const children: NavigationNode[] = [];

  const jsxChildren = (node as Record<string, unknown>).children as ESTreeNode[] | undefined;
  if (!jsxChildren) return { screens, children };

  for (const child of jsxChildren) {
    if (child.type !== 'JSXElement') continue;

    const opening = (child as Record<string, unknown>).openingElement as ESTreeNode | undefined;
    if (!opening) continue;
    const nameNode = (opening as Record<string, unknown>).name as ESTreeNode | undefined;
    if (!nameNode) continue;

    let elementName: string | null = null;
    if (nameNode.type === 'JSXIdentifier' || nameNode.type === 'Identifier') {
      elementName = (nameNode as Identifier).name;
    }

    if (elementName !== 'Route') continue;

    // Extract path and element attributes
    const attrs = (opening as Record<string, unknown>).attributes as ESTreeNode[] | undefined;
    let routePath: string | null = null;
    let componentName: string | null = null;
    let isIndex = false;

    if (attrs) {
      for (const attr of attrs) {
        if (attr.type !== 'JSXAttribute') continue;
        const attrName = ((attr as Record<string, unknown>).name as { name?: string })?.name;
        const attrValue = (attr as Record<string, unknown>).value as ESTreeNode | undefined;

        if (attrName === 'path' && attrValue) {
          if (attrValue.type === 'StringLiteral' || attrValue.type === 'Literal') {
            routePath = (attrValue as unknown as { value: string }).value;
          }
        } else if (attrName === 'element' && attrValue) {
          // JSXExpressionContainer with JSXElement: element={<Home />}
          if (attrValue.type === 'JSXExpressionContainer') {
            const expr = (attrValue as Record<string, unknown>).expression as ESTreeNode | undefined;
            if (expr?.type === 'JSXElement') {
              const innerOpening = (expr as Record<string, unknown>).openingElement as ESTreeNode | undefined;
              const innerName = innerOpening ? (innerOpening as Record<string, unknown>).name as ESTreeNode | undefined : undefined;
              if (innerName && (innerName.type === 'JSXIdentifier' || innerName.type === 'Identifier')) {
                componentName = (innerName as Identifier).name;
              }
            }
          }
        } else if (attrName === 'index') {
          isIndex = true;
        }
      }
    }

    const screenName = routePath || (isIndex ? 'index' : '(unnamed)');
    let componentPath: string | null = null;
    if (componentName && imports.has(componentName)) {
      const importPath = imports.get(componentName)!;
      componentPath = resolveImportPath(importPath, fileDir);
    }

    // Check if this Route has nested Route children
    const nested = extractRoutesFromJSX(child, source, filePath, fileDir, imports, navigatorName);

    if (nested.screens.length > 0 || nested.children.length > 0) {
      // This is a layout route with children
      const layoutNavigator: NavigatorInfo = {
        name: routePath || componentName || 'NestedRoutes',
        type: 'ReactRouter' as NavigatorType,
        variableName: componentName || 'layout',
        filePath,
        line: getLineNumber(source, child.start || 0),
      };

      // The parent route itself is a screen of the outer navigator
      const screen: ScreenInfo = {
        name: screenName,
        componentName,
        componentPath,
        navigatorName,
        filePath,
        line: getLineNumber(source, child.start || 0),
      };
      screens.push(screen);

      children.push({
        navigator: layoutNavigator,
        screens: nested.screens,
        children: nested.children,
      });
    } else {
      // Leaf route
      screens.push({
        name: screenName,
        componentName,
        componentPath,
        navigatorName,
        filePath,
        line: getLineNumber(source, child.start || 0),
      });
    }
  }

  return { screens, children };
}

/**
 * Parse object-based React Router patterns:
 * const router = createBrowserRouter([{ path: '/', element: <Home /> }])
 */
function parseReactRouterObject(
  program: unknown,
  source: string,
  filePath: string,
  fileDir: string,
  imports: Map<string, string>
): NavigationNode | null {
  let creatorCall: ESTreeNode | null = null;
  let routerVarName: string | null = null;

  walkAST(program, (node) => {
    if (node.type !== 'VariableDeclarator') return;
    const init = (node as Record<string, unknown>).init as ESTreeNode | undefined;
    if (!init || init.type !== 'CallExpression') return;

    const callee = (init as Record<string, unknown>).callee as ESTreeNode | undefined;
    if (!callee) return;

    let calleeName: string | null = null;
    if (callee.type === 'Identifier') {
      calleeName = (callee as Identifier).name;
    }

    if (calleeName && REACT_ROUTER_CREATORS.has(calleeName)) {
      creatorCall = init;
      const id = (node as Record<string, unknown>).id as ESTreeNode | undefined;
      if (id?.type === 'Identifier') {
        routerVarName = (id as Identifier).name;
      }
    }
  });

  if (!creatorCall) return null;

  const navigator: NavigatorInfo = {
    name: routerVarName || 'Router',
    type: 'ReactRouter' as NavigatorType,
    variableName: routerVarName || 'router',
    filePath,
    line: getLineNumber(source, (creatorCall as ESTreeNode).start || 0),
  };

  // Extract the array argument
  const args = (creatorCall as Record<string, unknown>).arguments as ESTreeNode[] | undefined;
  if (!args || args.length === 0) {
    return { navigator, screens: [], children: [] };
  }

  const routeArray = args[0];
  const { screens, children } = extractRoutesFromObject(
    routeArray, source, filePath, fileDir, imports, navigator.variableName
  );

  return { navigator, screens, children };
}

/**
 * Extract routes from an array of route objects
 */
function extractRoutesFromObject(
  arrayNode: ESTreeNode,
  source: string,
  filePath: string,
  fileDir: string,
  imports: Map<string, string>,
  navigatorName: string
): { screens: ScreenInfo[]; children: NavigationNode[] } {
  const screens: ScreenInfo[] = [];
  const children: NavigationNode[] = [];

  if (arrayNode.type !== 'ArrayExpression') return { screens, children };

  const elements = (arrayNode as Record<string, unknown>).elements as ESTreeNode[] | undefined;
  if (!elements) return { screens, children };

  for (const element of elements) {
    if (element.type !== 'ObjectExpression') continue;

    const properties = (element as Record<string, unknown>).properties as ESTreeNode[] | undefined;
    if (!properties) continue;

    let routePath: string | null = null;
    let componentName: string | null = null;
    let childrenArray: ESTreeNode | null = null;
    let isIndex = false;

    for (const prop of properties) {
      if (prop.type !== 'Property' && prop.type !== 'ObjectProperty') continue;
      const key = (prop as Record<string, unknown>).key as ESTreeNode | undefined;
      const value = (prop as Record<string, unknown>).value as ESTreeNode | undefined;
      if (!key || !value) continue;

      const keyName = key.type === 'Identifier' ? (key as Identifier).name : null;

      if (keyName === 'path') {
        if (value.type === 'StringLiteral' || value.type === 'Literal') {
          routePath = (value as unknown as { value: string }).value;
        }
      } else if (keyName === 'element') {
        // element: <Component />
        if (value.type === 'JSXElement') {
          const opening = (value as Record<string, unknown>).openingElement as ESTreeNode | undefined;
          const nameNode = opening ? (opening as Record<string, unknown>).name as ESTreeNode | undefined : undefined;
          if (nameNode && (nameNode.type === 'JSXIdentifier' || nameNode.type === 'Identifier')) {
            componentName = (nameNode as Identifier).name;
          }
        }
      } else if (keyName === 'children') {
        childrenArray = value;
      } else if (keyName === 'index') {
        if (value.type === 'BooleanLiteral' || value.type === 'Literal') {
          isIndex = !!(value as unknown as { value: boolean }).value;
        }
      }
    }

    const screenName = routePath || (isIndex ? 'index' : '(unnamed)');
    let componentPath: string | null = null;
    if (componentName && imports.has(componentName)) {
      const importPath = imports.get(componentName)!;
      componentPath = resolveImportPath(importPath, fileDir);
    }

    if (childrenArray) {
      // Layout route with children
      const layoutNavigator: NavigatorInfo = {
        name: routePath || componentName || 'NestedRoutes',
        type: 'ReactRouter' as NavigatorType,
        variableName: componentName || 'layout',
        filePath,
        line: getLineNumber(source, element.start || 0),
      };

      screens.push({
        name: screenName,
        componentName,
        componentPath,
        navigatorName,
        filePath,
        line: getLineNumber(source, element.start || 0),
      });

      const nested = extractRoutesFromObject(
        childrenArray, source, filePath, fileDir, imports, layoutNavigator.variableName
      );

      children.push({
        navigator: layoutNavigator,
        screens: nested.screens,
        children: nested.children,
      });
    } else {
      screens.push({
        name: screenName,
        componentName,
        componentPath,
        navigatorName,
        filePath,
        line: getLineNumber(source, element.start || 0),
      });
    }
  }

  return { screens, children };
}

// ─── Remix Router Parser ────────────────────────────────────────────

/**
 * Convert a Remix v2 flat-file route filename to a URL path.
 * _index.tsx → /
 * about.tsx → /about
 * blog.$slug.tsx → /blog/:slug
 * blog.new.tsx → /blog/new
 * dashboard.settings.tsx → /dashboard/settings
 */
function remixFileToRoutePath(filename: string): string {
  // Remove extension — only a KNOWN code extension. path.parse() would treat
  // the ".$slug" in a folder-convention name like "blog.$slug" as an extension.
  const ext = path.extname(filename);
  const name = VALID_EXTENSIONS.has(ext) ? filename.slice(0, -ext.length) : filename;

  // Index route
  if (name === '_index') return '/';

  // Remove leading underscore (pathless layout prefix)
  const cleanName = name.startsWith('_') ? name.slice(1) : name;

  // Split on dots to get segments
  const segments = cleanName.split('.');

  // Convert each segment
  const pathSegments = segments.map((seg) => {
    // Dynamic segment: $param → :param
    if (seg.startsWith('$')) {
      return `:${seg.slice(1)}`;
    }
    // Trailing underscore on segment = pathless layout
    if (seg.endsWith('_')) {
      return seg.slice(0, -1);
    }
    return seg;
  });

  return '/' + pathSegments.join('/');
}

/**
 * Parse Remix v2 flat-file routes from app/routes/ directory.
 */
export function parseRemixRoutes(rootPath: string): NavigationStructure {
  const warnings: string[] = [];
  const allNavigators: NavigatorInfo[] = [];
  const allScreens: ScreenInfo[] = [];

  // Find the routes directory
  let routesDir: string | null = null;

  const appRoutesDir = path.join(rootPath, 'app', 'routes');
  if (fs.existsSync(appRoutesDir) && fs.statSync(appRoutesDir).isDirectory()) {
    routesDir = appRoutesDir;
  } else {
    // Check if rootPath itself is the routes dir or contains it
    const directRoutesDir = path.join(rootPath, 'routes');
    if (fs.existsSync(directRoutesDir) && fs.statSync(directRoutesDir).isDirectory()) {
      routesDir = directRoutesDir;
    }
  }

  if (!routesDir) {
    return { root: null, allNavigators: [], allScreens: [], warnings: ['No routes/ directory found for Remix'] };
  }

  const navigator: NavigatorInfo = {
    name: 'RemixRouter',
    type: 'RemixRouter' as NavigatorType,
    variableName: 'routes',
    filePath: routesDir,
    line: 1,
  };
  allNavigators.push(navigator);

  // Read all route files
  try {
    const entries = fs.readdirSync(routesDir, { withFileTypes: true });

    for (const entry of entries) {
      let routeName: string;
      let fullPath: string;

      if (entry.isDirectory()) {
        // Remix/RR7 folder convention: routes/blog.$slug/route.tsx — the
        // DIRECTORY name carries the route; the file inside is always route.*
        const routeFile = findFileWithExtension(path.join(routesDir, entry.name, 'route'));
        if (!routeFile) continue;
        routeName = entry.name;
        fullPath = routeFile;
      } else {
        const ext = path.extname(entry.name);
        if (!VALID_EXTENSIONS.has(ext)) continue;
        routeName = entry.name;
        fullPath = path.join(routesDir, entry.name);
      }

      const routePath = remixFileToRoutePath(routeName);

      const screen: ScreenInfo = {
        name: routePath,
        componentName: entry.isDirectory() ? entry.name : path.parse(entry.name).name,
        componentPath: fullPath,
        navigatorName: navigator.variableName,
        filePath: fullPath,
        line: 1,
      };

      allScreens.push(screen);
    }
  } catch (err) {
    warnings.push(`Error reading routes directory: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Sort screens by path for consistent output
  allScreens.sort((a, b) => a.name.localeCompare(b.name));

  const root: NavigationNode = {
    navigator,
    screens: allScreens,
    children: [],
  };

  return { root, allNavigators, allScreens, warnings };
}

// ─── Expo Router (file-based, app/_layout.*) ────────────────────────

/** Convert an Expo Router path segment to a route segment ('' = adds nothing). */
function expoSegmentToPath(segment: string): string {
  if (segment.startsWith('(') && segment.endsWith(')')) return ''; // group
  if (segment.startsWith('[...') && segment.endsWith(']')) return `*${segment.slice(4, -1)}`;
  if (segment.startsWith('[') && segment.endsWith(']')) return `:${segment.slice(1, -1)}`;
  return segment;
}

/**
 * Parse Expo Router structure — the default routing stack for modern React
 * Native/Expo apps. Conventions: app/_layout.* per directory (layout),
 * index.* (route at the directory's path), [param] dynamic segments,
 * (group) path-less groups, +not-found/+html special files (skipped).
 */
export function parseExpoRouter(rootPath: string): NavigationStructure {
  const warnings: string[] = [];
  const allNavigators: NavigatorInfo[] = [];
  const allScreens: ScreenInfo[] = [];

  let appDir: string;
  const appSubDir = path.join(rootPath, 'app');
  if (fs.existsSync(appSubDir) && fs.statSync(appSubDir).isDirectory()) {
    appDir = appSubDir;
  } else if (path.basename(rootPath) === 'app') {
    appDir = rootPath;
  } else {
    return { root: null, allNavigators: [], allScreens: [], warnings: ['No app/ directory found for Expo Router'] };
  }

  function scanDir(dir: string, routePrefix: string, depth = 0): NavigationNode | null {
    if (depth > 20) return null;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      warnings.push(`Cannot read directory: ${dir}`);
      return null;
    }

    const dirName = path.basename(dir);
    const isRoot = dir === appDir;
    const layoutFile = findFileWithExtension(path.join(dir, '_layout'));

    const navigator: NavigatorInfo = {
      name: isRoot ? 'RootLayout' : dirName,
      type: 'ExpoRouter',
      variableName: isRoot ? 'app' : dirName,
      filePath: layoutFile || dir,
      line: 1,
    };
    allNavigators.push(navigator);

    const screens: ScreenInfo[] = [];
    const children: NavigationNode[] = [];

    for (const entry of entries) {
      if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (!VALID_EXTENSIONS.has(ext)) continue;
        const base = path.parse(entry.name).name;
        if (base === '_layout' || base.startsWith('+')) continue; // layout/special files

        const seg = base === 'index' ? '' : expoSegmentToPath(base);
        const routePath = (seg ? `${routePrefix}/${seg}` : routePrefix) || '/';
        const fullPath = path.join(dir, entry.name);
        const screen: ScreenInfo = {
          name: routePath,
          componentName: base === 'index' ? 'Index' : base,
          componentPath: fullPath,
          navigatorName: navigator.variableName,
          filePath: fullPath,
          line: 1,
        };
        screens.push(screen);
        allScreens.push(screen);
      } else if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const seg = expoSegmentToPath(entry.name);
        const childPrefix = seg ? `${routePrefix}/${seg}` : routePrefix;
        const childNode = scanDir(path.join(dir, entry.name), childPrefix, depth + 1);
        if (childNode) children.push(childNode);
      }
    }

    if (screens.length === 0 && children.length === 0 && !layoutFile) {
      allNavigators.pop();
      return null;
    }
    return { navigator, screens, children };
  }

  const root = scanDir(appDir, '');
  allScreens.sort((a, b) => a.name.localeCompare(b.name));
  return { root, allNavigators, allScreens, warnings };
}

// ─── Next.js Pages Router (pages/*.tsx) ─────────────────────────────

/**
 * Parse the Next.js Pages Router — pages/ (or src/pages/) file-based routes.
 * _app/_document/_error and the api/ directory are framework plumbing, not
 * navigable screens.
 */
export function parseNextPagesRouter(rootPath: string): NavigationStructure {
  const warnings: string[] = [];
  const allScreens: ScreenInfo[] = [];

  let pagesDir: string | null = null;
  for (const candidate of [path.join(rootPath, 'pages'), path.join(rootPath, 'src', 'pages')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) { pagesDir = candidate; break; }
  }
  if (!pagesDir) {
    return { root: null, allNavigators: [], allScreens: [], warnings: ['No pages/ directory found for Next.js Pages Router'] };
  }

  const navigator: NavigatorInfo = {
    name: 'PagesRouter',
    type: 'NextPagesRouter',
    variableName: 'pages',
    filePath: pagesDir,
    line: 1,
  };

  function segToPath(segment: string): string {
    if (segment.startsWith('[...') && segment.endsWith(']')) return `*${segment.slice(4, -1)}`;
    if (segment.startsWith('[') && segment.endsWith(']')) return `:${segment.slice(1, -1)}`;
    return segment;
  }

  function scanDir(dir: string, routePrefix: string, depth = 0): void {
    if (depth > 20) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      warnings.push(`Cannot read directory: ${dir}`);
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name === 'api' || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        scanDir(path.join(dir, entry.name), `${routePrefix}/${segToPath(entry.name)}`, depth + 1);
        continue;
      }
      const ext = path.extname(entry.name);
      if (!VALID_EXTENSIONS.has(ext)) continue;
      const base = path.parse(entry.name).name;
      if (base.startsWith('_')) continue; // _app, _document, _error

      const seg = base === 'index' ? '' : segToPath(base);
      const routePath = (seg ? `${routePrefix}/${seg}` : routePrefix) || '/';
      const fullPath = path.join(dir, entry.name);
      allScreens.push({
        name: routePath,
        componentName: base === 'index' ? 'Index' : base,
        componentPath: fullPath,
        navigatorName: navigator.variableName,
        filePath: fullPath,
        line: 1,
      });
    }
  }

  scanDir(pagesDir, '');
  allScreens.sort((a, b) => a.name.localeCompare(b.name));
  const root: NavigationNode = { navigator, screens: allScreens, children: [] };
  return { root, allNavigators: [navigator], allScreens, warnings };
}

// ─── Unified Entry Point ────────────────────────────────────────────

/**
 * Attempt to parse web routing structure from a project.
 * Returns null if no web framework is detected.
 */
export function parseWebRoutingStructure(rootPath: string): NavigationStructure | null {
  const framework = detectWebFramework(rootPath);
  if (!framework) return null;

  switch (framework) {
    case 'nextjs-app':
      return parseNextAppRouter(rootPath);
    case 'nextjs-pages':
      return parseNextPagesRouter(rootPath);
    case 'react-router':
      return parseReactRouter(rootPath);
    case 'remix':
      return parseRemixRoutes(rootPath);
    case 'expo-router':
      return parseExpoRouter(rootPath);
    default:
      return null;
  }
}
