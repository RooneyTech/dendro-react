/**
 * Dendro Pro — Proprietary
 * Copyright (c) 2025 Rooney Industries LLC. All rights reserved.
 * Unauthorized copying, modification, or distribution is prohibited.
 */

import * as path from 'path';
import * as fs from 'fs';
import { assertPathInWorkspace } from '../path-boundary';
import {
  getContextMap,
  getComponentTree,
  getHookDeps,
  GetContextMapResult,
  GetComponentTreeResult,
  GetHookDepsResult,
} from '../tools';
import type {
  StateFlowHypothesis,
  GenerateHypothesesInput,
  GenerateHypothesesResult,
  GenerateHypothesesStats,
} from './verification-types';

// --- Internal Tree Node (matches tools.ts ComponentNode) ---

interface ComponentNode {
  file: string;
  type: 'functional' | 'class' | null;
  state: string[];
  directive?: 'use client' | 'use server' | null;
  children: ComponentNode[];
}

// --- Hypothesis ID Counter ---

let hypothesisCounter = 0;

function nextId(prefix: string): string {
  hypothesisCounter++;
  return `${prefix}-${hypothesisCounter}`;
}

// --- Context Hypotheses ---

/**
 * Generate hypotheses from context provider→consumer relationships.
 *
 * For each context, finds providers and consumers, then hypothesizes that
 * changes in the provider's value should propagate to all consumers.
 */
function generateContextHypotheses(contextMap: GetContextMapResult): StateFlowHypothesis[] {
  const hypotheses: StateFlowHypothesis[] = [];

  for (const ctx of contextMap.contexts) {
    // Find providers for this context
    const providers = contextMap.providers.filter(p => p.contextName === ctx.name);
    // Find consumers for this context
    const consumers = contextMap.consumers.filter(c => c.contextName === ctx.name);

    if (providers.length === 0 || consumers.length === 0) continue;

    // Find the custom hook for this context (if any) — gives us the action name
    const customHook = contextMap.customHooks.find(h => h.contextName === ctx.name);
    const hookName = customHook?.hookName || `useContext(${ctx.name})`;
    const exportedValues = customHook?.exportedValues || [];

    // Pick a representative provider
    const provider = providers[0];
    const providerComponent = provider.wrapperComponent || path.basename(provider.filePath, path.extname(provider.filePath));

    // Generate one hypothesis per consumer
    for (const consumer of consumers) {
      if (!consumer.componentName) continue; // Skip anonymous consumers

      // Determine an action name from exported values (e.g., "setUser", "login")
      const setterAction = exportedValues.find(v =>
        v.startsWith('set') || v.startsWith('update') || v.startsWith('toggle')
      ) || exportedValues[0] || 'updateValue';

      // Build a test value based on context name heuristics
      const testValue = inferTestValue(ctx.name, setterAction);

      hypotheses.push({
        id: nextId('ctx'),
        flowType: 'context',
        trigger: {
          component: providerComponent,
          file: provider.filePath,
          action: setterAction,
          payload: testValue.payload,
        },
        expectedPath: buildExpectedPath(providerComponent, consumer.componentName),
        expectation: {
          component: consumer.componentName,
          file: consumer.filePath,
          property: testValue.property,
          expectedValue: testValue.expectedValue,
        },
        confidence: calculateContextConfidence(ctx, provider, consumer, customHook !== undefined),
        reasoning: buildContextReasoning(ctx.name, providerComponent, consumer.componentName, customHook?.hookName),
      });
    }
  }

  return hypotheses;
}

/**
 * Calculate confidence for a context flow hypothesis.
 */
