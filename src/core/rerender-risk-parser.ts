/**
 * Re-Render Risk Parser
 *
 * Detects common React performance anti-patterns that cause unnecessary
 * re-renders via static AST analysis. Scans for:
 * - Inline objects/arrays/functions in JSX props
 * - Body-scoped functions passed as props without useCallback
 * - Computed values passed as props without useMemo
 *
 * @module rerender-risk-parser
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseSync } from 'oxc-parser';
import { walkASTSimple, type ESTreeNode } from './utils/ast-walker';
import { scanComponentFiles } from './utils/file-scanner';
import { detectFileDirective } from './utils/directives';
import { detectReactCompiler } from './utils/react-compiler';

// Narrower ESTree node type for this parser — OXC nodes always have start/end
interface PositionedNode extends ESTreeNode {
  start: number;
  end: number;
}

export type RiskType = 'inline-object' | 'inline-array' | 'inline-function' | 'missing-useCallback' | 'missing-useMemo';
export type RiskSeverity = 'low' | 'medium' | 'high';

export interface RerenderRisk {
  type: RiskType;
  severity: RiskSeverity;
  line: number;
  column: number;
  propName: string;
  componentName: string;
  description: string;
  suggestion: string;
  variableName?: string;
}

export interface FileRerenderRisks {
  file: string;
  absolutePath: string;
  componentName: string | null;
  risks: RerenderRisk[];
  riskCount: number;
  hasMemo: boolean;
}

export interface RerenderRiskSummary {
  totalFiles: number;
  totalRisks: number;
  byType: Record<RiskType, number>;
  bySeverity: Record<RiskSeverity, number>;
  topOffenders: Array<{ file: string; componentName: string | null; riskCount: number }>;
}

export interface RerenderRiskReport {
  files: FileRerenderRisks[];
  summary: RerenderRiskSummary;
  formattedReport: string;
  warnings: string[];
}

// Array methods that produce new references (missing-useMemo detection)
const ARRAY_METHODS = new Set([
  'map', 'filter', 'reduce', 'sort', 'slice', 'concat',
  'flat', 'flatMap', 'find', 'some', 'every',
]);

// walkAST replaced by walkASTSimple from utils/ast-walker
// This parser needs start/end as required numbers (OXC always provides them)
function walkAST(node: unknown, callback: (node: PositionedNode) => void): void {
  walkASTSimple(node, (n) => callback(n as PositionedNode));
}

/**
 * Convert byte offset to line/column.
 */
function offsetToPosition(code: string, offset: number): { line: number; column: number } {
  const lines = code.slice(0, offset).split('\n');
  return {
    line: lines.length,
    column: lines[lines.length - 1].length + 1,
  };
}

/** Why a file produced no result — lets the report explain instead of silently omitting. */
export type RerenderSkipReason = 'missing' | 'server-file' | 'no-component' | 'parse-error';

/**
 * Analyze a single file for re-render risks.
 * Back-compat wrapper — see analyzeFileRerenderRisksEx for skip reasons.
 */
export function analyzeFileRerenderRisks(filePath: string): FileRerenderRisks | null {
  return analyzeFileRerenderRisksEx(filePath).result;
}

/**
 * Analyze a single file, reporting WHY when there is no result.
 * Files marked "use server" are skipped: server code runs per request, never
 * re-renders, and cannot legally use hooks — memoization advice there is wrong.
 */
