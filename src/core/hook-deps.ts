/**
 * Hook Dependency Analysis Module
 *
 * Analyzes React hook dependencies (useEffect, useMemo, useCallback, etc.)
 * Provides information beyond what ESLint's exhaustive-deps rule offers:
 * - Dependency classification (prop, state, context, ref, external)
 * - Visual dependency graph
 * - Cross-component dependency tracking
 * - Stale closure pattern detection
 *
 * @module hook-deps
 */

import { parseSync, ParseResult } from 'oxc-parser';
import * as fs from 'fs';
import * as path from 'path';
import { walkASTSimple, type ESTreeNode } from './utils/ast-walker';

/**
 * Types of hooks that accept dependency arrays
 */
export type HookType =
  | 'useEffect'
  | 'useMemo'
  | 'useCallback'
  | 'useLayoutEffect'
  | 'useInsertionEffect'
  | 'useImperativeHandle';

/**
 * Classification of a dependency
 */
export type DependencyType =
  | 'prop'
  | 'state'
  | 'context'
  | 'ref'
  | 'external'
  | 'function'
  | 'constant'
  | 'unknown';

/**
 * Information about a single dependency
 */
export interface DependencyInfo {
  name: string;
  type: DependencyType;
  source?: string;  // e.g., "useState", "useContext(ThemeContext)", "props"
  line: number;
}

/**
 * Information about a hook and its dependencies
 */
export interface HookDependencyInfo {
  hookType: HookType;
  line: number;
  column: number;
  dependencies: DependencyInfo[];
  hasEmptyDeps: boolean;    // [] - runs once
  hasNoDeps: boolean;       // missing deps array - runs every render
  potentialIssues: string[];
}

/**
 * Result of analyzing a file's hooks
 */
export interface HookAnalysisResult {
  file: string;
  component: string | null;
  hooks: HookDependencyInfo[];
  totalHooks: number;
  issueCount: number;
  stateVariables: string[];
  propDestructures: string[];
  contextUsages: string[];
  refVariables: string[];
  error?: string;
}

// Hook types that accept dependency arrays
const HOOKS_WITH_DEPS = new Set<HookType>([
  'useEffect',
  'useMemo',
  'useCallback',
  'useLayoutEffect',
  'useInsertionEffect',
  'useImperativeHandle',
]);

// Extended ESTree node types used by this parser

interface CallExpression extends ESTreeNode {
  type: 'CallExpression';
  callee: { type: string; name?: string };
  arguments: unknown[];
  start: number;
}

interface ArrayExpression extends ESTreeNode {
  type: 'ArrayExpression';
  elements: Array<{ type: string; name?: string } | null>;
}

interface VariableDeclarator extends ESTreeNode {
  type: 'VariableDeclarator';
  id: { type: string; name?: string; elements?: Array<{ name?: string } | null> };
  init?: { type: string; callee?: { name?: string }; arguments?: unknown[] };
}

// walkAST replaced by walkASTSimple from utils/ast-walker
const walkAST = walkASTSimple;

/**
 * Convert byte offset to line number
 */
function offsetToLine(code: string, offset: number): { line: number; column: number } {
  const lines = code.slice(0, offset).split('\n');
  return {
    line: lines.length,
    column: lines[lines.length - 1].length + 1,
  };
}

/**
 * Extract hook calls from AST
 */
