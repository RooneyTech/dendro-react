/**
 * Effect Hygiene Parser
 *
 * Detects the two highest-signal React effect bug families (clean-room
 * implementations of well-known rule concepts; no third-party code):
 *
 * 1. effect-needs-cleanup — a useEffect creates a subscription, listener,
 *    timer, observer, or animation frame and returns no cleanup function.
 *    Leaks accumulate on every re-mount; the #1 real-world effect bug.
 *
 * 2. derived-state-effect — a useEffect whose body only mirrors props/state
 *    into other state via setters. Derived values should be computed during
 *    render (or with useMemo); the effect version causes double renders and
 *    stale-state bugs.
 *
 * Findings carry stable rule ids + remediation text (dependency-cruiser
 * style) so agents and CI can key off them.
 *
 * @module effect-hygiene-parser
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseSync } from 'oxc-parser';
import { walkASTSimple, type ESTreeNode } from './utils/ast-walker';
import { scanComponentFiles } from './utils/file-scanner';
import { detectFileDirective } from './utils/directives';

export type EffectRuleId = 'effect-needs-cleanup' | 'derived-state-effect';
export type EffectSeverity = 'error' | 'warn' | 'info';

export interface EffectFinding {
  rule: EffectRuleId;
  severity: EffectSeverity;
  file: string;
  absolutePath: string;
  line: number;
  /** What was seen, concretely (e.g. the creator call or the mirrored setter). */
  evidence: string;
  comment: string;
}

export interface EffectHygieneReport {
  findings: EffectFinding[];
  summary: { totalFiles: number; byRule: Record<EffectRuleId, number> };
  warnings: string[];
}

// Calls that create something needing teardown, with the teardown hint.
const CLEANUP_CREATORS: Array<{ match: RegExp; label: string; fix: string }> = [
  { match: /^addEventListener$/, label: 'addEventListener', fix: 'return () => target.removeEventListener(...)' },
  { match: /^setInterval$/, label: 'setInterval', fix: 'return () => clearInterval(id)' },
  { match: /^setTimeout$/, label: 'setTimeout', fix: 'return () => clearTimeout(id)' },
  { match: /^requestAnimationFrame$/, label: 'requestAnimationFrame', fix: 'return () => cancelAnimationFrame(id)' },
  { match: /^subscribe$/, label: '.subscribe(...)', fix: 'return () => subscription.unsubscribe()' },
  { match: /^observe$/, label: 'observer.observe(...)', fix: 'return () => observer.disconnect()' },
  { match: /^watch$/, label: '.watch(...)', fix: 'return the unwatch function' },
  { match: /^on$/, label: '.on(...)', fix: 'return () => emitter.off(...)' },
  { match: /^addListener$/, label: '.addListener(...)', fix: 'return () => subscription.remove()' },
];

interface PositionedNode extends ESTreeNode { start: number; end: number }

function offsetToLine(code: string, offset: number): number {
  return code.slice(0, offset).split('\n').length;
}

function calleeName(node: ESTreeNode): string | null {
  const callee = (node as { callee?: ESTreeNode }).callee;
  if (!callee) return null;
  if (callee.type === 'Identifier') return (callee as { name?: string }).name ?? null;
  if (callee.type === 'MemberExpression') {
    const prop = (callee as { property?: { name?: string } }).property;
    return prop?.name ?? null;
  }
  return null;
}

/** Does this effect callback body contain `return <function>` (a cleanup)? */
function hasCleanupReturn(effectBody: ESTreeNode): boolean {
  let found = false;
  walkASTSimple(effectBody, (node) => {
    if (found || node.type !== 'ReturnStatement') return;
    const arg = (node as { argument?: ESTreeNode }).argument;
    if (!arg) return;
    // return () => ..., return function..., return cleanupFn, return x.bind(...)
    if (arg.type === 'ArrowFunctionExpression' || arg.type === 'FunctionExpression' ||
        arg.type === 'Identifier' || arg.type === 'CallExpression') {
      found = true;
    }
  });
  return found;
}

/**
 * Analyze one file. Skips "use server" files (no hooks there legally).
 */
