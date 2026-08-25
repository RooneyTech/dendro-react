/**
 * React Context Parser
 *
 * Detects and maps React Context patterns:
 * - createContext() declarations
 * - Provider components
 * - useContext() consumers
 * - Custom hooks that wrap useContext
 *
 * @module context-parser
 */

import { parseSync, ParseResult } from 'oxc-parser';
import * as fs from 'fs';
import * as path from 'path';
import { resolveImportPath, EXTENSIONS } from '../server/parser-oxc';
import { walkASTWithParent, type ESTreeNode } from './utils/ast-walker';
import { scanComponentFiles } from './utils/file-scanner';

export interface ContextDefinition {
  name: string;
  variableName: string;
  filePath: string;
  line: number;
  defaultValue?: string;
  providerExported: boolean;
}

export interface ProviderUsage {
  contextName: string;
  filePath: string;
  line: number;
  wrapperComponent?: string;
}

export interface ContextConsumer {
  contextName: string;
  hookName: string;
  componentName: string | null;
  filePath: string;
  line: number;
  isCustomHook: boolean;
}

export interface CustomContextHook {
  hookName: string;
  contextName: string;
  filePath: string;
  line: number;
  exportedValues: string[];
}

export interface ContextMap {
  contexts: ContextDefinition[];
  providers: ProviderUsage[];
  consumers: ContextConsumer[];
  customHooks: CustomContextHook[];
  providerToConsumers: Map<string, string[]>;
  warnings: string[];
}

export interface ContextMapResult {
  contexts: ContextDefinition[];
  providers: ProviderUsage[];
  consumers: ContextConsumer[];
  customHooks: CustomContextHook[];
  hierarchy: ContextHierarchyNode[];
  warnings: string[];
}

