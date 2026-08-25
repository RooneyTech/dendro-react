/**
 * React Navigation Structure Parser
 *
 * Detects and extracts React Navigation patterns from React Native codebases.
 * Supports:
 * - createNativeStackNavigator
 * - createBottomTabNavigator
 * - createMaterialTopTabNavigator
 * - createDrawerNavigator
 * - createStackNavigator (legacy)
 *
 * @module navigation-parser
 */

import { parseSync, ParseResult, EcmaScriptModule } from 'oxc-parser';
import * as fs from 'fs';
import * as path from 'path';
import { resolveImportPath, EXTENSIONS } from '../server/parser-oxc';
import { walkASTSimple, type ESTreeNode } from './utils/ast-walker';
import { scanComponentFiles } from './utils/file-scanner';

// Navigator types we detect
export type NavigatorType =
  | 'NativeStack'
  | 'Stack'
  | 'BottomTab'
  | 'MaterialTopTab'
  | 'Drawer'
  // Web routing types
  | 'NextAppRouter'
  | 'NextPagesRouter'
  | 'NextRouteGroup'
  | 'ReactRouter'
  | 'RemixRouter'
  | 'ExpoRouter'
  | 'Unknown';

// Map from create function names to navigator types
const NAVIGATOR_CREATORS: Record<string, NavigatorType> = {
  createNativeStackNavigator: 'NativeStack',
  createStackNavigator: 'Stack',
  createBottomTabNavigator: 'BottomTab',
  createMaterialTopTabNavigator: 'MaterialTopTab',
  createDrawerNavigator: 'Drawer',
};

// Screen component JSX element names (e.g., Stack.Screen, Tab.Screen)
const SCREEN_ELEMENT_NAMES = ['Screen'];