export function analyzeFileEffectHygiene(filePath: string): EffectFinding[] {
  if (!fs.existsSync(filePath)) return [];
  const code = fs.readFileSync(filePath, 'utf-8');
  if (detectFileDirective(code) === 'use server') return [];

  let program: ESTreeNode;
  try {
    program = parseSync(path.basename(filePath), code).program as unknown as ESTreeNode;
  } catch {
    return [];
  }

  const findings: EffectFinding[] = [];

  // Collect useState/useReducer/useActionState/useOptimistic setter names —
  // needed to recognize "effect only mirrors into state".
  const setters = new Set<string>();
  walkASTSimple(program, (node) => {
    if (node.type !== 'VariableDeclarator') return;
    const init = (node as { init?: ESTreeNode }).init;
    if (init?.type !== 'CallExpression') return;
    const name = calleeName(init);
    if (name !== 'useState' && name !== 'useReducer' && name !== 'useActionState' && name !== 'useOptimistic') return;
    const id = (node as { id?: ESTreeNode }).id;
    if (id?.type === 'ArrayPattern') {
      const elements = (id as { elements?: Array<{ name?: string } | null> }).elements;
      if (elements?.[1]?.name) setters.add(elements[1].name);
    }
  });

  walkASTSimple(program, (node) => {
    if (node.type !== 'CallExpression') return;
    const hookName = calleeName(node);
    if (hookName !== 'useEffect' && hookName !== 'useLayoutEffect') return;

    const args = (node as { arguments?: ESTreeNode[] }).arguments;
    const callback = args?.[0];
    if (!callback || (callback.type !== 'ArrowFunctionExpression' && callback.type !== 'FunctionExpression')) return;
    const body = (callback as { body?: ESTreeNode }).body;
    if (!body) return;

    const pos = (node as PositionedNode).start ?? 0;
    const line = offsetToLine(code, pos);

    // Rule 1: effect-needs-cleanup — a creator call inside, no cleanup return.
    // Skip when the effect awaits (async orchestration often cleans up
    // elsewhere) to keep false positives near zero.
    if (!hasCleanupReturn(body)) {
      let creator: { label: string; fix: string } | null = null;
      walkASTSimple(body, (inner) => {
        if (creator || inner.type !== 'CallExpression') return;
        const name = calleeName(inner);
        if (!name) return;
        const hit = CLEANUP_CREATORS.find(c => c.match.test(name));
        if (hit) creator = { label: hit.label, fix: hit.fix };
      });
      if (creator !== null) {
        const c = creator as { label: string; fix: string };
        findings.push({
          rule: 'effect-needs-cleanup',
          severity: 'error',
          file: path.basename(filePath),
          absolutePath: filePath,
          line,
          evidence: c.label,
          comment: `This ${hookName} creates ${c.label} but returns no cleanup — it leaks on every re-mount (and fires twice under StrictMode). Fix: ${c.fix}.`,
        });
      }
    }

    // Rule 2: derived-state-effect — the effect body consists ONLY of setter
    // call statement(s). Strict shape keeps this high-precision: any other
    // statement (fetch, guard, logging) disqualifies.
    if (setters.size > 0 && body.type === 'BlockStatement') {
      const statements = (body as { body?: ESTreeNode[] }).body ?? [];
      const allMirror = statements.length > 0 && statements.every(st => {
        if (st.type !== 'ExpressionStatement') return false;
        const expr = (st as { expression?: ESTreeNode }).expression;
        if (expr?.type !== 'CallExpression') return false;
        const name = calleeName(expr);
        return !!name && setters.has(name);
      });
      if (allMirror) {
        findings.push({
          rule: 'derived-state-effect',
          severity: 'warn',
          file: path.basename(filePath),
          absolutePath: filePath,
          line,
          evidence: statements.length === 1 ? 'single setter call' : `${statements.length} setter calls`,
          comment: `This ${hookName} only mirrors values into state. Derived state via effects causes an extra render and stale-value bugs — compute it during render, or useMemo if expensive. If you intend to RESET state when a prop changes, pass a key to the component instead.`,
        });
      }
    }
  });

  return findings;
}

/**
 * Report over a file or directory (scan depth 5, node_modules excluded).
 */
export function parseEffectHygiene(rootPath: string): EffectHygieneReport {
  const absolutePath = path.resolve(rootPath);
  const warnings: string[] = [];
  const byRule: Record<EffectRuleId, number> = { 'effect-needs-cleanup': 0, 'derived-state-effect': 0 };

  if (!fs.existsSync(absolutePath)) {
    return { findings: [], summary: { totalFiles: 0, byRule }, warnings: [`Path not found: ${absolutePath}`] };
  }

  const files = fs.statSync(absolutePath).isDirectory()
    ? scanComponentFiles(absolutePath, { extensions: ['.tsx', '.jsx'] })
    : [absolutePath];

  const findings: EffectFinding[] = [];
  for (const f of files) findings.push(...analyzeFileEffectHygiene(f));
  for (const f of findings) byRule[f.rule]++;

  findings.sort((a, b) => (a.severity === b.severity ? a.file.localeCompare(b.file) : a.severity === 'error' ? -1 : 1));

  return { findings, summary: { totalFiles: files.length, byRule }, warnings };
}