function calculateContextConfidence(
  ctx: { name: string; providerExported: boolean },
  _provider: { wrapperComponent?: string },
  consumer: { isCustomHook: boolean },
  hasCustomHook: boolean,
): number {
  let confidence = 0.7; // Base for context flows

  // Custom hook = cleaner API, higher confidence
  if (hasCustomHook) confidence += 0.1;

  // Consumer uses custom hook (vs raw useContext) = more reliable
  if (consumer.isCustomHook) confidence += 0.05;

  // Provider is exported = we can import it for test harness
  if (ctx.providerExported) confidence += 0.05;

  return Math.min(confidence, 1.0);
}

function buildContextReasoning(
  contextName: string,
  providerComponent: string,
  consumerComponent: string,
  hookName?: string,
): string {
  const via = hookName ? ` via ${hookName}()` : ' via useContext()';
  return `${contextName} value flows from ${providerComponent} to ${consumerComponent}${via}. ` +
    `Changing the context value in the provider should cause the consumer to re-render with the new value.`;
}

// --- Prop Hypotheses ---

/**
 * Generate hypotheses from prop-passing relationships in the component tree.
 *
 * Walks the tree looking for parent→child edges where the parent has state
 * variables that are likely passed as props to the child.
 */
function generatePropHypotheses(
  tree: GetComponentTreeResult,
  entryDir: string,
): StateFlowHypothesis[] {
  const hypotheses: StateFlowHypothesis[] = [];

  if (!tree.tree) return hypotheses;

  walkTreeForProps(tree.tree, null, entryDir, hypotheses);
  return hypotheses;
}

function walkTreeForProps(
  node: ComponentNode,
  parent: ComponentNode | null,
  entryDir: string,
  hypotheses: StateFlowHypothesis[],
): void {
  // If parent has state variables and this node is a child, hypothesize prop passing
  if (parent && parent.state.length > 0) {
    const parentName = componentNameFromFile(parent.file);
    const childName = componentNameFromFile(node.file);
    const parentFile = resolveToAbsolute(parent.file, entryDir);
    const childFile = resolveToAbsolute(node.file, entryDir);

    // For each state variable in parent, hypothesize it's passed to this child
    for (const stateVar of parent.state) {
      // Skip internal-looking state (e.g., "isLoading", "error", "mounted")
      if (isInternalState(stateVar)) continue;

      hypotheses.push({
        id: nextId('prop'),
        flowType: 'prop',
        trigger: {
          component: parentName,
          file: parentFile,
          action: stateVar,
          payload: inferPropTestValue(stateVar),
        },
        expectedPath: [parentName, childName],
        expectation: {
          component: childName,
          file: childFile,
          property: stateVar,
          expectedValue: inferPropTestValue(stateVar),
        },
        confidence: calculatePropConfidence(parent, node, stateVar),
        reasoning: `${parentName} has state variable "${stateVar}" and renders ${childName}. ` +
          `Hypothesizing that "${stateVar}" is passed as a prop to ${childName}.`,
      });
    }
  }

  // Recurse into children
  for (const child of node.children) {
    walkTreeForProps(child, node, entryDir, hypotheses);
  }
}

function calculatePropConfidence(
  parent: ComponentNode,
  _child: ComponentNode,
  _stateVar: string,
): number {
  let confidence = 0.6; // Base for inferred prop passing

  // Parent has only 1-2 children = higher chance each child gets the prop
  if (parent.children.length <= 2) confidence += 0.1;

  // Parent is functional = modern patterns, more predictable
  if (parent.type === 'functional') confidence += 0.05;

  return Math.min(confidence, 1.0);
}

// --- Hook State Hypotheses ---

/**
 * Generate hypotheses from hook state within individual components.
 *
 * For each component with useState, hypothesize that changing the state
 * (via its setter) should update the rendered output.
 */
