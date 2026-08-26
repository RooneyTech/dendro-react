/**
 * Component Complexity Parser
 *
 * Calculates complexity metrics for React components to identify
 * potential problem areas and refactoring candidates.
 *
 * Metrics:
 * - lines: Total lines of code
 * - jsxDepth: Maximum JSX nesting depth
 * - imports: Number of import statements
 * - propsCount: Number of component props
 * - stateCount: Number of useState/useReducer hooks
 * - effectCount: Number of useEffect hooks
 *
 * @module complexity-parser
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseSync, ParseResult } from 'oxc-parser';
import { walkASTWithDepth, type ESTreeNode } from './utils/ast-walker';
import { scanComponentFiles } from './utils/file-scanner';

// Extended types used by this parser

export interface ComplexityMetrics {
  lines: number;
  jsxDepth: number;
  imports: number;
  propsCount: number;
  stateCount: number;
  effectCount: number;
}

export interface ComplexityScore {
  metrics: ComplexityMetrics;
  score: number;
  rating: 'low' | 'medium' | 'high';
}

export interface ComponentComplexity {
  file: string;
  absolutePath: string;
  componentName: string | null;
  metrics: ComplexityMetrics;
  score: number;
  rating: 'low' | 'medium' | 'high';
}

export interface ComplexityReportSummary {
  high: number;
  medium: number;
  low: number;
  average: number;
  totalComponents: number;
}

export interface ComplexityReport {
  components: ComponentComplexity[];
  summary: ComplexityReportSummary;
  formattedReport: string;
  warnings: string[];
}

// walkAST replaced by walkASTWithDepth from utils/ast-walker
const walkAST = walkASTWithDepth;

// React 18/19 hooks that own state. useActionState/useOptimistic hold state
// exactly like useState — leaving them out under-counted React 19 components.
const STATE_HOOKS = new Set(['useState', 'useReducer', 'useActionState', 'useOptimistic']);
const EFFECT_HOOKS = new Set(['useEffect', 'useLayoutEffect', 'useInsertionEffect']);

/** A component declaration's byte range within the file. */
interface ComponentBoundary {
  name: string;
  start: number;
  end: number;
  params?: unknown[];
}

/** Inclusive-range check; boundaries of 'whole file' use [0, Infinity). */
function inRange(node: ESTreeNode, range: { start: number; end: number }): boolean {
  const n = node as { start?: number; end?: number };
  return typeof n.start === 'number' && typeof n.end === 'number' &&
    n.start >= range.start && n.end <= range.end;
}

/**
 * Find every component declaration in the file with its span.
 * A 600-line file with three components must yield three scoped entries — the
 * old file-global counters attributed every hook and line to a single (and
 * arbitrarily chosen) component name.
 */
function findComponentBoundaries(parseResult: ParseResult): ComponentBoundary[] {
  const boundaries: ComponentBoundary[] = [];

  walkAST(parseResult.program, (node) => {
    const n = node as { start?: number; end?: number };
    if (typeof n.start !== 'number' || typeof n.end !== 'number') return;

    if (node.type === 'FunctionDeclaration') {
      const id = (node as { id?: { name?: string } }).id;
      if (id?.name && /^[A-Z]/.test(id.name)) {
        boundaries.push({ name: id.name, start: n.start, end: n.end, params: (node as { params?: unknown[] }).params });
      }
    }
    if (node.type === 'VariableDeclarator') {
      const id = (node as { id?: { name?: string } }).id;
      const init = (node as { init?: ESTreeNode & { start?: number; end?: number; params?: unknown[] } }).init;
      if (id?.name && /^[A-Z]/.test(id.name) &&
          (init?.type === 'ArrowFunctionExpression' || init?.type === 'FunctionExpression') &&
          typeof init.start === 'number' && typeof init.end === 'number') {
        boundaries.push({ name: id.name, start: init.start, end: init.end, params: init.params });
      }
    }
    if (node.type === 'ClassDeclaration') {
      const id = (node as { id?: { name?: string } }).id;
      if (id?.name && /^[A-Z]/.test(id.name)) {
        boundaries.push({ name: id.name, start: n.start, end: n.end });
      }
    }
  });

  // Drop nested declarations (a component defined inside another) — count the
  // outer one only, so inner render helpers don't double-report.
  return boundaries.filter(b =>
    !boundaries.some(other => other !== b && other.start < b.start && other.end > b.end)
  );
}

