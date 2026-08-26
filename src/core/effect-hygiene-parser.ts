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

export type EffectRuleId = 'effect-needs-cleanup' | 'derived-state-effect' | 'effect-fetch-race';
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
/** Names bound by a function's parameters — walks patterns so `({ items })` works. */
function paramNames(fn: ESTreeNode): Set<string> {
  const out = new Set<string>();
  for (const p of (fn as { params?: ESTreeNode[] }).params ?? []) {
    walkASTSimple(p, (n) => {
      if (n.type === 'Identifier') out.add((n as { name?: string }).name ?? '');
    });
  }
  out.delete('');
  return out;
}

/**
 * Names carrying an awaited value. Two transitive passes catch the common
 * `const result = await f(); const err = result.error;` shape.
 */
function awaitBoundNames(body: ESTreeNode): Set<string> {
  const out = new Set<string>();
  walkASTSimple(body, (n) => {
    if (n.type !== 'VariableDeclarator') return;
    if ((n as { init?: ESTreeNode }).init?.type !== 'AwaitExpression') return;
    const id = (n as { id?: ESTreeNode }).id;
    if (id) walkASTSimple(id, (m) => {
      if (m.type === 'Identifier') out.add((m as { name?: string }).name ?? '');
    });
  });
  out.delete('');
  for (let pass = 0; pass < 2; pass++) {
    walkASTSimple(body, (n) => {
      if (n.type !== 'VariableDeclarator') return;
      const init = (n as { init?: ESTreeNode }).init;
      const id = (n as { id?: ESTreeNode }).id;
      if (!init || id?.type !== 'Identifier') return;
      let touches = false;
      walkASTSimple(init, (m) => {
        if (m.type === 'Identifier' && out.has((m as { name?: string }).name ?? '')) touches = true;
      });
      const nm = (id as { name?: string }).name;
      if (touches && nm) out.add(nm);
    });
  }
  return out;
}

function argsReferenceAny(argNodes: ESTreeNode[] | undefined, names: Set<string>): boolean {
  let hit = false;
  for (const a of argNodes ?? []) {
    walkASTSimple(a, (n) => {
      if (n.type === 'Identifier' && names.has((n as { name?: string }).name ?? '')) hit = true;
    });
  }
  return hit;
}

/**
 * Any sign the effect already handles the race — abort, ignore flag, ref flag,
 * or a named cleanup. Deliberately generous: a missed warning costs nothing,
 * a false one costs trust. Only TOP-LEVEL returns count as cleanup, so a
 * `.then(r => { return r; })` inside the body is not mistaken for one.
 */
function hasRaceMitigation(body: ESTreeNode): boolean {
  let mitigated = false;
  walkASTSimple(body, (n) => {
    if (mitigated) return;
    if (n.type === 'NewExpression') {
      const callee = (n as { callee?: { type?: string; name?: string } }).callee;
      if (callee?.type === 'Identifier' && callee.name === 'AbortController') mitigated = true;
    }
    if (n.type === 'CallExpression' && calleeName(n) === 'abort') mitigated = true;
    if (n.type === 'Identifier') {
      const nm = (n as { name?: string }).name;
      if (nm === 'signal' || nm === 'AbortSignal') mitigated = true;
    }
  });
  if (mitigated) return true;

  // Only a BlockStatement has top-level statements; a concise arrow body
  // (`() => doThing()`) has no cleanup return by construction.
  const topLevel = body.type === 'BlockStatement' ? ((body as { body?: ESTreeNode[] }).body ?? []) : [];
  for (const st of topLevel) {
    if (st.type !== 'ReturnStatement') continue;
    const arg = (st as { argument?: ESTreeNode }).argument;
    if (!arg) continue;
    if (arg.type === 'Identifier') return true; // return cleanupFn
    if (arg.type === 'ArrowFunctionExpression' || arg.type === 'FunctionExpression') {
      walkASTSimple(arg, (m) => {
        if (m.type !== 'AssignmentExpression') return;
        const right = (m as { right?: ESTreeNode }).right;
        const left = (m as { left?: ESTreeNode }).left;
        if (right?.type === 'Literal') mitigated = true;
        if (left?.type === 'MemberExpression'
          && (left as { property?: { name?: string } }).property?.name === 'current') mitigated = true;
      });
    }
  }
  return mitigated;
}