export function analyzeFileRerenderRisksEx(filePath: string): { result: FileRerenderRisks | null; skipped?: RerenderSkipReason } {
  if (!fs.existsSync(filePath)) return { result: null, skipped: 'missing' };

  const code = fs.readFileSync(filePath, 'utf-8');
  if (detectFileDirective(code) === 'use server') {
    return { result: null, skipped: 'server-file' };
  }

  try {
    const parseResult = parseSync(path.basename(filePath), code);
    const program = parseResult.program as unknown as ESTreeNode;

    // Pass 1: Find component functions and collect scope info
    const components: Array<{
      name: string | null;
      start: number;
      end: number;
    }> = [];

    let hasMemo = false;
    // `memo` only counts when it is React's memo — a bare call to any function
    // named memo (lodash.memoize wrappers, cache.memo()) used to mark the whole
    // file as memoized.
    let reactMemoImported = false;
    walkAST(program, (node) => {
      if (node.type !== 'ImportDeclaration') return;
      const source = (node as { source?: { value?: string } }).source;
      if (source?.value !== 'react') return;
      const specifiers = (node as { specifiers?: Array<{ type?: string; imported?: { name?: string } }> }).specifiers;
      if (specifiers?.some(s => s.type === 'ImportSpecifier' && s.imported?.name === 'memo')) {
        reactMemoImported = true;
      }
    });
    const propsSet = new Set<string>();
    const stateSetters = new Set<string>();
    const refVars = new Set<string>();
    const callbackWrapped = new Set<string>();
    const memoWrapped = new Set<string>();
    const bareFunctions = new Map<string, ESTreeNode>();
    const bareComputed = new Map<string, ESTreeNode>();

    // Find component boundaries
    walkAST(program, (node) => {
      // React.memo wrapper detection
      if (node.type === 'CallExpression') {
        const callee = node.callee as ESTreeNode;
        if (callee?.type === 'Identifier' && (callee as { name?: string }).name === 'memo' && reactMemoImported) {
          hasMemo = true;
        }
        if (callee?.type === 'MemberExpression') {
          const obj = (callee as { object?: { name?: string } }).object;
          const prop = (callee as { property?: { name?: string } }).property;
          if (prop?.name === 'memo' && obj?.name === 'React') hasMemo = true;
        }
      }

      // function MyComponent() {}
      if (node.type === 'FunctionDeclaration') {
        const id = (node as { id?: { name?: string } }).id;
        if (id?.name && /^[A-Z]/.test(id.name)) {
          components.push({ name: id.name, start: node.start, end: node.end });
        }
      }

      // const MyComponent = () => {} or const MyComponent = function() {}
      if (node.type === 'VariableDeclarator') {
        const id = (node as { id?: { name?: string } }).id;
        const init = (node as { init?: PositionedNode }).init;
        if (id?.name && /^[A-Z]/.test(id.name)) {
          if (init?.type === 'ArrowFunctionExpression' || init?.type === 'FunctionExpression') {
            components.push({ name: id.name, start: init.start, end: init.end });
          }
        }
      }
    });

    if (components.length === 0) return { result: null, skipped: 'no-component' };

    // Use the first PascalCase component
    const mainComponent = components[0];
    const componentName = mainComponent.name;

    // Pass 2: Analyze within component boundaries
    walkAST(program, (node) => {
      // Only analyze nodes inside component boundaries
      if (node.start < mainComponent.start || node.end > mainComponent.end) return;

      // Collect props from destructured params
      if (node.type === 'FunctionDeclaration' || node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') {
        // Only process the component function itself, not inner functions
        if (node.start === mainComponent.start || (node.type !== 'FunctionDeclaration' && node.start === mainComponent.start)) {
          const params = (node as { params?: unknown[] }).params;
          if (params && params.length > 0) {
            const firstParam = params[0] as ESTreeNode;
            if (firstParam?.type === 'ObjectPattern') {
              const properties = (firstParam as { properties?: Array<{ key?: { name?: string } }> }).properties;
              if (properties) {
                for (const prop of properties) {
                  if (prop.key?.name) propsSet.add(prop.key.name);
                }
              }
            }
          }
        }
      }

      // Collect useState setters
      if (node.type === 'VariableDeclarator') {
        const init = (node as { init?: ESTreeNode }).init;
        if (init?.type === 'CallExpression') {
          const callee = (init as { callee?: ESTreeNode }).callee;
          const calleeName = callee?.type === 'Identifier' ? (callee as { name?: string }).name : undefined;

          // Hooks whose tuple includes a referentially-stable function:
          // useState setter, useReducer dispatch, useTransition startTransition,
          // useOptimistic dispatch (all [1]) and useActionState action ([1]).
          // React guarantees these identities are stable across renders.
          if (calleeName === 'useState' || calleeName === 'useReducer' ||
              calleeName === 'useTransition' || calleeName === 'useOptimistic' ||
              calleeName === 'useActionState') {
            const id = (node as { id?: ESTreeNode }).id;
            if (id?.type === 'ArrayPattern') {
              const elements = (id as { elements?: Array<{ name?: string } | null> }).elements;
              if (elements) {
                if (elements[1]?.name) stateSetters.add(elements[1].name);
              }
            }
          }

          if (calleeName === 'useRef') {
            const id = (node as { id?: { name?: string } }).id;
            if (id?.name) refVars.add(id.name);
          }

          if (calleeName === 'useCallback') {
            const id = (node as { id?: { name?: string } }).id;
            if (id?.name) callbackWrapped.add(id.name);
          }

          if (calleeName === 'useMemo') {
            const id = (node as { id?: { name?: string } }).id;
            if (id?.name) memoWrapped.add(id.name);
          }
        }

        // Bare function declarations: const fn = () => {} (not inside useCallback)
        const varInit = (node as { init?: ESTreeNode }).init;
        const varId = (node as { id?: { name?: string } }).id;
        if (varId?.name && !callbackWrapped.has(varId.name)) {
          if (varInit?.type === 'ArrowFunctionExpression' || varInit?.type === 'FunctionExpression') {
            // Make sure it's not the component itself and not wrapped
            if (varId.name !== componentName && !/^[A-Z]/.test(varId.name)) {
              bareFunctions.set(varId.name, node);
            }
          }

          // Bare computed: identifier = expr.filter/map/etc(...)
          if (varInit?.type === 'CallExpression') {
            const callCallee = (varInit as { callee?: ESTreeNode }).callee;
            if (callCallee?.type === 'MemberExpression') {
              const prop = (callCallee as { property?: { name?: string } }).property;
              if (prop?.name && ARRAY_METHODS.has(prop.name)) {
                if (!memoWrapped.has(varId.name)) {
                  bareComputed.set(varId.name, node);
                }
              }
            }
          }

          // Bare spread object: const config = { ...something }
          if (varInit?.type === 'ObjectExpression') {
            const properties = (varInit as { properties?: ESTreeNode[] }).properties;
            if (properties?.some(p => p.type === 'SpreadElement')) {
              if (!memoWrapped.has(varId.name)) {
                bareComputed.set(varId.name, node);
              }
            }
          }
        }
      }

      // Bare function declarations: function handleClick() {}
      if (node.type === 'FunctionDeclaration') {
        const id = (node as { id?: { name?: string } }).id;
        if (id?.name && !/^[A-Z]/.test(id.name) && node.start > mainComponent.start) {
          bareFunctions.set(id.name, node);
        }
      }
    });

    // Pass 3: Analyze JSX attributes for risks
    const risks: RerenderRisk[] = [];

    walkAST(program, (node) => {
      if (node.start < mainComponent.start || node.end > mainComponent.end) return;

      if (node.type === 'JSXAttribute') {
        const attrName = (node as { name?: { name?: string } }).name;
        const propName = attrName?.name;
        if (!propName) return;

        // <form action={fn}> / formAction are the React 19 form idiom — the
        // function is a server action or form handler React invokes on submit,
        // not a prop compared between renders. Memoizing it is meaningless.
        if (propName === 'action' || propName === 'formAction') return;

        const value = (node as { value?: ESTreeNode }).value;
        if (!value || value.type !== 'JSXExpressionContainer') return;

        const expression = (value as { expression?: ESTreeNode }).expression;
        if (!expression) return;

        // Find the parent JSX element name
        const jsxElementName = findParentJSXElementName(program, node);

        // Inline object
        if (expression.type === 'ObjectExpression') {
          const pos = offsetToPosition(code, node.start);
          risks.push({
            type: 'inline-object',
            severity: 'medium',
            line: pos.line,
            column: pos.column,
            propName,
            componentName: jsxElementName || 'unknown',
            description: `Inline object in <${jsxElementName} ${propName}> creates a new reference every render`,
            suggestion: `Extract to a constant outside the component, or wrap with useMemo if it depends on state/props`,
          });
        }

        // Inline array
        if (expression.type === 'ArrayExpression') {
          const pos = offsetToPosition(code, node.start);
          risks.push({
            type: 'inline-array',
            severity: 'medium',
            line: pos.line,
            column: pos.column,
            propName,
            componentName: jsxElementName || 'unknown',
            description: `Inline array in <${jsxElementName} ${propName}> creates a new reference every render`,
            suggestion: `Extract to a constant outside the component, or wrap with useMemo`,
          });
        }

        // Inline function (arrow or function expression)
        if (expression.type === 'ArrowFunctionExpression' || expression.type === 'FunctionExpression') {
          const pos = offsetToPosition(code, node.start);
          risks.push({
            type: 'inline-function',
            severity: 'medium',
            line: pos.line,
            column: pos.column,
            propName,
            componentName: jsxElementName || 'unknown',
            description: `Inline function in <${jsxElementName} ${propName}> creates a new reference every render`,
            suggestion: `Extract to a named function and wrap with useCallback`,
          });
        }

        // Identifier — check for missing useCallback / useMemo
        if (expression.type === 'Identifier') {
          const varName = (expression as { name?: string }).name;
          if (!varName) return;

          // Skip safe identifiers
          if (propsSet.has(varName)) return;       // prop passthrough
          if (stateSetters.has(varName)) return;   // setState — stable
          if (refVars.has(varName)) return;         // useRef — stable
          if (callbackWrapped.has(varName)) return; // already in useCallback
          if (memoWrapped.has(varName)) return;     // already in useMemo

          // Missing useCallback
          if (bareFunctions.has(varName)) {
            const pos = offsetToPosition(code, node.start);
            risks.push({
              type: 'missing-useCallback',
              severity: 'high',
              line: pos.line,
              column: pos.column,
              propName,
              componentName: jsxElementName || 'unknown',
              description: `${varName} passed to <${jsxElementName} ${propName}> without useCallback — new reference every render`,
              suggestion: `Wrap ${varName} with useCallback: const ${varName} = useCallback(() => { ... }, [deps])`,
              variableName: varName,
            });
          }

          // Missing useMemo
          if (bareComputed.has(varName)) {
            const pos = offsetToPosition(code, node.start);
            risks.push({
              type: 'missing-useMemo',
              severity: 'medium',
              line: pos.line,
              column: pos.column,
              propName,
              componentName: jsxElementName || 'unknown',
              description: `${varName} passed to <${jsxElementName} ${propName}> without useMemo — recomputed every render`,
              suggestion: `Wrap with useMemo: const ${varName} = useMemo(() => expr, [deps])`,
              variableName: varName,
            });
          }
        }
      }
    });

    return {
      result: {
        file: path.basename(filePath),
        absolutePath: filePath,
        componentName,
        risks,
        riskCount: risks.length,
        hasMemo,
      },
    };
  } catch {
    return { result: null, skipped: 'parse-error' };
  }
}