/** Count hook calls by name set, scoped to a byte range. */
function countHooksInRange(parseResult: ParseResult, names: Set<string>, range: { start: number; end: number }): number {
  let count = 0;
  walkAST(parseResult.program, (node) => {
    if (node.type !== 'CallExpression' || !inRange(node, range)) return;
    const callee = node.callee as ESTreeNode;
    if (callee?.type === 'Identifier' && names.has((callee as { name?: string }).name || '')) count++;
    if (callee?.type === 'MemberExpression') {
      const obj = (callee as { object?: { name?: string } }).object;
      const prop = (callee as { property?: { name?: string } }).property;
      if (obj?.name === 'React' && names.has(prop?.name || '')) count++;
    }
  });
  return count;
}

/** Max JSX nesting depth within a byte range. */
function jsxDepthInRange(parseResult: ParseResult, range: { start: number; end: number }): number {
  let maxDepth = 0;
  function walkJsx(node: unknown, currentDepth: number): void {
    if (!node || typeof node !== 'object') return;
    const esNode = node as ESTreeNode;
    if ((esNode.type === 'JSXElement' || esNode.type === 'JSXFragment') && inRange(esNode, range)) {
      const newDepth = currentDepth + 1;
      maxDepth = Math.max(maxDepth, newDepth);
      const children = (esNode as { children?: unknown[] }).children || [];
      for (const child of children) walkJsx(child, newDepth);
      return;
    }
    for (const key of Object.keys(esNode)) {
      const child = (esNode as Record<string, unknown>)[key];
      if (Array.isArray(child)) child.forEach((c) => walkJsx(c, currentDepth));
      else if (child && typeof child === 'object') walkJsx(child, currentDepth);
    }
  }
  walkJsx(parseResult.program, 0);
  return maxDepth;
}

function countPropsInParams(params: unknown[]): number {
  if (params.length === 0) return 0;

  const firstParam = params[0] as ESTreeNode;

  // Destructured props: ({ prop1, prop2 })
  if (firstParam?.type === 'ObjectPattern') {
    const properties = (firstParam as { properties?: unknown[] }).properties || [];
    return properties.length;
  }

  // Non-destructured props: (props) - count as 1
  if (firstParam?.type === 'Identifier') {
    return 1;
  }

  return 0;
}

/**
 * Count import statements.
 */
function countImports(parseResult: ParseResult): number {
  let count = 0;

  walkAST(parseResult.program, (node) => {
    if (node.type === 'ImportDeclaration') {
      count++;
    }
  });

  return count;
}

/**
 * Calculate complexity score based on metrics.
 *
 * Formula:
 * score = (lines/100 * 2 + jsxDepth * 1 + stateCount * 1.5 + effectCount * 2 + propsCount/5 * 1) / 5
 *
 * Rating:
 * - < 3: low (green)
 * - 3-6: medium (yellow)
 * - > 6: high (red)
 */
function calculateScore(metrics: ComplexityMetrics): ComplexityScore {
  const rawScore =
    (metrics.lines / 100) * 2 +
    metrics.jsxDepth * 1 +
    metrics.stateCount * 1.5 +
    metrics.effectCount * 2 +
    (metrics.propsCount / 5) * 1;

  // Normalize to roughly 1-10 scale
  const score = Math.round((rawScore / 5) * 10) / 10;

  let rating: 'low' | 'medium' | 'high';
  if (score < 3) {
    rating = 'low';
  } else if (score <= 6) {
    rating = 'medium';
  } else {
    rating = 'high';
  }

  return { metrics, score, rating };
}