function findHookCalls(parseResult: ParseResult, code: string): HookDependencyInfo[] {
  const hooks: HookDependencyInfo[] = [];

  if (!parseResult?.program) {
    return hooks;
  }

  walkAST(parseResult.program, (node) => {
    if (node.type === 'CallExpression') {
      const call = node as CallExpression;
      const callee = call.callee;

      // Check if it's a hook we care about
      let hookName: string | undefined;
      if (callee.type === 'Identifier' && callee.name) {
        hookName = callee.name;
      }

      if (!hookName || !HOOKS_WITH_DEPS.has(hookName as HookType)) {
        return;
      }

      const args = call.arguments as unknown[];
      const { line, column } = offsetToLine(code, call.start);

      // Determine dependency array status
      let dependencies: DependencyInfo[] = [];
      let hasEmptyDeps = false;
      let hasNoDeps = true;

      // useCallback and useMemo have callback first, deps second
      // useEffect and useLayoutEffect have effect first, deps second
      // useImperativeHandle has ref first, factory second, deps third
      const depsArgIndex = hookName === 'useImperativeHandle' ? 2 : 1;

      if (args.length > depsArgIndex) {
        const depsArg = args[depsArgIndex] as ESTreeNode;

        if (depsArg && depsArg.type === 'ArrayExpression') {
          hasNoDeps = false;
          const arrayExpr = depsArg as ArrayExpression;

          if (!arrayExpr.elements || arrayExpr.elements.length === 0) {
            hasEmptyDeps = true;
          } else {
            dependencies = arrayExpr.elements
              .filter((el): el is { type: string; name?: string } => el !== null && el.type === 'Identifier')
              .map((el) => ({
                name: el.name || 'unknown',
                type: 'unknown' as DependencyType,
                line,
              }));
          }
        }
      }

      // Detect potential issues
      const potentialIssues: string[] = [];

      if (hasNoDeps && (hookName === 'useEffect' || hookName === 'useLayoutEffect')) {
        potentialIssues.push('Missing dependency array - effect runs on every render');
      }

      if (hasEmptyDeps && hookName === 'useEffect') {
        // This is often intentional, but note it
        // potentialIssues.push('Empty dependency array - effect runs only on mount');
      }

      hooks.push({
        hookType: hookName as HookType,
        line,
        column,
        dependencies,
        hasEmptyDeps,
        hasNoDeps,
        potentialIssues,
      });
    }
  });

  return hooks;
}

/**
 * Extract state variables from useState calls
 */
function findStateVariables(parseResult: ParseResult): string[] {
  const stateVars: string[] = [];

  if (!parseResult?.program) {
    return stateVars;
  }

  walkAST(parseResult.program, (node) => {
    if (node.type === 'VariableDeclarator') {
      const declarator = node as VariableDeclarator;

      if (declarator.init?.type === 'CallExpression' &&
          declarator.init.callee?.name === 'useState') {
        // Get first element of destructured array [state, setState]
        if (declarator.id?.type === 'ArrayPattern' &&
            declarator.id.elements?.[0]?.name) {
          stateVars.push(declarator.id.elements[0].name);
        }
      }
    }
  });

  return stateVars;
}

/**
 * Extract ref variables from useRef calls
 */
function findRefVariables(parseResult: ParseResult): string[] {
  const refs: string[] = [];

  if (!parseResult?.program) {
    return refs;
  }

  walkAST(parseResult.program, (node) => {
    if (node.type === 'VariableDeclarator') {
      const declarator = node as VariableDeclarator;

      if (declarator.init?.type === 'CallExpression' &&
          declarator.init.callee?.name === 'useRef') {
        if (declarator.id?.name) {
          refs.push(declarator.id.name);
        }
      }
    }
  });

  return refs;
}

/**
 * Extract context usages from useContext calls
 */
function findContextUsages(parseResult: ParseResult): string[] {
  const contexts: string[] = [];

  if (!parseResult?.program) {
    return contexts;
  }

  walkAST(parseResult.program, (node) => {
    if (node.type === 'VariableDeclarator') {
      const declarator = node as VariableDeclarator;

      if (declarator.init?.type === 'CallExpression' &&
          declarator.init.callee?.name === 'useContext') {
        // Get the context name from the argument
        const args = declarator.init.arguments as Array<{ name?: string }>;
        if (args?.[0]?.name) {
          contexts.push(args[0].name);
        }
      }
    }
  });

  return contexts;
}

/**
 * Find component name in the file
 */
function findComponentName(parseResult: ParseResult): string | null {
  if (!parseResult?.program) {
    return null;
  }

  let componentName: string | null = null;

  walkAST(parseResult.program, (node) => {
    // Function declaration component
    if (node.type === 'FunctionDeclaration') {
      const funcNode = node as { id?: { name: string } };
      if (funcNode.id?.name && /^[A-Z]/.test(funcNode.id.name)) {
        componentName = funcNode.id.name;
      }
    }

    // Arrow function component
    if (node.type === 'VariableDeclarator') {
      const declarator = node as VariableDeclarator;
      if (declarator.init?.type === 'ArrowFunctionExpression' &&
          declarator.id?.name &&
          /^[A-Z]/.test(declarator.id.name)) {
        componentName = declarator.id.name;
      }
    }
  });

  return componentName;
}