/**
 * Find the name of the parent JSX opening element for a JSXAttribute.
 */
function findParentJSXElementName(program: ESTreeNode, targetAttr: ESTreeNode): string | null {
  let result: string | null = null;

  function walk(node: unknown): boolean {
    if (!node || typeof node !== 'object') return false;

    const esNode = node as ESTreeNode;

    if (esNode.type === 'JSXOpeningElement') {
      // Check if this opening element contains our attribute
      const attributes = (esNode as { attributes?: ESTreeNode[] }).attributes;
      if (attributes?.some(attr => attr === targetAttr)) {
        const name = (esNode as { name?: ESTreeNode }).name;
        if (name?.type === 'JSXIdentifier') {
          result = (name as { name?: string }).name || null;
        } else if (name?.type === 'JSXMemberExpression') {
          const obj = (name as { object?: { name?: string } }).object;
          const prop = (name as { property?: { name?: string } }).property;
          result = `${obj?.name || ''}.${prop?.name || ''}`;
        }
        return true;
      }
    }

    for (const key of Object.keys(node as object)) {
      const child = (node as Record<string, unknown>)[key];
      if (Array.isArray(child)) {
        for (const c of child) {
          if (walk(c)) return true;
        }
      } else if (child && typeof child === 'object') {
        if (walk(child)) return true;
      }
    }

    return false;
  }

  walk(program);
  return result;
}

