/**
 * Effect Hygiene Parser
 *
 * Reports React effect patterns (clean-room implementations of well-known
 * rule concepts; no third-party code). Findings are scoped review signals:
 *
 * 1. effect-needs-cleanup — a useEffect creates a subscription, listener,
 *    timer, observer, or animation frame and returns no cleanup function.
 *    Resource lifetime needs source review; a one-shot timer is not proof of
 *    a persistent leak, and tests may deliberately exercise teardown.
 *
 * 2. derived-state-effect — an informational hint for an effect whose body
 *    consists only of state-update calls. Editable drafts, resets and external
 *    store synchronization can intentionally use this shape.
 *
 * 3. effect-fetch-race — an async continuation writes response-derived state
 *    with reactive dependencies and no recognized race mitigation.
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
  { match: /^addListener$/, label: '.addListener(...)', fix: 'return the API-provided unsubscribe function, or remove the returned subscription as that API requires' },
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

/**
 * Is this expression plausibly a cleanup function? Subscribe-style APIs
 * (addListener/subscribe/on) return an unsubscribe function; TIMER creators
 * return a numeric id, which is NOT cleanup and must stay flagged.
 */
function isCleanupLikeExpression(node: ESTreeNode): boolean {
  let n = node;
  if (n.type === 'ChainExpression') n = (n as { expression?: ESTreeNode }).expression ?? n;
  if (n.type === 'Identifier' || n.type === 'MemberExpression') return true;
  if (n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression') return true;
  if (n.type === 'CallExpression') {
    const name = calleeName(n);
    return !(name && /^(setTimeout|setInterval|requestAnimationFrame)$/.test(name));
  }
  return false;
}

/** Does this effect callback body return a cleanup? */
function hasCleanupReturn(effectBody: ESTreeNode): boolean {
  // Concise arrow body: `useEffect(() => nav.addListener(...), [deps])`
  // implicitly returns the expression — that IS the cleanup for subscribe-style
  // APIs. Missing this flagged react-navigation's own idiomatic unsubscribe as
  // a leak (false positive found 2026-08-31, and it was the cohort's flagship
  // "real bug" — the demo video would have shipped a wrong claim).
  if (effectBody.type !== 'BlockStatement') {
    return isCleanupLikeExpression(effectBody);
  }
  let found = false;
  walkASTSimple(effectBody, (node) => {
    if (found || node.type !== 'ReturnStatement') return;
    const arg = (node as { argument?: ESTreeNode }).argument;
    if (!arg) return;
    // Explicit `return <cleanup>`, including optional-chained calls
    // (`return sub?.unsubscribe?.()`), which OXC reports as ChainExpression.
    if (isCleanupLikeExpression(arg)) {
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
/**
 * Self-limiting effect: the body is guarded by a test on the very state the
 * async continuation sets — `if (csrfToken === undefined) { fetch().then(d => setCsrfToken(d)) }`.
 * Once it lands, the condition is false and the effect stops firing, so
 * concurrent requests converge on the same value. Real pattern, no real
 * consequence. Found in plane (5 occurrences) during the 2026-09-01 corpus scan.
 */
function isSelfLimiting(body: ESTreeNode, setter: string): boolean {
  // Derive the state name from the setter: setCsrfToken -> csrfToken
  if (!/^set[A-Z]/.test(setter)) return false;
  const stateName = setter.charAt(3).toLowerCase() + setter.slice(4);
  let guarded = false;
  walkASTSimple(body, (n) => {
    if (guarded || n.type !== 'IfStatement') return;
    const test = (n as { test?: ESTreeNode }).test;
    if (!test) return;
    let mentionsState = false;
    walkASTSimple(test, (m) => {
      if (m.type === 'Identifier' && (m as { name?: string }).name === stateName) mentionsState = true;
    });
    if (mentionsState) guarded = true;
  });
  return guarded;
}

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
      if (isSelfLimiting(body, name)) return; // Guard E: converges, cannot corrupt
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
          severity: 'warn',
          file: path.basename(filePath),
          absolutePath: filePath,
          line,
          evidence: c.label,
          comment: `This ${hookName} creates ${c.label}, but no effect cleanup return was detected. Check the resource lifetime before changing code: one-shot timers/frames can run after dependency changes or unmount, but are not proof of a persistent leak; tests may intentionally exercise unsubscribe behavior. If effect cleanup is needed, use the API's teardown contract: ${c.fix}.`,
        });
      }
    }

    // Rule 2: derived-state-effect — the effect body consists ONLY of setter
    // call statement(s). This establishes syntax, not intent: editable drafts,
    // resets and external-store synchronization can legitimately use this shape.
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
          severity: 'info',
          file: path.basename(filePath),
          absolutePath: filePath,
          line,
          evidence: statements.length === 1 ? 'single setter call' : `${statements.length} setter calls`,
          comment: `The body of this ${hookName} consists only of state-update calls. This is an informational review hint, not a detected bug: editable drafts, resets and external-store synchronization may intentionally use this pattern. Inspect how the state is read and updated elsewhere. Consider deriving a value during render only if it has no independent state or synchronization role.`,
        });
      }
    }

    // Rule 3: effect-fetch-race — an async continuation writes state derived
    // from the resolved value, the deps are reactive, and nothing guards the
    // write. exhaustive-deps is SATISFIED by this shape, which is exactly why
    // it survives review: responses resolve out of order and the stale one
    // can overwrite newer state. Findings still require lifetime review.
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
          comment: `This ${hookName} starts an async request and calls ${hit.setter}(...) with the result, but its dependency array ${depsText} is reactive and there is no ignore flag or AbortController. If the deps change before the previous request settles, the responses can resolve out of order — an older result can call ${hit.setter} last and overwrite newer state. Verify the request and state lifetime before applying a fix. One mitigation: guard every response-dependent state, DOM and ref write with a cleanup-scoped flag — let ignore = false; ... if (!ignore) ${hit.setter}(result); return () => { ignore = true; }; — or pass an AbortController signal to the request and .abort() in cleanup.`,
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

  const severityRank: Record<EffectSeverity, number> = { error: 0, warn: 1, info: 2 };
  findings.sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || a.file.localeCompare(b.file));

  return { findings, summary: { totalFiles: files.length, byRule }, warnings };
}