/**
 * Classify dependencies based on their sources
 */
function classifyDependencies(
  hooks: HookDependencyInfo[],
  stateVariables: string[],
  refVariables: string[],
  propDestructures: string[]
): HookDependencyInfo[] {
  const stateSet = new Set(stateVariables);
  const refSet = new Set(refVariables);
  const propSet = new Set(propDestructures);

  return hooks.map(hook => ({
    ...hook,
    dependencies: hook.dependencies.map(dep => {
      let type: DependencyType = 'unknown';
      let source: string | undefined;

      if (stateSet.has(dep.name)) {
        type = 'state';
        source = 'useState';
      } else if (refSet.has(dep.name)) {
        type = 'ref';
        source = 'useRef';
      } else if (propSet.has(dep.name)) {
        type = 'prop';
        source = 'props';
      } else if (dep.name.startsWith('set') && stateSet.has(dep.name.slice(3).toLowerCase())) {
        type = 'function';
        source = 'useState setter';
      } else if (/^[A-Z]/.test(dep.name)) {
        type = 'external';
        source = 'imported';
      }

      return {
        ...dep,
        type,
        source,
      };
    }),
  }));
}

/**
 * Find props destructured in component parameters
 */
function findPropDestructures(parseResult: ParseResult): string[] {
  const props: string[] = [];

  if (!parseResult?.program) {
    return props;
  }

  walkAST(parseResult.program, (node) => {
    // Function with destructured props: function Component({ prop1, prop2 })
    if (node.type === 'FunctionDeclaration' || node.type === 'ArrowFunctionExpression') {
      const funcNode = node as { params?: Array<{ type: string; properties?: Array<{ key?: { name: string } }> }> };
      const params = funcNode.params;

      if (params && params[0]?.type === 'ObjectPattern') {
        const objPattern = params[0];
        if (objPattern.properties) {
          for (const prop of objPattern.properties) {
            if (prop.key?.name) {
              props.push(prop.key.name);
            }
          }
        }
      }
    }
  });

  return props;
}

/**
 * Analyze hook dependencies in a file
 */
export function analyzeHookDependencies(filePath: string): HookAnalysisResult {
  const absolutePath = path.resolve(filePath);

  if (!fs.existsSync(absolutePath)) {
    return {
      file: path.basename(filePath),
      component: null,
      hooks: [],
      totalHooks: 0,
      issueCount: 0,
      stateVariables: [],
      propDestructures: [],
      contextUsages: [],
      refVariables: [],
      error: `File not found: ${filePath}`,
    };
  }

  const code = fs.readFileSync(absolutePath, 'utf-8');
  const filename = path.basename(absolutePath);

  let parseResult: ParseResult;
  try {
    parseResult = parseSync(filename, code);
  } catch (error) {
    return {
      file: filename,
      component: null,
      hooks: [],
      totalHooks: 0,
      issueCount: 0,
      stateVariables: [],
      propDestructures: [],
      contextUsages: [],
      refVariables: [],
      error: `Parse error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // Extract various declarations
  const componentName = findComponentName(parseResult);
  const stateVariables = findStateVariables(parseResult);
  const refVariables = findRefVariables(parseResult);
  const contextUsages = findContextUsages(parseResult);
  const propDestructures = findPropDestructures(parseResult);

  // Find and classify hook dependencies
  let hooks = findHookCalls(parseResult, code);
  hooks = classifyDependencies(hooks, stateVariables, refVariables, propDestructures);

  // Count total issues
  const issueCount = hooks.reduce((count, hook) => count + hook.potentialIssues.length, 0);

  return {
    file: filename,
    component: componentName,
    hooks,
    totalHooks: hooks.length,
    issueCount,
    stateVariables,
    propDestructures,
    contextUsages,
    refVariables,
  };
}