// findComponentFiles replaced by scanComponentFiles from utils/file-scanner
// Note: old version only scanned .tsx/.jsx and had no maxDepth (unbounded recursion bug).
function findComponentFiles(dir: string): string[] {
  return scanComponentFiles(dir, { extensions: ['.tsx', '.jsx'] });
}

/**
 * Severity sort order.
 */
function severityOrder(s: RiskSeverity): number {
  switch (s) {
    case 'high': return 0;
    case 'medium': return 1;
    case 'low': return 2;
  }
}

/**
 * Format the risk report as a readable string.
 */
function formatRiskReport(files: FileRerenderRisks[], summary: RerenderRiskSummary): string {
  const lines: string[] = [];

  lines.push('Re-Render Risk Report');
  lines.push('=====================');
  lines.push('');

  // Group risks by severity
  const highFiles = files.filter(f => f.risks.some(r => r.severity === 'high'));
  const mediumFiles = files.filter(f => f.risks.some(r => r.severity === 'medium') && !highFiles.includes(f));

  if (highFiles.length > 0) {
    lines.push('High Severity:');
    for (const f of highFiles) {
      const highRisks = f.risks.filter(r => r.severity === 'high');
      lines.push(`\u251C\u2500\u2500 ${f.file.padEnd(30)} ${highRisks.length} risk${highRisks.length > 1 ? 's' : ''}`);
      for (const r of highRisks) {
        lines.push(`\u2502   \u2514\u2500\u2500 Line ${r.line}: ${r.description}`);
      }
    }
    lines.push('');
  }

  if (mediumFiles.length > 0) {
    lines.push('Medium Severity:');
    for (const f of mediumFiles) {
      const medRisks = f.risks.filter(r => r.severity === 'medium');
      lines.push(`\u251C\u2500\u2500 ${f.file.padEnd(30)} ${medRisks.length} risk${medRisks.length > 1 ? 's' : ''}`);
      for (const r of medRisks) {
        lines.push(`\u2502   \u2514\u2500\u2500 Line ${r.line}: ${r.description}`);
      }
    }
    lines.push('');
  }

  // Summary
  lines.push('Summary:');
  lines.push(`\u251C\u2500\u2500 Total Files Analyzed: ${summary.totalFiles}`);
  lines.push(`\u251C\u2500\u2500 Files with Risks: ${files.filter(f => f.riskCount > 0).length}`);
  lines.push(`\u251C\u2500\u2500 Total Risks: ${summary.totalRisks}`);
  lines.push(`\u2514\u2500\u2500 High: ${summary.bySeverity.high}, Medium: ${summary.bySeverity.medium}, Low: ${summary.bySeverity.low}`);

  return lines.join('\n');
}