/**
 * Parse a single file and calculate complexity for EVERY component in it.
 * Metrics are scoped to each component's own declaration span — lines, hooks,
 * JSX depth, and props belong to the component, not the file. `imports` is the
 * one deliberate exception: imports are a file-level property, reported
 * identically on each component from that file.
 */
export function analyzeFileComplexityAll(filePath: string): ComponentComplexity[] {
  if (!fs.existsSync(filePath)) return [];

  const content = fs.readFileSync(filePath, 'utf-8');

  try {
    const parseResult = parseSync(path.basename(filePath), content);
    const imports = countImports(parseResult);
    const boundaries = findComponentBoundaries(parseResult);

    // No recognizable component declaration — fall back to one file-level
    // entry (componentName null) so JSX-bearing files aren't silently dropped.
    if (boundaries.length === 0) {
      const wholeFile = { start: 0, end: content.length };
      const metrics: ComplexityMetrics = {
        lines: content.split('\n').length,
        jsxDepth: jsxDepthInRange(parseResult, wholeFile),
        imports,
        propsCount: 0,
        stateCount: countHooksInRange(parseResult, STATE_HOOKS, wholeFile),
        effectCount: countHooksInRange(parseResult, EFFECT_HOOKS, wholeFile),
      };
      const { score, rating } = calculateScore(metrics);
      return [{
        file: path.basename(filePath),
        absolutePath: filePath,
        componentName: null,
        metrics, score, rating,
      }];
    }

    return boundaries.map(b => {
      const range = { start: b.start, end: b.end };
      const spanLines = content.slice(b.start, b.end).split('\n').length;
      const metrics: ComplexityMetrics = {
        lines: spanLines,
        jsxDepth: jsxDepthInRange(parseResult, range),
        imports,
        propsCount: b.params ? countPropsInParams(b.params) : 0,
        stateCount: countHooksInRange(parseResult, STATE_HOOKS, range),
        effectCount: countHooksInRange(parseResult, EFFECT_HOOKS, range),
      };
      const { score, rating } = calculateScore(metrics);
      return {
        file: path.basename(filePath),
        absolutePath: filePath,
        componentName: b.name,
        metrics, score, rating,
      };
    });
  } catch {
    return [];
  }
}

/**
 * Public: list the component declarations in one file (name only, cheap).
 * Used by name→file resolution (get_component_contract) — component names,
 * not file basenames, are what agents actually search by.
 */
export function listComponentsInFile(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parseResult = parseSync(path.basename(filePath), content);
    return findComponentBoundaries(parseResult).map(b => b.name);
  } catch {
    return [];
  }
}

/**
 * Back-compat single-result wrapper: returns the file's principal component
 * (largest declaration span), or null.
 */
export function analyzeFileComplexity(filePath: string): ComponentComplexity | null {
  const all = analyzeFileComplexityAll(filePath);
  if (all.length === 0) return null;
  return all.reduce((best, c) => (c.metrics.lines > best.metrics.lines ? c : best), all[0]);
}

/**
 * Recursively find all component files in a directory.
 */
// findComponentFiles replaced by scanComponentFiles from utils/file-scanner
// Note: old version only scanned .tsx/.jsx and had no maxDepth (unbounded recursion bug).
// scanComponentFiles scans all EXTENSIONS with maxDepth=5 by default.
function findComponentFiles(dir: string): string[] {
  return scanComponentFiles(dir, { extensions: ['.tsx', '.jsx'] });
}

/**
 * Format the complexity report as a readable string.
 */