// Signals of programmatic navigation this parser cannot model as edges
const IMPERATIVE_NAV_RE =
  /\buseNavigate\s*\(|\bnavigation\.(navigate|push|replace|reset)\s*\(|\brouter\.(push|replace)\s*\(|\bhistory\.(push|replace)\s*\(|\bredirect\s*\(|<Link[\s>]|<NavLink[\s>]/;

export interface NavigatorInfo {
  name: string;
  type: NavigatorType;
  variableName: string; // e.g., "Stack", "Tab"
  filePath: string;
  line: number;
}

export interface ScreenInfo {
  name: string;
  componentName: string | null;
  componentPath: string | null;
  navigatorName: string;
  filePath: string;
  line: number;
  options?: Record<string, unknown>;
}

export interface NavigationNode {
  navigator: NavigatorInfo;
  screens: ScreenInfo[];
  children: NavigationNode[];
}

export interface NavigationStructure {
  root: NavigationNode | null;
  allNavigators: NavigatorInfo[];
  allScreens: ScreenInfo[];
  warnings: string[];
}

// Extended ESTree node types used by this parser

interface Identifier extends ESTreeNode {
  type: 'Identifier';
  name: string;
}

interface CallExpression extends ESTreeNode {
  type: 'CallExpression';
  callee: ESTreeNode;
  arguments: ESTreeNode[];
}

interface VariableDeclarator extends ESTreeNode {
  type: 'VariableDeclarator';
  id: ESTreeNode;
  init: ESTreeNode | null;
}

interface JSXElement extends ESTreeNode {
  type: 'JSXElement';
  openingElement: {
    type: 'JSXOpeningElement';
    name: ESTreeNode;
    attributes: ESTreeNode[];
  };
  children: ESTreeNode[];
}

interface JSXAttribute extends ESTreeNode {
  type: 'JSXAttribute';
  name: { name: string };
  value: ESTreeNode | null;
}

interface JSXMemberExpression extends ESTreeNode {
  type: 'JSXMemberExpression';
  object: ESTreeNode;
  property: ESTreeNode;
}

// walkAST replaced by walkASTSimple from utils/ast-walker
const walkAST = walkASTSimple;

/**
 * Get line number from character offset in source code
 */
function getLineNumber(source: string, offset: number): number {
  const lines = source.slice(0, offset).split('\n');
  return lines.length;
}

/**
 * Parse a file and extract navigation patterns
 */
function parseFile(filePath: string): { ast: ParseResult | null; source: string } {
  if (!fs.existsSync(filePath)) {
    return { ast: null, source: '' };
  }

  const source = fs.readFileSync(filePath, 'utf-8');
  const filename = path.basename(filePath);

  try {
    const ast = parseSync(filename, source);
    return { ast, source };
  } catch {
    return { ast: null, source };
  }
}

/**
 * Extract navigator variable name from a destructuring pattern
 * e.g., const Stack = createNativeStackNavigator() -> "Stack"
 */
function extractNavigatorName(declarator: VariableDeclarator): string | null {
  const id = declarator.id;
  if (id.type === 'Identifier') {
    return (id as Identifier).name;
  }
  return null;
}

/**
 * Find all navigator creation calls in a file
 */
function findNavigatorCreations(
  ast: ParseResult,
  source: string,
  filePath: string
): NavigatorInfo[] {
  const navigators: NavigatorInfo[] = [];

  walkAST(ast.program, (node) => {
    if (node.type === 'VariableDeclarator') {
      const declarator = node as VariableDeclarator;
      if (declarator.init?.type === 'CallExpression') {
        const call = declarator.init as CallExpression;

        // Check if callee is a navigator creator function
        let creatorName: string | null = null;

        if (call.callee.type === 'Identifier') {
          creatorName = (call.callee as Identifier).name;
        }

        // Known creators map to their type; anything shaped create*Navigator
        // that we don't recognize (custom or third-party navigators) is
        // surfaced as 'Unknown' rather than silently dropped.
        const navigatorType: NavigatorType | null =
          creatorName && NAVIGATOR_CREATORS[creatorName]
            ? NAVIGATOR_CREATORS[creatorName]
            : creatorName && /^create[A-Z]\w*Navigator$/.test(creatorName)
              ? 'Unknown'
              : null;

        if (creatorName && navigatorType) {
          const varName = extractNavigatorName(declarator);
          if (varName) {
            navigators.push({
              name: varName,
              type: navigatorType,
              variableName: varName,
              filePath,
              line: getLineNumber(source, node.start || 0),
            });
          }
        }
      }
    }
  });

  return navigators;
}

/**
 * Extract JSX attribute value
 */
function getJSXAttributeValue(attr: JSXAttribute): string | null {
  if (!attr.value) return null;

  // String literal: name="Home"
  if (attr.value.type === 'StringLiteral' || attr.value.type === 'Literal') {
    return (attr.value as unknown as { value: string }).value;
  }

  // JSX expression: component={HomeScreen}
  if (attr.value.type === 'JSXExpressionContainer') {
    const expr = (attr.value as unknown as { expression: ESTreeNode }).expression;
    if (expr.type === 'Identifier') {
      return (expr as Identifier).name;
    }
  }

  return null;
}

/**
 * Find all screen definitions in a file
 */
function findScreenDefinitions(
  ast: ParseResult,
  source: string,
  filePath: string,
  navigators: NavigatorInfo[]
): ScreenInfo[] {
  const screens: ScreenInfo[] = [];
  const navigatorVarNames = new Set(navigators.map((n) => n.variableName));

  walkAST(ast.program, (node) => {
    if (node.type === 'JSXElement') {
      const jsxEl = node as JSXElement;
      const openingEl = jsxEl.openingElement;

      // Check for Navigator.Screen pattern (e.g., Stack.Screen, Tab.Screen)
      if (openingEl.name.type === 'JSXMemberExpression') {
        const memberExpr = openingEl.name as JSXMemberExpression;
        // Handle both Identifier and JSXIdentifier types
        const objectName = (memberExpr.object.type === 'Identifier' || memberExpr.object.type === 'JSXIdentifier')
          ? (memberExpr.object as Identifier).name
          : null;
        const propertyName = (memberExpr.property.type === 'Identifier' || memberExpr.property.type === 'JSXIdentifier')
          ? (memberExpr.property as Identifier).name
          : null;

        if (objectName && navigatorVarNames.has(objectName) &&
            propertyName && SCREEN_ELEMENT_NAMES.includes(propertyName)) {

          // Extract screen attributes
          let screenName: string | null = null;
          let componentName: string | null = null;

          for (const attr of openingEl.attributes) {
            if (attr.type === 'JSXAttribute') {
              const jsxAttr = attr as JSXAttribute;
              if (jsxAttr.name.name === 'name') {
                screenName = getJSXAttributeValue(jsxAttr);
              } else if (jsxAttr.name.name === 'component') {
                componentName = getJSXAttributeValue(jsxAttr);
              }
            }
          }

          if (screenName) {
            screens.push({
              name: screenName,
              componentName,
              componentPath: null, // Will be resolved later
              navigatorName: objectName,
              filePath,
              line: getLineNumber(source, node.start || 0),
            });
          }
        }
      }
    }
  });

  return screens;
}

/**
 * Resolve component imports to find actual file paths
 */
function resolveComponentPaths(
  screens: ScreenInfo[],
  ast: ParseResult,
  filePath: string
): void {
  const fileDir = path.dirname(filePath);
  const imports = new Map<string, string>();

  // Build import map using OXC's pre-computed staticImports
  const module = ast.module as EcmaScriptModule;
  if (module?.staticImports) {
    for (const staticImport of module.staticImports) {
      const importPath = staticImport.moduleRequest.value;

      // Get all imported names from entries
      if (staticImport.entries) {
        for (const entry of staticImport.entries) {
          // localName is a ValueSpan with a value property (not name)
          const localName = (entry.localName as { value?: string })?.value;
          if (localName) {
            imports.set(localName, importPath);
          }
        }
      }
    }
  }

  // Resolve paths for each screen
  for (const screen of screens) {
    if (screen.componentName && imports.has(screen.componentName)) {
      const importPath = imports.get(screen.componentName)!;
      const resolved = resolveImportPath(importPath, fileDir);
      if (resolved) {
        screen.componentPath = resolved;
      }
    }
  }
}

/**
 * Find nested navigators by checking if a screen component is itself a navigator file
 */
function findNestedNavigators(
  screens: ScreenInfo[],
  allNavigators: Map<string, NavigatorInfo>,
  visited: Set<string>
): NavigationNode[] {
  const children: NavigationNode[] = [];

  for (const screen of screens) {
    if (screen.componentPath && !visited.has(screen.componentPath)) {
      visited.add(screen.componentPath);

      // Parse the component file to check for nested navigators
      const { ast, source } = parseFile(screen.componentPath);
      if (ast) {
        const nestedNavigators = findNavigatorCreations(ast, source, screen.componentPath);

        for (const nav of nestedNavigators) {
          const nestedScreens = findScreenDefinitions(ast, source, screen.componentPath, [nav]);
          resolveComponentPaths(nestedScreens, ast, screen.componentPath);

          // Store navigator info
          allNavigators.set(nav.name, nav);

          // Recursively find nested navigators
          const nestedChildren = findNestedNavigators(nestedScreens, allNavigators, visited);

          children.push({
            navigator: nav,
            screens: nestedScreens,
            children: nestedChildren,
          });
        }
      }
    }
  }

  return children;
}

/**
 * Scan a directory for all navigation-related files
 */
function findNavigationFiles(dir: string, maxDepth = 5): string[] {
  const files: string[] = [];
  const extensions = new Set(EXTENSIONS);

  function scan(currentDir: string, depth: number): void {
    if (depth > maxDepth) return;

    try {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);

        // Skip node_modules and hidden directories
        if (entry.name.startsWith('.') || entry.name === 'node_modules') {
          continue;
        }

        if (entry.isDirectory()) {
          // Prioritize navigation folders
          if (entry.name.toLowerCase().includes('navigation') ||
              entry.name.toLowerCase().includes('navigator')) {
            scan(fullPath, depth + 1);
          } else {
            scan(fullPath, depth + 1);
          }
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name);
          if (extensions.has(ext)) {
            // Check if file might contain navigation
            const nameLower = entry.name.toLowerCase();
            if (nameLower.includes('navigator') ||
                nameLower.includes('navigation') ||
                nameLower.includes('screen') ||
                nameLower.includes('app.')) {
              files.push(fullPath);
            }
          }
        }
      }
    } catch {
      // Directory not readable
    }
  }

  scan(dir, 0);
  return files;
}

/**
 * Parse navigation structure starting from a root file or directory
 */
export function parseNavigationStructure(rootPath: string): NavigationStructure {
  const warnings: string[] = [];
  const allNavigators = new Map<string, NavigatorInfo>();
  const allScreens: ScreenInfo[] = [];
  const visited = new Set<string>();
  let imperativeNavDetected = false;

  // Determine if rootPath is file or directory
  const stats = fs.existsSync(rootPath) ? fs.statSync(rootPath) : null;

  if (!stats) {
    return {
      root: null,
      allNavigators: [],
      allScreens: [],
      warnings: [`Path not found: ${rootPath}`],
    };
  }

  let filesToScan: string[];
  let baseDir: string;

  if (stats.isDirectory()) {
    baseDir = rootPath;
    filesToScan = findNavigationFiles(rootPath);
    if (filesToScan.length === 0) {
      // If no navigation files found by name, scan all TS/TSX files
      filesToScan = findAllComponentFiles(rootPath);
    }
  } else {
    baseDir = path.dirname(rootPath);
    filesToScan = [rootPath];
  }

  // First pass: find all navigators
  for (const filePath of filesToScan) {
    if (visited.has(filePath)) continue;
    visited.add(filePath);

    const { ast, source } = parseFile(filePath);
    if (!ast) continue;

    const navigators = findNavigatorCreations(ast, source, filePath);
    for (const nav of navigators) {
      allNavigators.set(`${nav.filePath}:${nav.name}`, nav);
    }

    // Honesty check: this parser models declarative route DEFINITIONS only.
    // Programmatic transitions (navigation.navigate(), router.push(), ...) are
    // real edges it cannot see — say so instead of implying a complete graph.
    if (!imperativeNavDetected && IMPERATIVE_NAV_RE.test(source)) {
      imperativeNavDetected = true;
    }
  }

  const imperativeWarning =
    'Programmatic navigation calls detected (navigate()/router.push()/history.push()/<Link>). This structure only models declaratively-defined routes — screens reached exclusively through imperative calls may appear unconnected even though they are reachable.';

  if (allNavigators.size === 0) {
    const emptyWarnings = ['No React Navigation navigators found'];
    if (imperativeNavDetected) emptyWarnings.push(imperativeWarning);
    return {
      root: null,
      allNavigators: [],
      allScreens: [],
      warnings: emptyWarnings,
    };
  }
  if (imperativeNavDetected) warnings.push(imperativeWarning);

  // Second pass: find screens for each navigator
  visited.clear();
  let rootNode: NavigationNode | null = null;

  for (const [, nav] of allNavigators) {
    if (visited.has(nav.filePath)) continue;
    visited.add(nav.filePath);

    const { ast, source } = parseFile(nav.filePath);
    if (!ast) continue;

    // Find all navigators in this file
    const fileNavigators = findNavigatorCreations(ast, source, nav.filePath);
    const screens = findScreenDefinitions(ast, source, nav.filePath, fileNavigators);
    resolveComponentPaths(screens, ast, nav.filePath);

    allScreens.push(...screens);

    // Build navigation tree for this navigator
    for (const fileNav of fileNavigators) {
      const navScreens = screens.filter((s) => s.navigatorName === fileNav.variableName);
      const children = findNestedNavigators(navScreens, allNavigators, visited);

      const node: NavigationNode = {
        navigator: fileNav,
        screens: navScreens,
        children,
      };

      // Use first navigator found as root (usually RootNavigator or AppNavigator)
      if (!rootNode) {
        const nameLower = fileNav.name.toLowerCase();
        if (nameLower.includes('root') || nameLower.includes('app') || nameLower.includes('main')) {
          rootNode = node;
        }
      }

      // Fallback: use first navigator as root
      if (!rootNode) {
        rootNode = node;
      }
    }
  }

  return {
    root: rootNode,
    allNavigators: Array.from(allNavigators.values()),
    allScreens,
    warnings,
  };
}

// findAllComponentFiles replaced by scanComponentFiles from utils/file-scanner
const findAllComponentFiles = scanComponentFiles;

/**
 * Format navigation structure as a readable tree string
 */
export function formatNavigationTree(structure: NavigationStructure): string {
  if (!structure.root) {
    return 'No navigation structure found';
  }

  const lines: string[] = [];

  function formatNode(node: NavigationNode, indent = '', isLast = true): void {
    const prefix = indent + (isLast ? '└── ' : '├── ');
    const childIndent = indent + (isLast ? '    ' : '│   ');

    // Navigator header
    lines.push(`${prefix}${node.navigator.name} (${node.navigator.type})`);

    // Screens
    const allItems = [...node.screens.map((s) => ({ type: 'screen' as const, item: s })),
                      ...node.children.map((c) => ({ type: 'child' as const, item: c }))];

    for (let i = 0; i < allItems.length; i++) {
      const { type, item } = allItems[i];
      const isLastItem = i === allItems.length - 1;
      const itemPrefix = childIndent + (isLastItem ? '└── ' : '├── ');

      if (type === 'screen') {
        const screen = item as ScreenInfo;
        const componentInfo = screen.componentName ? ` → ${screen.componentName}` : '';
        lines.push(`${itemPrefix}${screen.name}${componentInfo}`);
      } else {
        formatNode(item as NavigationNode, childIndent, isLastItem);
      }
    }
  }

  formatNode(structure.root);
  return lines.join('\n');
}
