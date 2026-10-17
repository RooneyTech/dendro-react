/**
 * Screen-Component Parser
 *
 * Maps which screens use which components:
 * - Identifies screen components (screens/ folder, *Screen suffix, navigator config)
 * - For each screen, traces component imports and builds usage tree
 * - Calculates depth metrics for component nesting
 *
 * @module screen-parser
 */

import { parseSync, ParseResult, EcmaScriptModule } from 'oxc-parser';
import * as fs from 'fs';
import * as path from 'path';
import {
  resolveImportPath,
  findImportsInAST,
  parseFileToAST,
  isIndexFile,
  resolveBarrelExports,
  EXTENSIONS,
} from '../server/parser-oxc';
import { walkASTSimple, type ESTreeNode } from './utils/ast-walker';
import { scanComponentFiles } from './utils/file-scanner';

export interface ScreenDefinition {
  name: string;
  filePath: string;
  line: number;
  source: 'navigation' | 'folder' | 'suffix';
}

export interface ComponentUsage {
  name: string;
  filePath: string;
  children: ComponentUsage[];
  depth: number;
}

export interface ScreenComponentMap {
  screen: ScreenDefinition;
  components: ComponentUsage[];
  totalComponents: number;
  maxDepth: number;
}

export interface ScreenComponentsResult {
  screens: ScreenComponentMap[];
  totalScreens: number;
  warnings: string[];
}

// Extended ESTree node types used by this parser