function formatComplexityReport(components: ComponentComplexity[], summary: ComplexityReportSummary): string {
  const lines: string[] = [];

  lines.push('Component Complexity Report');
  lines.push('===========================');
  lines.push('');

  // High complexity section
  const high = components.filter(c => c.rating === 'high');
  if (high.length > 0) {
    lines.push('High Complexity (refactor candidates):');
    for (const c of high) {
      const name = c.componentName || c.file;
      const details = `${c.metrics.lines} lines, ${c.metrics.stateCount} state, ${c.metrics.effectCount} effects`;
      lines.push(`├── ${name.padEnd(30)} Score: ${c.score.toFixed(1)}  (${details})`);
    }
    lines.push('');
  }

  // Medium complexity section
  const medium = components.filter(c => c.rating === 'medium');
  if (medium.length > 0) {
    lines.push('Medium Complexity:');
    for (const c of medium) {
      const name = c.componentName || c.file;
      lines.push(`├── ${name.padEnd(30)} Score: ${c.score.toFixed(1)}`);
    }
    lines.push('');
  }

  // Low complexity section
  const low = components.filter(c => c.rating === 'low');
  if (low.length > 0) {
    lines.push('Low Complexity:');
    const displayCount = Math.min(low.length, 5);
    for (let i = 0; i < displayCount; i++) {
      const c = low[i];
      const name = c.componentName || c.file;
      lines.push(`├── ${name.padEnd(30)} Score: ${c.score.toFixed(1)}`);
    }
    if (low.length > 5) {
      lines.push(`└── ... (${low.length - 5} more)`);
    }
    lines.push('');
  }

  // Summary
  lines.push('Summary:');
  lines.push(`├── Total Components: ${summary.totalComponents}`);
  lines.push(`├── High Complexity: ${summary.high}`);
  lines.push(`├── Medium Complexity: ${summary.medium}`);
  lines.push(`├── Low Complexity: ${summary.low}`);
  lines.push(`└── Average Score: ${summary.average.toFixed(1)}`);

  return lines.join('\n');
}

/**
 * Generate a complexity report for a directory of React components.
 */
export function parseComplexityReport(rootPath: string, threshold?: number): ComplexityReport {
  const absolutePath = path.resolve(rootPath);
  const warnings: string[] = [];

  if (!fs.existsSync(absolutePath)) {
    return {
      components: [],
      summary: { high: 0, medium: 0, low: 0, average: 0, totalComponents: 0 },
      formattedReport: 'Path not found.',
      warnings: [`Path not found: ${absolutePath}`],
    };
  }

  const stats = fs.statSync(absolutePath);
  let files: string[] = [];

  if (stats.isDirectory()) {
    files = findComponentFiles(absolutePath);
  } else if (stats.isFile()) {
    files = [absolutePath];
  }

  const components: ComponentComplexity[] = [];
  let parseFailures = 0;

  for (const file of files) {
    const fileComponents = analyzeFileComplexityAll(file);
    if (fileComponents.length === 0 && fs.existsSync(file)) parseFailures++;
    for (const complexity of fileComponents) {
      // Apply threshold filter if specified
      if (threshold === undefined || complexity.score >= threshold) {
        components.push(complexity);
      }
    }
  }

  if (parseFailures > 0) {
    warnings.push(`${parseFailures} file(s) could not be parsed and are NOT included in this report.`);
  }

  // Sort by score descending (most complex first)
  components.sort((a, b) => b.score - a.score);

  // Calculate summary
  const high = components.filter(c => c.rating === 'high').length;
  const medium = components.filter(c => c.rating === 'medium').length;
  const low = components.filter(c => c.rating === 'low').length;
  const totalScore = components.reduce((sum, c) => sum + c.score, 0);
  const average = components.length > 0 ? totalScore / components.length : 0;

  const summary: ComplexityReportSummary = {
    high,
    medium,
    low,
    average,
    totalComponents: components.length,
  };

  const formattedReport = formatComplexityReport(components, summary);

  return {
    components,
    summary,
    formattedReport,
    warnings,
  };
}