function generateHookStateHypotheses(
  tree: GetComponentTreeResult,
  entryDir: string,
): StateFlowHypothesis[] {
  const hypotheses: StateFlowHypothesis[] = [];

  if (!tree.tree) return hypotheses;

  const leafComponents = collectLeafComponents(tree.tree, entryDir);

  for (const leaf of leafComponents) {
    // Get hook analysis for this component
    const hookResult = getHookDeps(leaf.file);
    if (hookResult.error || hookResult.stateVariables.length === 0) continue;

    const componentName = componentNameFromFile(leaf.name);

    for (const stateVar of hookResult.stateVariables) {
      if (isInternalState(stateVar)) continue;

      const setterName = `set${stateVar.charAt(0).toUpperCase()}${stateVar.slice(1)}`;

      hypotheses.push({
        id: nextId('hook'),
        flowType: 'hook-state',
        trigger: {
          component: componentName,
          file: leaf.file,
          action: setterName,
          payload: inferPropTestValue(stateVar),
        },
        expectedPath: [componentName],
        expectation: {
          component: componentName,
          file: leaf.file,
          property: stateVar,
          expectedValue: inferPropTestValue(stateVar),
        },
        confidence: calculateHookConfidence(hookResult),
        reasoning: `${componentName} uses useState for "${stateVar}". ` +
          `Calling ${setterName}() should update the rendered output.`,
      });
    }
  }

  return hypotheses;
}

function calculateHookConfidence(hookResult: GetHookDepsResult): number {
  let confidence = 0.55; // Base for hook state (lowest of the 3 types)

  // Fewer hooks = simpler component = higher confidence
  if (hookResult.totalHooks <= 3) confidence += 0.1;

  // No issues detected = cleaner component
  if (hookResult.issueCount === 0) confidence += 0.05;

  return Math.min(confidence, 1.0);
}

// --- Helpers ---

interface LeafComponent {
  name: string;
  file: string;
}

function collectLeafComponents(
  node: ComponentNode,
  entryDir: string,
): LeafComponent[] {
  const leaves: LeafComponent[] = [];

  function walk(n: ComponentNode): void {
    // A "leaf" or component with state is interesting for hook analysis
    if (n.state.length > 0) {
      leaves.push({
        name: n.file,
        file: resolveToAbsolute(n.file, entryDir),
      });
    }
    for (const child of n.children) {
      walk(child);
    }
  }

  walk(node);
  return leaves;
}

function componentNameFromFile(filePath: string): string {
  const base = path.basename(filePath, path.extname(filePath));
  // Handle index files: use parent directory name
  if (base === 'index') {
    return path.basename(path.dirname(filePath));
  }
  return base;
}

function resolveToAbsolute(file: string, entryDir: string): string {
  if (path.isAbsolute(file)) return file;
  return path.resolve(entryDir, file);
}

function buildExpectedPath(source: string, destination: string): string[] {
  // Simple path for now — just source and destination
  // Could be enhanced to trace through the tree in the future
  return [source, destination];
}

/**
 * Classify state variables that are likely internal (loading, error, etc.)
 * and not worth testing as prop/state flows.
 */
function isInternalState(stateVar: string): boolean {
  const internalPatterns = [
    'loading', 'isLoading', 'isFetching', 'isSubmitting',
    'error', 'hasError', 'isError',
    'mounted', 'isMounted',
    'ref', 'isOpen', 'isVisible', 'isExpanded',
  ];
  return internalPatterns.includes(stateVar);
}

/**
 * Infer a reasonable test value based on variable name heuristics.
 */
function inferTestValue(contextName: string, action: string): {
  payload: string;
  property: string;
  expectedValue: string;
} {
  const name = contextName.toLowerCase();

  if (name.includes('auth') || name.includes('user')) {
    return {
      payload: "{ id: 1, name: 'Test User', email: 'test@example.com' }",
      property: 'user.name',
      expectedValue: "'Test User'",
    };
  }

  if (name.includes('theme')) {
    return {
      payload: "'dark'",
      property: 'theme',
      expectedValue: "'dark'",
    };
  }

  if (name.includes('locale') || name.includes('i18n') || name.includes('lang')) {
    return {
      payload: "'es'",
      property: 'locale',
      expectedValue: "'es'",
    };
  }

  // Generic fallback
  return {
    payload: "'test-value'",
    property: action,
    expectedValue: "'test-value'",
  };
}