/**
 * Generate a re-render risk report for a directory or single file.
 */
export function parseRerenderRiskReport(rootPath: string, minSeverity?: RiskSeverity): RerenderRiskReport {
  const absolutePath = path.resolve(rootPath);
  const warnings: string[] = [];

  if (!fs.existsSync(absolutePath)) {
    return {
      files: [],
      summary: {
        totalFiles: 0,
        totalRisks: 0,
        byType: { 'inline-object': 0, 'inline-array': 0, 'inline-function': 0, 'missing-useCallback': 0, 'missing-useMemo': 0 },
        bySeverity: { low: 0, medium: 0, high: 0 },
        topOffenders: [],
      },
      formattedReport: 'Path not found.',
      warnings: [`Path not found: ${absolutePath}`],
    };
  }

  const stats = fs.statSync(absolutePath);
  let filePaths: string[] = [];

  if (stats.isDirectory()) {
    filePaths = findComponentFiles(absolutePath);
  } else if (stats.isFile()) {
    filePaths = [absolutePath];
  }

  const allFiles: FileRerenderRisks[] = [];
  const compilerDetected = detectReactCompiler(absolutePath);
  let serverFilesSkipped = 0;
  const parseFailures: string[] = [];

  for (const fp of filePaths) {
    const { result, skipped } = analyzeFileRerenderRisksEx(fp);
    if (skipped === 'server-file') serverFilesSkipped++;
    if (skipped === 'parse-error') parseFailures.push(path.basename(fp));
    if (result) {
      // React Compiler auto-memoizes: memoization findings become informational.
      if (compilerDetected) {
        for (const r of result.risks) {
          if (r.type === 'missing-useCallback' || r.type === 'missing-useMemo' || r.type === 'inline-function') {
            r.severity = 'low';
            r.suggestion = `React Compiler detected in this project — it auto-memoizes this case, so no manual fix is needed unless the compiler bails out on this component. (Original suggestion: ${r.suggestion})`;
          }
        }
      }
      // Apply severity filter
      if (minSeverity) {
        const minOrder = severityOrder(minSeverity);
        result.risks = result.risks.filter(r => severityOrder(r.severity) <= minOrder);
        result.riskCount = result.risks.length;
      }
      allFiles.push(result);
    }
  }

  if (compilerDetected) {
    warnings.push('React Compiler detected (babel-plugin-react-compiler) — memoization findings (missing-useCallback, missing-useMemo, inline-function) were downgraded to low severity because the compiler handles them automatically.');
  }
  if (serverFilesSkipped > 0) {
    warnings.push(`Skipped ${serverFilesSkipped} "use server" file(s) — server code runs per request and never re-renders, so re-render analysis does not apply there.`);
  }
  if (parseFailures.length > 0) {
    warnings.push(`Failed to parse ${parseFailures.length} file(s): ${parseFailures.slice(0, 5).join(', ')}${parseFailures.length > 5 ? ', …' : ''} — their risks are NOT included in this report.`);
  }

  // Sort files by risk count descending
  allFiles.sort((a, b) => b.riskCount - a.riskCount);

  // Calculate summary
  const byType: Record<RiskType, number> = {
    'inline-object': 0,
    'inline-array': 0,
    'inline-function': 0,
    'missing-useCallback': 0,
    'missing-useMemo': 0,
  };
  const bySeverity: Record<RiskSeverity, number> = { low: 0, medium: 0, high: 0 };
  let totalRisks = 0;

  for (const f of allFiles) {
    for (const r of f.risks) {
      byType[r.type]++;
      bySeverity[r.severity]++;
      totalRisks++;
    }
  }

  const topOffenders = allFiles
    .filter(f => f.riskCount > 0)
    .slice(0, 5)
    .map(f => ({ file: f.file, componentName: f.componentName, riskCount: f.riskCount }));

  const summary: RerenderRiskSummary = {
    totalFiles: allFiles.length,
    totalRisks,
    byType,
    bySeverity,
    topOffenders,
  };

  const formattedReport = formatRiskReport(allFiles, summary);

  return {
    files: allFiles,
    summary,
    formattedReport,
    warnings,
  };
}