interface Identifier extends ESTreeNode {
  type: 'Identifier';
  name: string;
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
 * Parse a file and return AST
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
 * Find screen definitions from navigator configuration
 * Detects patterns like <Stack.Screen name="Home" component={HomeScreen} />
 */
function findScreensFromNavigation(
  ast: ParseResult,
  source: string,
  filePath: string,
  imports: Map<string, string>
): ScreenDefinition[] {
  const screens: ScreenDefinition[] = [];
  const navigatorVarNames = new Set<string>();

  // First pass: find navigator variable names (Stack, Tab, etc.)
  walkAST(ast.program, (node) => {
    if (node.type === 'VariableDeclarator') {
      const declarator = node as unknown as { id: ESTreeNode; init: ESTreeNode | null };
      if (declarator.init?.type === 'CallExpression') {
        const call = declarator.init as unknown as { callee: ESTreeNode };

        // Check if callee is a navigator creator function
        if (call.callee.type === 'Identifier') {
          const calleeName = (call.callee as Identifier).name;
          if (
            calleeName.includes('Navigator') ||
            calleeName.includes('createNativeStack') ||
            calleeName.includes('createStack') ||
            calleeName.includes('createBottomTab') ||
            calleeName.includes('createMaterialTopTab') ||
            calleeName.includes('createDrawer')
          ) {
            if (declarator.id.type === 'Identifier') {
              navigatorVarNames.add((declarator.id as Identifier).name);
            }
          }
        }
      }
    }
  });

  // Second pass: find Screen elements
  walkAST(ast.program, (node) => {
    if (node.type === 'JSXElement') {
      const jsxEl = node as JSXElement;
      const openingEl = jsxEl.openingElement;

      // Check for Navigator.Screen pattern (e.g., Stack.Screen, Tab.Screen)
      if (openingEl.name.type === 'JSXMemberExpression') {
        const memberExpr = openingEl.name as JSXMemberExpression;
        const objectName =
          memberExpr.object.type === 'Identifier' || memberExpr.object.type === 'JSXIdentifier'
            ? (memberExpr.object as Identifier).name
            : null;
        const propertyName =
          memberExpr.property.type === 'Identifier' || memberExpr.property.type === 'JSXIdentifier'
            ? (memberExpr.property as Identifier).name
            : null;

        if (objectName && navigatorVarNames.has(objectName) && propertyName === 'Screen') {
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

          if (componentName) {
            // Resolve component to file path
            const importPath = imports.get(componentName);
            if (importPath) {
              screens.push({
                name: screenName || componentName,
                filePath: importPath,
                line: getLineNumber(source, node.start || 0),
                source: 'navigation',
              });
            }
          }
        }
      }
    }
  });

  return screens;
}

/**
 * Build import map from AST
 */
function buildImportMap(ast: ParseResult, fileDir: string): Map<string, string> {
  const imports = new Map<string, string>();
  const module = ast.module as EcmaScriptModule;

  if (module?.staticImports) {
    for (const staticImport of module.staticImports) {
      const importPath = staticImport.moduleRequest.value;

      // Only process local imports
      if (!importPath.startsWith('.') && !importPath.startsWith('/')) {
        continue;
      }

      const resolved = resolveImportPath(importPath, fileDir);
      if (resolved) {
        // Get all imported names from entries
        if (staticImport.entries) {
          for (const entry of staticImport.entries) {
            const localName = (entry.localName as { value?: string })?.value;
            if (localName) {
              imports.set(localName, resolved);
            }
          }
        }
      }
    }
  }

  return imports;
}

// findAllComponentFiles replaced by scanComponentFiles from utils/file-scanner
const findAllComponentFiles = scanComponentFiles;

/**
 * Check if a file is a screen based on conventions
 */
function isScreenFile(filePath: string): { isScreen: boolean; source: 'folder' | 'suffix' | null } {
  const dirname = path.dirname(filePath);
  const dirBasename = path.basename(dirname).toLowerCase();
  const filename = path.basename(filePath, path.extname(filePath));

  // Check if file is directly in a screens/ folder (not in a subfolder like screens/components/)
  if (dirBasename === 'screens') {
    return { isScreen: true, source: 'folder' };
  }

  // Check if file has Screen suffix
  if (filename.endsWith('Screen')) {
    return { isScreen: true, source: 'suffix' };
  }

  return { isScreen: false, source: null };
}

/**
 * Build component usage tree for a screen.
 * Uses a shared visited set to prevent the same file from expanding in
 * multiple branches (which caused combinatorial explosion on large codebases).
 */
function buildComponentUsageTree(
  filePath: string,
  visited: Set<string> = new Set(),
  depth = 0,
  maxDepth = 6
): ComponentUsage[] {
  if (depth >= maxDepth || visited.has(filePath)) {
    return [];
  }

  visited.add(filePath);

  const ast = parseFileToAST(filePath);
  if (!ast) {
    return [];
  }

  const components: ComponentUsage[] = [];
  const imports = findImportsInAST(ast);
  const fileDir = path.dirname(filePath);

  for (const importPath of imports) {
    const resolved = resolveImportPath(importPath, fileDir);
    if (!resolved) continue;

    // Handle barrel exports
    if (isIndexFile(resolved)) {
      const barrelExports = resolveBarrelExports(resolved, visited);
      for (const exportedPath of barrelExports) {
        const children = buildComponentUsageTree(exportedPath, visited, depth + 1, maxDepth);
        components.push({
          name: path.basename(exportedPath, path.extname(exportedPath)),
          filePath: exportedPath,
          children,
          depth: depth + 1,
        });
      }
    } else {
      const children = buildComponentUsageTree(resolved, visited, depth + 1, maxDepth);
      components.push({
        name: path.basename(resolved, path.extname(resolved)),
        filePath: resolved,
        children,
        depth: depth + 1,
      });
    }
  }

  return components;
}

/**
 * Count total components in a usage tree
 */
function countComponents(components: ComponentUsage[]): number {
  let count = components.length;
  for (const comp of components) {
    count += countComponents(comp.children);
  }
  return count;
}

/**
 * Get maximum depth in a usage tree
 */
function getMaxDepth(components: ComponentUsage[]): number {
  let maxDepth = 0;
  for (const comp of components) {
    maxDepth = Math.max(maxDepth, comp.depth);
    const childMax = getMaxDepth(comp.children);
    maxDepth = Math.max(maxDepth, childMax);
  }
  return maxDepth;
}

/**
 * Parse screen-component mapping for a codebase
 */
export function parseScreenComponents(
  rootPath: string,
  screenName?: string,
  maxDepth?: number
): ScreenComponentsResult {
  const warnings: string[] = [];
  const allScreens: ScreenDefinition[] = [];
  const seenScreenPaths = new Set<string>();

  // Determine if rootPath is file or directory
  const stats = fs.existsSync(rootPath) ? fs.statSync(rootPath) : null;

  if (!stats) {
    return {
      screens: [],
      totalScreens: 0,
      warnings: [`Path not found: ${rootPath}`],
    };
  }

  let filesToScan: string[];
  let baseDir: string;

  if (stats.isDirectory()) {
    baseDir = rootPath;
    filesToScan = findAllComponentFiles(rootPath);
  } else {
    baseDir = path.dirname(rootPath);
    filesToScan = [rootPath];
  }

  // First pass: find screens from navigation configurations
  for (const filePath of filesToScan) {
    const { ast, source } = parseFile(filePath);
    if (!ast) continue;

    const fileDir = path.dirname(filePath);
    const imports = buildImportMap(ast, fileDir);
    const navScreens = findScreensFromNavigation(ast, source, filePath, imports);

    for (const screen of navScreens) {
      if (!seenScreenPaths.has(screen.filePath)) {
        seenScreenPaths.add(screen.filePath);
        allScreens.push(screen);
      }
    }
  }

  // Second pass: find screens by convention (folder, suffix)
  for (const filePath of filesToScan) {
    if (seenScreenPaths.has(filePath)) continue;

    const { isScreen, source } = isScreenFile(filePath);
    if (isScreen && source) {
      const filename = path.basename(filePath, path.extname(filePath));
      seenScreenPaths.add(filePath);
      allScreens.push({
        name: filename,
        filePath,
        line: 1,
        source,
      });
    }
  }

  // Filter by screen name if provided
  let screensToProcess = allScreens;
  if (screenName) {
    const searchName = screenName.toLowerCase();
    screensToProcess = allScreens.filter(
      (s) =>
        s.name.toLowerCase() === searchName ||
        s.name.toLowerCase().includes(searchName)
    );

    if (screensToProcess.length === 0) {
      warnings.push(`No screens found matching "${screenName}"`);
    }
  }

  // Build component trees for each screen
  const screenMaps: ScreenComponentMap[] = [];

  for (const screen of screensToProcess) {
    const components = buildComponentUsageTree(screen.filePath, new Set(), 0, maxDepth ?? 6);
    const totalComponents = countComponents(components);
    const treeDepth = getMaxDepth(components);

    screenMaps.push({
      screen,
      components,
      totalComponents,
      maxDepth: treeDepth,
    });
  }

  // Sort by screen name
  screenMaps.sort((a, b) => a.screen.name.localeCompare(b.screen.name));

  return {
    screens: screenMaps,
    totalScreens: screenMaps.length,
    warnings,
  };
}

/**
 * Format screen-component map as a readable tree string
 */
export function formatScreenComponents(result: ScreenComponentsResult): string {
  if (result.screens.length === 0) {
    return 'No screens found';
  }

  const lines: string[] = [];

  for (let i = 0; i < result.screens.length; i++) {
    const screenMap = result.screens[i];
    const isLastScreen = i === result.screens.length - 1;

    // Screen name header
    lines.push(`${screenMap.screen.name}`);

    // Components
    formatComponentTree(screenMap.components, lines, '', isLastScreen);

    // Add blank line between screens (except last)
    if (!isLastScreen) {
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Format component tree recursively
 */
function formatComponentTree(
  components: ComponentUsage[],
  lines: string[],
  indent: string,
  isLastScreen: boolean
): void {
  for (let i = 0; i < components.length; i++) {
    const comp = components[i];
    const isLast = i === components.length - 1;
    const prefix = indent + (isLast ? '└── ' : '├── ');
    const childIndent = indent + (isLast ? '    ' : '│   ');

    lines.push(`${prefix}${comp.name}`);

    if (comp.children.length > 0) {
      formatComponentTree(comp.children, lines, childIndent, isLastScreen);
    }
  }
}