/**
 * Infer a test value for a prop based on its name.
 */
function inferPropTestValue(propName: string): string {
  const name = propName.toLowerCase();

  if (name.includes('name') || name.includes('title') || name.includes('label')) return "'Test Value'";
  if (name.includes('count') || name.includes('total') || name.includes('num')) return '42';
  if (name.includes('enabled') || name.includes('visible') || name.includes('active')) return 'true';
  if (name.includes('items') || name.includes('list') || name.includes('data')) return "[{ id: 1, name: 'Item 1' }]";
  if (name.includes('id')) return "'test-id-123'";
  if (name.includes('url') || name.includes('src') || name.includes('href')) return "'https://example.com'";
  if (name.includes('color')) return "'#ff0000'";

  return "'test-value'";
}

// --- Main Entry Point ---

/**
 * Generate state flow hypotheses from static analysis of a React application.
 *
 * Aggregates data from getContextMap, getComponentTree, and getHookDeps to
 * produce testable hypotheses about state flows.
 */
export function generateHypotheses(input: GenerateHypothesesInput): GenerateHypothesesResult {
  const { entryFile, maxHypotheses = 20, flowTypes = ['context', 'prop', 'hook-state'] } = input;

  // Reset counter for deterministic IDs within a single generation run
  hypothesisCounter = 0;

  const absoluteEntry = assertPathInWorkspace(entryFile, 'entryFile');
  const entryDir = path.dirname(absoluteEntry);

  const allHypotheses: StateFlowHypothesis[] = [];
  let contextsFound = 0;
  let propsTracked = 0;
  let hooksAnalyzed = 0;

  // 1. Context hypotheses
  if (flowTypes.includes('context')) {
    const contextMap = getContextMap(entryDir);
    if (!contextMap.error) {
      contextsFound = contextMap.totalContexts;
      const ctxHypotheses = generateContextHypotheses(contextMap);
      allHypotheses.push(...ctxHypotheses);
    }
  }

  // 2. Prop hypotheses (needs component tree)
  let tree: GetComponentTreeResult | null = null;
  if (flowTypes.includes('prop') || flowTypes.includes('hook-state')) {
    tree = getComponentTree(absoluteEntry);
  }

  if (flowTypes.includes('prop') && tree && !tree.error) {
    const propHypotheses = generatePropHypotheses(tree, entryDir);
    propsTracked = propHypotheses.length;
    allHypotheses.push(...propHypotheses);
  }

  // 3. Hook state hypotheses
  if (flowTypes.includes('hook-state') && tree && !tree.error) {
    const hookHypotheses = generateHookStateHypotheses(tree, entryDir);
    hooksAnalyzed = hookHypotheses.length;
    allHypotheses.push(...hookHypotheses);
  }

  // Sort by confidence (highest first) and cap at maxHypotheses
  allHypotheses.sort((a, b) => b.confidence - a.confidence);
  const hypotheses = allHypotheses.slice(0, maxHypotheses);

  // Calculate stats
  const stats: GenerateHypothesesStats = {
    contextsFound,
    propsTracked,
    hooksAnalyzed,
    hypothesesGenerated: hypotheses.length,
    highConfidence: hypotheses.filter(h => h.confidence >= 0.8).length,
    mediumConfidence: hypotheses.filter(h => h.confidence >= 0.6 && h.confidence < 0.8).length,
    lowConfidence: hypotheses.filter(h => h.confidence < 0.6).length,
  };

  return { hypotheses, stats };
}

function emptyStats(): GenerateHypothesesStats {
  return {
    contextsFound: 0,
    propsTracked: 0,
    hooksAnalyzed: 0,
    hypothesesGenerated: 0,
    highConfidence: 0,
    mediumConfidence: 0,
    lowConfidence: 0,
  };
}