export interface ContextHierarchyNode {
  contextName: string;
  definition: ContextDefinition | null;
  providers: ProviderUsage[];
  consumers: ContextConsumer[];
  customHooks: CustomContextHook[];
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

interface MemberExpression extends ESTreeNode {
  type: 'MemberExpression';
  object: ESTreeNode;
  property: ESTreeNode;
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

interface JSXMemberExpression extends ESTreeNode {
  type: 'JSXMemberExpression';
  object: ESTreeNode;
  property: ESTreeNode;
}

interface FunctionDeclaration extends ESTreeNode {
  type: 'FunctionDeclaration';
  id: Identifier | null;
  body: ESTreeNode;
}

interface ArrowFunctionExpression extends ESTreeNode {
  type: 'ArrowFunctionExpression';
  body: ESTreeNode;
}

// walkAST replaced by walkASTWithParent from utils/ast-walker
const walkAST = walkASTWithParent;

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
 * Check if a call expression is createContext
 */
function isCreateContextCall(callee: ESTreeNode): boolean {
  // Direct call: createContext()
  if (callee.type === 'Identifier' && (callee as Identifier).name === 'createContext') {
    return true;
  }

  // Member expression: React.createContext()
  if (callee.type === 'MemberExpression') {
    const member = callee as MemberExpression;
    const obj = member.object;
    const prop = member.property;

    if (
      obj.type === 'Identifier' &&
      (obj as Identifier).name === 'React' &&
      prop.type === 'Identifier' &&
      (prop as Identifier).name === 'createContext'
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Find all createContext declarations in a file
 */
function findContextDefinitions(
  ast: ParseResult,
  source: string,
  filePath: string
): ContextDefinition[] {
  const contexts: ContextDefinition[] = [];

  walkAST(ast.program, (node) => {
    if (node.type === 'VariableDeclarator') {
      const declarator = node as VariableDeclarator;
      if (declarator.init?.type === 'CallExpression') {
        const call = declarator.init as CallExpression;

        if (isCreateContextCall(call.callee)) {
          let varName: string | null = null;

          if (declarator.id.type === 'Identifier') {
            varName = (declarator.id as Identifier).name;
          }

          if (varName) {
            // Derive context name from variable (e.g., AuthContext -> Auth)
            let contextName = varName;
            if (contextName.endsWith('Context')) {
              contextName = contextName.slice(0, -7);
            }

            // Extract default value if present
            let defaultValue: string | undefined;
            if (call.arguments.length > 0) {
              const arg = call.arguments[0];
              if (arg.type === 'Literal' || arg.type === 'NullLiteral') {
                defaultValue = 'null';
              } else if (arg.type === 'ObjectExpression') {
                defaultValue = '{}';
              }
            }

            contexts.push({
              name: contextName,
              variableName: varName,
              filePath,
              line: getLineNumber(source, node.start || 0),
              defaultValue,
              providerExported: false,
            });
          }
        }
      }
    }
  });

  return contexts;
}

/**
 * Find Provider usages in JSX
 */
function findProviderUsages(
  ast: ParseResult,
  source: string,
  filePath: string,
  knownContexts: Set<string>
): ProviderUsage[] {
  const providers: ProviderUsage[] = [];
  const componentStack: Array<{ name: string; end: number }> = [];

  walkAST(ast.program, (node) => {
    // Pop components whose range we've exited
    while (componentStack.length > 0 && node.start !== undefined &&
           node.start >= componentStack[componentStack.length - 1].end) {
      componentStack.pop();
    }

    // Track current component/function name using a stack
    if (node.type === 'FunctionDeclaration') {
      const fn = node as FunctionDeclaration;
      if (fn.id && node.end !== undefined) {
        componentStack.push({ name: fn.id.name, end: node.end });
      }
    } else if (node.type === 'VariableDeclarator') {
      const decl = node as VariableDeclarator;
      if (
        decl.id.type === 'Identifier' &&
        decl.init &&
        (decl.init.type === 'ArrowFunctionExpression' || decl.init.type === 'FunctionExpression') &&
        decl.init.end !== undefined
      ) {
        componentStack.push({ name: (decl.id as Identifier).name, end: decl.init.end });
      }
    }

    const currentComponent = componentStack.length > 0 ? componentStack[componentStack.length - 1].name : null;

    if (node.type === 'JSXElement') {
      const jsxEl = node as JSXElement;
      const openingEl = jsxEl.openingElement;

      // Check for SomeContext.Provider pattern
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

        if (objectName && propertyName === 'Provider') {
          // Context.Provider pattern
          let contextName = objectName;
          if (contextName.endsWith('Context')) {
            contextName = contextName.slice(0, -7);
          }

          // Only include wrapper component if it looks like a React component (PascalCase)
          const isComponent = currentComponent && /^[A-Z]/.test(currentComponent);

          providers.push({
            contextName,
            filePath,
            line: getLineNumber(source, node.start || 0),
            wrapperComponent: isComponent ? currentComponent! : undefined,
          });
        }
      }

      // Check for SomeProvider pattern (custom Provider component)
      if (openingEl.name.type === 'Identifier' || openingEl.name.type === 'JSXIdentifier') {
        const tagName = (openingEl.name as Identifier).name;
        if (tagName.endsWith('Provider')) {
          let contextName = tagName.slice(0, -8); // Remove "Provider"

          providers.push({
            contextName,
            filePath,
            line: getLineNumber(source, node.start || 0),
            wrapperComponent: currentComponent || undefined,
          });
        }
      }
    }
  });

  return providers;
}

/**
 * Find useContext consumers
 */
function findContextConsumers(
  ast: ParseResult,
  source: string,
  filePath: string
): ContextConsumer[] {
  const consumers: ContextConsumer[] = [];
  const componentStack: Array<{ name: string; end: number; isHook: boolean }> = [];

  walkAST(ast.program, (node) => {
    // Pop components whose range we've exited
    while (componentStack.length > 0 && node.start !== undefined &&
           node.start >= componentStack[componentStack.length - 1].end) {
      componentStack.pop();
    }

    // Track current component/function name using a stack
    if (node.type === 'FunctionDeclaration') {
      const fn = node as FunctionDeclaration;
      if (fn.id && node.end !== undefined) {
        componentStack.push({ name: fn.id.name, end: node.end, isHook: fn.id.name.startsWith('use') });
      }
    } else if (node.type === 'VariableDeclarator') {
      const decl = node as VariableDeclarator;
      if (
        decl.id.type === 'Identifier' &&
        decl.init &&
        (decl.init.type === 'ArrowFunctionExpression' || decl.init.type === 'FunctionExpression') &&
        decl.init.end !== undefined
      ) {
        const name = (decl.id as Identifier).name;
        componentStack.push({ name, end: decl.init.end, isHook: name.startsWith('use') });
      }
    }

    const currentComponent = componentStack.length > 0 ? componentStack[componentStack.length - 1].name : null;
    const currentIsHook = componentStack.length > 0 ? componentStack[componentStack.length - 1].isHook : false;

    if (node.type === 'CallExpression') {
      const call = node as CallExpression;

      // Check for useContext(SomeContext)
      let isUseContext = false;

      if (call.callee.type === 'Identifier' && (call.callee as Identifier).name === 'useContext') {
        isUseContext = true;
      } else if (call.callee.type === 'MemberExpression') {
        const member = call.callee as MemberExpression;
        if (
          member.object.type === 'Identifier' &&
          (member.object as Identifier).name === 'React' &&
          member.property.type === 'Identifier' &&
          (member.property as Identifier).name === 'useContext'
        ) {
          isUseContext = true;
        }
      }

      if (isUseContext && call.arguments.length > 0) {
        const arg = call.arguments[0];
        let contextVarName: string | null = null;

        if (arg.type === 'Identifier') {
          contextVarName = (arg as Identifier).name;
        }

        if (contextVarName) {
          let contextName = contextVarName;
          if (contextName.endsWith('Context')) {
            contextName = contextName.slice(0, -7);
          }

          consumers.push({
            contextName,
            hookName: 'useContext',
            componentName: currentComponent,
            filePath,
            line: getLineNumber(source, node.start || 0),
            isCustomHook: currentIsHook,
          });
        }
      }
    }
  });

  return consumers;
}

/**
 * Find custom hooks that wrap useContext
 */
function findCustomContextHooks(
  ast: ParseResult,
  source: string,
  filePath: string,
  consumers: ContextConsumer[]
): CustomContextHook[] {
  const hooks: CustomContextHook[] = [];

  // Find consumers that are in custom hooks (use* functions)
  const hookConsumers = consumers.filter((c) => c.isCustomHook && c.componentName);

  // Group by hook name
  const hookMap = new Map<string, ContextConsumer[]>();
  for (const consumer of hookConsumers) {
    const existing = hookMap.get(consumer.componentName!) || [];
    existing.push(consumer);
    hookMap.set(consumer.componentName!, existing);
  }

  for (const [hookName, hookConsumerList] of hookMap) {
    // A custom hook might use multiple contexts
    for (const consumer of hookConsumerList) {
      hooks.push({
        hookName,
        contextName: consumer.contextName,
        filePath,
        line: consumer.line,
        exportedValues: [], // Could be enhanced to extract return values
      });
    }
  }

  return hooks;
}

/**
 * Find usages of custom hooks in components
 */
function findCustomHookUsages(
  ast: ParseResult,
  source: string,
  filePath: string,
  knownHooks: Map<string, string[]> // hookName -> contextNames
): ContextConsumer[] {
  const consumers: ContextConsumer[] = [];
  const componentStack: Array<{ name: string; end: number; isHook: boolean }> = [];

  walkAST(ast.program, (node) => {
    // Pop components whose range we've exited
    while (componentStack.length > 0 && node.start !== undefined &&
           node.start >= componentStack[componentStack.length - 1].end) {
      componentStack.pop();
    }

    // Track current component/function name using a stack
    if (node.type === 'FunctionDeclaration') {
      const fn = node as FunctionDeclaration;
      if (fn.id && node.end !== undefined) {
        componentStack.push({ name: fn.id.name, end: node.end, isHook: fn.id.name.startsWith('use') });
      }
    } else if (node.type === 'VariableDeclarator') {
      const decl = node as VariableDeclarator;
      if (
        decl.id.type === 'Identifier' &&
        decl.init &&
        (decl.init.type === 'ArrowFunctionExpression' || decl.init.type === 'FunctionExpression') &&
        decl.init.end !== undefined
      ) {
        const name = (decl.id as Identifier).name;
        componentStack.push({ name, end: decl.init.end, isHook: name.startsWith('use') });
      }
    }

    const currentComponent = componentStack.length > 0 ? componentStack[componentStack.length - 1].name : null;
    const currentIsHook = componentStack.length > 0 ? componentStack[componentStack.length - 1].isHook : false;

    if (node.type === 'CallExpression') {
      const call = node as CallExpression;

      // Check for custom hook calls (use* functions)
      if (call.callee.type === 'Identifier') {
        const calleeName = (call.callee as Identifier).name;

        if (knownHooks.has(calleeName)) {
          const contextNames = knownHooks.get(calleeName)!;

          for (const contextName of contextNames) {
            consumers.push({
              contextName,
              hookName: calleeName,
              componentName: currentComponent,
              filePath,
              line: getLineNumber(source, node.start || 0),
              isCustomHook: currentIsHook,
            });
          }
        }
      }
    }
  });

  return consumers;
}

// findAllComponentFiles replaced by scanComponentFiles from utils/file-scanner
const findAllComponentFiles = scanComponentFiles;

/**
 * Parse Context structure in a codebase
 */
export function parseContextMap(rootPath: string): ContextMapResult {
  const warnings: string[] = [];
  const allContexts: ContextDefinition[] = [];
  const allProviders: ProviderUsage[] = [];
  const allConsumers: ContextConsumer[] = [];
  const allCustomHooks: CustomContextHook[] = [];

  // Determine if rootPath is file or directory
  const stats = fs.existsSync(rootPath) ? fs.statSync(rootPath) : null;

  if (!stats) {
    return {
      contexts: [],
      providers: [],
      consumers: [],
      customHooks: [],
      hierarchy: [],
      warnings: [`Path not found: ${rootPath}`],
    };
  }

  let filesToScan: string[];

  if (stats.isDirectory()) {
    filesToScan = findAllComponentFiles(rootPath);
  } else {
    // When given a file, scan its parent directory to find all context
    // definitions and consumers across the codebase (not just the entry file)
    const dir = path.dirname(rootPath);
    filesToScan = findAllComponentFiles(dir);
  }

  // First pass: find all Context definitions
  for (const filePath of filesToScan) {
    const { ast, source } = parseFile(filePath);
    if (!ast) continue;

    const contexts = findContextDefinitions(ast, source, filePath);
    allContexts.push(...contexts);
  }

  // Build set of known context names
  const knownContexts = new Set(allContexts.map((c) => c.variableName));

  // Second pass: find providers and direct useContext consumers
  for (const filePath of filesToScan) {
    const { ast, source } = parseFile(filePath);
    if (!ast) continue;

    const providers = findProviderUsages(ast, source, filePath, knownContexts);
    allProviders.push(...providers);

    const consumers = findContextConsumers(ast, source, filePath);
    allConsumers.push(...consumers);

    const customHooks = findCustomContextHooks(ast, source, filePath, consumers);
    allCustomHooks.push(...customHooks);
  }

  // Build map of custom hook names -> context names they provide
  const knownHooks = new Map<string, string[]>();
  for (const hook of allCustomHooks) {
    const existing = knownHooks.get(hook.hookName) || [];
    if (!existing.includes(hook.contextName)) {
      existing.push(hook.contextName);
    }
    knownHooks.set(hook.hookName, existing);
  }

  // Third pass: find usages of custom hooks (components that call useAuth, useTabBar, etc.)
  if (knownHooks.size > 0) {
    for (const filePath of filesToScan) {
      const { ast, source } = parseFile(filePath);
      if (!ast) continue;

      const hookUsages = findCustomHookUsages(ast, source, filePath, knownHooks);
      // Filter out the hook definitions themselves (we already have those)
      const nonHookUsages = hookUsages.filter((c) => !c.isCustomHook);
      allConsumers.push(...nonHookUsages);
    }
  }

  // Build hierarchy
  const hierarchy = buildContextHierarchy(allContexts, allProviders, allConsumers, allCustomHooks);

  // Add warnings for orphan contexts
  for (const context of allContexts) {
    const hasProvider = allProviders.some((p) => p.contextName === context.name);
    const hasConsumer = allConsumers.some((c) => c.contextName === context.name);

    if (!hasProvider && !hasConsumer) {
      warnings.push(`Context "${context.name}" has no providers or consumers`);
    }
  }

  return {
    contexts: allContexts,
    providers: allProviders,
    consumers: allConsumers,
    customHooks: allCustomHooks,
    hierarchy,
    warnings,
  };
}

/**
 * Build context hierarchy mapping providers to consumers
 */
function buildContextHierarchy(
  contexts: ContextDefinition[],
  providers: ProviderUsage[],
  consumers: ContextConsumer[],
  customHooks: CustomContextHook[]
): ContextHierarchyNode[] {
  const hierarchy: ContextHierarchyNode[] = [];

  // Create a set of all unique context names
  const allContextNames = new Set<string>();
  contexts.forEach((c) => allContextNames.add(c.name));
  providers.forEach((p) => allContextNames.add(p.contextName));
  consumers.forEach((c) => allContextNames.add(c.contextName));

  for (const contextName of allContextNames) {
    const definition = contexts.find((c) => c.name === contextName) || null;
    const contextProviders = providers.filter((p) => p.contextName === contextName);
    const contextConsumers = consumers.filter((c) => c.contextName === contextName);
    const contextHooks = customHooks.filter((h) => h.contextName === contextName);

    hierarchy.push({
      contextName,
      definition,
      providers: contextProviders,
      consumers: contextConsumers,
      customHooks: contextHooks,
    });
  }

  // Sort by context name
  hierarchy.sort((a, b) => a.contextName.localeCompare(b.contextName));

  return hierarchy;
}

/**
 * Format context map as a readable tree string
 */
export function formatContextMap(result: ContextMapResult): string {
  if (result.hierarchy.length === 0) {
    return 'No React Context patterns found';
  }

  const lines: string[] = ['Context Providers:'];

  for (let i = 0; i < result.hierarchy.length; i++) {
    const node = result.hierarchy[i];
    const isLast = i === result.hierarchy.length - 1;
    const prefix = isLast ? '└── ' : '├── ';
    const childPrefix = isLast ? '    ' : '│   ';

    // Context name and definition file
    const defFile = node.definition
      ? ` (${path.basename(node.definition.filePath)})`
      : ' (external)';
    lines.push(`${prefix}${node.contextName}Provider${defFile}`);

    // Consumers
    const consumerComponents = [
      ...new Set(
        node.consumers
          .filter((c) => !c.isCustomHook && c.componentName)
          .map((c) => c.componentName!)
      ),
    ];

    if (consumerComponents.length > 0) {
      lines.push(`${childPrefix}├── Consumers: ${consumerComponents.join(', ')}`);
    }

    // Custom hooks
    const hookNames = [...new Set(node.customHooks.map((h) => h.hookName))];
    if (hookNames.length > 0) {
      lines.push(`${childPrefix}├── Hooks: ${hookNames.join(', ')}`);
    }

    // Provider locations
    const providerLocations = node.providers
      .filter((p) => p.wrapperComponent)
      .map((p) => p.wrapperComponent!);

    if (providerLocations.length > 0) {
      lines.push(`${childPrefix}└── Used in: ${[...new Set(providerLocations)].join(', ')}`);
    }
  }

  return lines.join('\n');
}