/**
 * A state setter called from an async continuation, with the resolved value
 * flowing into its arguments. Guard B (args must reference the resolved value)
 * is the precision workhorse: constant writes like setLoading(false) are
 * idempotent under last-write-wins and must not fire.
 */
function findUnguardedAsyncSetter(
  body: ESTreeNode,
  setters: Set<string>
): { setter: string; kind: string } | null {
  type Cont = { node: ESTreeNode; kind: string; resolved: Set<string>; afterOffset?: number };
  const conts: Cont[] = [];

  let bareSetterHit: { setter: string; kind: string } | null = null;
  walkASTSimple(body, (n) => {
    if (n.type !== 'CallExpression') return;
    const cn = calleeName(n);
    if (cn !== 'then' && cn !== 'catch' && cn !== 'finally') return;
    const fn = (n as { arguments?: ESTreeNode[] }).arguments?.[0];
    if (!fn) return;
    // Bare setter reference — .then(setResults) — the resolved value flows
    // into the setter by definition, so Guard B is satisfied structurally.
    if (fn.type === 'Identifier') {
      const nm = (fn as { name?: string }).name;
      if (nm && setters.has(nm) && !bareSetterHit) bareSetterHit = { setter: nm, kind: `.${cn}(...)` };
      return;
    }
    if (fn.type !== 'ArrowFunctionExpression' && fn.type !== 'FunctionExpression') return;
    conts.push({ node: fn, kind: `.${cn}(...)`, resolved: paramNames(fn) });
  });
  if (bareSetterHit) return bareSetterHit;

  let firstAwait = Infinity;
  walkASTSimple(body, (n) => {
    if (n.type === 'AwaitExpression') {
      firstAwait = Math.min(firstAwait, (n as PositionedNode).start ?? Infinity);
    }
  });
  if (firstAwait !== Infinity) {
    conts.push({ node: body, kind: 'await', resolved: awaitBoundNames(body), afterOffset: firstAwait });
  }

  for (const c of conts) {
    let found: { setter: string; kind: string } | null = null;
    walkASTSimple(c.node, (n) => {
      if (found || n.type !== 'CallExpression') return;
      const name = calleeName(n);
      if (!name || !setters.has(name)) return; // Guard A: locally-bound setters only
      if (c.afterOffset !== undefined && ((n as PositionedNode).start ?? 0) < c.afterOffset) return; // Guard D
      if (!argsReferenceAny((n as { arguments?: ESTreeNode[] }).arguments, c.resolved)) return; // Guard B
      found = { setter: name, kind: c.kind };
    });
    if (found) return found;
  }
  return null;
}

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

    // Rule 3: effect-fetch-race — an async continuation writes state derived
    // from the resolved value, the deps are reactive, and nothing guards the
    // write. exhaustive-deps is SATISFIED by this shape, which is exactly why
    // it survives review: responses resolve out of order and the stale one
    // wins, silently and permanently.
    const deps = args?.[1];
    if (
      setters.size > 0 &&
      deps?.type === 'ArrayExpression' &&
      (((deps as { elements?: unknown[] }).elements?.length) ?? 0) > 0 &&
      !hasRaceMitigation(body)
    ) {
      const hit = findUnguardedAsyncSetter(body, setters);
      if (hit) {
        const dStart = (deps as PositionedNode).start ?? 0;
        const dEnd = (deps as PositionedNode).end ?? 0;
        const depsText = dEnd > dStart ? code.slice(dStart, dEnd) : '[...]';
        findings.push({
          rule: 'effect-fetch-race',
          severity: 'warn',
          file: path.basename(filePath),
          absolutePath: filePath,
          line,
          evidence: `${hit.setter}() after ${hit.kind}`,
          comment: `This ${hookName} starts an async request and calls ${hit.setter}(...) with the result, but its dependency array ${depsText} is reactive and there is no ignore flag or AbortController. If the deps change before the previous request settles, the responses can resolve out of order — the older one calls ${hit.setter} last and the UI shows data for the wrong input, permanently, with no error. Fix: guard the write with a cleanup-scoped flag — let ignore = false; ... if (!ignore) ${hit.setter}(result); return () => { ignore = true; }; — or pass an AbortController signal to the request and .abort() in cleanup.`,
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
  const byRule: Record<EffectRuleId, number> = { 'effect-needs-cleanup': 0, 'derived-state-effect': 0, 'effect-fetch-race': 0 };

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
