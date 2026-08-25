/**
 * Dendro Pro — Proprietary
 * Copyright (c) 2025 Rooney Industries LLC. All rights reserved.
 * Unauthorized copying, modification, or distribution is prohibited.
 */

import * as path from 'path';
import { readRuntimeState } from '../../runtime/runtime-state-file';
import type { RuntimeStateSnapshot, SerializedRuntimeComponent } from '../../runtime/types';
import {
  getContextMap,
  getPropFlow,
  getHookDeps,
  visualizeHighlight,
  visualizeTraceFlow,
  visualizeAnnotate,
  visualizeClear,
} from '../tools';
import type { PropFlowNode } from '../tools';
import { generateHypotheses } from './hypothesis-engine';
import { annotateTreeWithVerification } from './verification-annotator';
import type { FlowTestResult, VerificationSummary, StateFlowHypothesis } from './verification-types';

// --- Types ---

export type ChangeType = 'mount' | 'unmount' | 'rerender';

export interface ComponentChange {
  id: number;
  displayName: string;
  type: ChangeType;
  sourceFile: string | null;
}

export interface ProjectedFlow {
  trigger: string;
  triggerFile: string | null;
  changeType: ChangeType;
  flowType: 'context' | 'prop' | 'hook-state';
  affectedPath: string[];
  confidence: number;
  reasoning: string;
}

export interface TriggerProjectionInput {
  entryFile: string;
  componentName?: string;
  verify?: boolean;
}

export interface VerificationResult {
  hypothesesGenerated: number;
  summary: VerificationSummary | null;
  nodesAnnotated: number;
}

export interface TriggerProjectionResult {
  projections: ProjectedFlow[];
  changes: ComponentChange[];
  nodesHighlighted: number;
  flowsAnimated: number;
  summary: string;
  verification?: VerificationResult;
  error?: string;
}

// --- Snapshot Storage ---

let previousSnapshot: RuntimeStateSnapshot | null = null;

/**
 * Reset stored snapshot (for testing).
 */
export function resetSnapshot(): void {
  previousSnapshot = null;
}

// --- Tree Diffing ---

/**
 * Diff two runtime snapshots to find changed components.
 *
 * - New IDs → mount
 * - Missing IDs → unmount
 * - Same ID, different children → rerender
 */
export function diffSnapshots(
  previous: RuntimeStateSnapshot,
  current: RuntimeStateSnapshot,
): ComponentChange[] {
  const changes: ComponentChange[] = [];

  const prevMap = new Map<number, SerializedRuntimeComponent>();
  for (const el of previous.elements) {
    prevMap.set(el.id, el);
  }

  const currMap = new Map<number, SerializedRuntimeComponent>();
  for (const el of current.elements) {
    currMap.set(el.id, el);
  }

  // Mounts: in current but not previous
  for (const [id, el] of currMap) {
    if (!prevMap.has(id)) {
      changes.push({
        id,
        displayName: el.displayName,
        type: 'mount',
        sourceFile: current.sourceMap[el.displayName] || null,
      });
    }
  }

  // Unmounts: in previous but not current
  for (const [id, el] of prevMap) {
    if (!currMap.has(id)) {
      changes.push({
        id,
        displayName: el.displayName,
        type: 'unmount',
        sourceFile: previous.sourceMap[el.displayName] || null,
      });
    }
  }

  // Rerenders: same ID, different children
  for (const [id, currEl] of currMap) {
    const prevEl = prevMap.get(id);
    if (!prevEl) continue;

    const prevChildren = prevEl.children.join(',');
    const currChildren = currEl.children.join(',');
    if (prevChildren !== currChildren) {
      changes.push({
        id,
        displayName: currEl.displayName,
        type: 'rerender',
        sourceFile: current.sourceMap[currEl.displayName] || null,
      });
    }
  }

  return changes;
}

// --- Helpers ---

/**
 * Flatten a PropFlowNode tree into a list of component names.
 */
function flattenPropFlowNames(nodes: PropFlowNode[]): string[] {
  const names: string[] = [];
  for (const node of nodes) {
    names.push(node.component);
    if (node.children && node.children.length > 0) {
      names.push(...flattenPropFlowNames(node.children));
    }
  }
  return names;
}

// --- Static Analysis Projection ---

/**
 * Project downstream effects for a changed component using static analysis.
 *
 * Calls getContextMap, getPropFlow, and getHookDeps to predict which
 * components are affected by the change.
 */
function projectDownstreamForChange(
  change: ComponentChange,
  entryFile: string,
  contextResult: ReturnType<typeof getContextMap> | null,
  currentSnapshot: RuntimeStateSnapshot,
): ProjectedFlow[] {
  const flows: ProjectedFlow[] = [];
  const sourceFile = change.sourceFile;

  if (!sourceFile) return flows;

  // Get hook analysis once (shared by prop + hook-state detection)
  let hookResult: ReturnType<typeof getHookDeps> | null = null;
  try {
    hookResult = getHookDeps(sourceFile);
    if (hookResult.error) hookResult = null;
  } catch {
    // Hook analysis unavailable
  }

  // --- Context flow ---
  if (contextResult && !contextResult.error) {
    for (const provider of contextResult.providers) {
      const providerBaseName = path.basename(provider.filePath).replace(/\.(tsx?|jsx?)$/, '');
      if (providerBaseName === change.displayName || provider.filePath === sourceFile) {
        const consumers = contextResult.consumers.filter(
          c => c.contextName === provider.contextName
        );
        if (consumers.length > 0) {
          const consumerNames = consumers.map(
            c => c.componentName || path.basename(c.filePath).replace(/\.(tsx?|jsx?)$/, '')
          );
          flows.push({
            trigger: change.displayName,
            triggerFile: sourceFile,
            changeType: change.type,
            flowType: 'context',
            affectedPath: [change.displayName, ...consumerNames],
            confidence: 0.85,
            reasoning: `${change.displayName} provides ${provider.contextName} — ${consumers.length} consumer(s) will re-render`,
          });
        }
      }
    }
  }

  // --- Prop flow ---
  if (hookResult && hookResult.stateVariables.length > 0) {
    // Get runtime children of this component (non-host)
    const runtimeEl = currentSnapshot.elements.find(
      el => el.displayName === change.displayName
    );
    const childNames = runtimeEl
      ? runtimeEl.children
          .map(childId => currentSnapshot.elements.find(el => el.id === childId))
          .filter((el): el is SerializedRuntimeComponent => el != null && el.type !== 'host')
          .map(el => el.displayName)
      : [];

    if (childNames.length > 0) {
      // Try getPropFlow for first state variable to validate prop flow exists
      const firstStateVar = hookResult.stateVariables[0];
      let propFlowNames: string[] = [];
      let propConfidence = 0.5;

      try {
        const propResult = getPropFlow(sourceFile, firstStateVar);
        if (!propResult.error && propResult.totalComponentsTraced > 1) {
          propFlowNames = flattenPropFlowNames(propResult.flow);
          propConfidence = 0.7;
        }
      } catch {
        // getPropFlow failed, fall back to runtime children
      }

      // Use static analysis path if available, otherwise runtime children
      const affectedPath = propFlowNames.length > 1
        ? propFlowNames
        : [change.displayName, ...childNames];

      flows.push({
        trigger: change.displayName,
        triggerFile: sourceFile,
        changeType: change.type,
        flowType: 'prop',
        affectedPath,
        confidence: propConfidence,
        reasoning: `${hookResult.stateVariables.length} state variable(s) may flow to ${childNames.length} child component(s) as props`,
      });
    }
  }

  // --- Hook-state flow ---
  if (hookResult && hookResult.contextUsages.length > 0) {
    flows.push({
      trigger: change.displayName,
      triggerFile: sourceFile,
      changeType: change.type,
      flowType: 'hook-state',
      affectedPath: [change.displayName],
      confidence: 0.6,
      reasoning: `Uses ${hookResult.contextUsages.length} context value(s): ${hookResult.contextUsages.join(', ')}`,
    });
  }

  return flows;
}

// --- Main Entry Points ---

/**
 * Project data flow from runtime changes.
 *
 * Reads current runtime state, diffs against previous snapshot,
 * resolves changed components to source files, and predicts
 * downstream effects using static analysis.
 */
export function projectFromRuntime(
  input: TriggerProjectionInput,
): TriggerProjectionResult {
  const { entryFile, componentName, verify } = input;

  // Read current runtime state
  const currentSnapshot = readRuntimeState();

  if (!currentSnapshot || currentSnapshot.status === 'disconnected') {
    return {
      projections: [],
      changes: [],
      nodesHighlighted: 0,
      flowsAnimated: 0,
      summary: 'No running React app connected. Use get_runtime_status for instructions.',
      error: 'not_connected',
    };
  }

  // First call: capture baseline
  if (!previousSnapshot) {
    previousSnapshot = currentSnapshot;
    return {
      projections: [],
      changes: [],
      nodesHighlighted: 0,
      flowsAnimated: 0,
      summary: `Baseline snapshot captured: ${currentSnapshot.componentCount} components. Call again after a re-render to see projections.`,
    };
  }

  // Diff snapshots
  let changes = diffSnapshots(previousSnapshot, currentSnapshot);

  // Filter by componentName if specified
  if (componentName) {
    const searchLower = componentName.toLowerCase();
    changes = changes.filter(c =>
      c.displayName.toLowerCase().includes(searchLower)
    );
  }

  // Store current as previous for next call
  previousSnapshot = currentSnapshot;

  if (changes.length === 0) {
    return {
      projections: [],
      changes: [],
      nodesHighlighted: 0,
      flowsAnimated: 0,
      summary: 'No changes detected since last snapshot.',
    };
  }

  // Run context analysis once (shared across all changes)
  const rootPath = path.dirname(entryFile);
  let contextResult: ReturnType<typeof getContextMap> | null = null;
  try {
    contextResult = getContextMap(rootPath);
  } catch {
    // Context analysis unavailable
  }

  // Project downstream for each change (skip unmounts)
  const projections: ProjectedFlow[] = [];
  for (const change of changes) {
    if (change.type === 'unmount') continue;
    const flows = projectDownstreamForChange(change, entryFile, contextResult, currentSnapshot);
    projections.push(...flows);
  }

  // Animate the projection in the webview
  const { nodesHighlighted, flowsAnimated } = animateProjection(projections, changes);

  // Build summary
  const mountCount = changes.filter(c => c.type === 'mount').length;
  const unmountCount = changes.filter(c => c.type === 'unmount').length;
  const rerenderCount = changes.filter(c => c.type === 'rerender').length;
  const parts: string[] = [];
  if (mountCount > 0) parts.push(`${mountCount} mounted`);
  if (unmountCount > 0) parts.push(`${unmountCount} unmounted`);
  if (rerenderCount > 0) parts.push(`${rerenderCount} re-rendered`);

  const summary = `${changes.length} component(s) changed (${parts.join(', ')}). ` +
    `${projections.length} flow(s) projected. ` +
    `${nodesHighlighted} node(s) highlighted, ${flowsAnimated} flow(s) animated.`;

  // Optional: Run Verified Projection on changed components
  let verification: VerificationResult | undefined;
  if (verify && projections.length > 0) {
    try {
      verification = runVerificationOnChanges(entryFile, changes);
    } catch (err) {
      console.error('Triggered Projection: Verification failed:', err);
    }
  }

  return {
    projections,
    changes,
    nodesHighlighted,
    flowsAnimated,
    summary,
    verification,
  };
}

/**
 * Run Verified Projection on changed components.
 *
 * Generates hypotheses for the entry file, then annotates the tree
 * with verification results (using synthetic "untested" results since
 * we don't want to block on Jest execution during live projection).
 */
function runVerificationOnChanges(
  entryFile: string,
  changes: ComponentChange[],
): VerificationResult {
  // Generate hypotheses focused on changed components
  const changedNames = changes
    .filter(c => c.type !== 'unmount')
    .map(c => c.displayName);

  const hypothesesResult = generateHypotheses({ entryFile });

  if (hypothesesResult.error || hypothesesResult.hypotheses.length === 0) {
    return {
      hypothesesGenerated: 0,
      summary: null,
      nodesAnnotated: 0,
    };
  }

  // Filter hypotheses to those involving changed components
  const relevantHypotheses = hypothesesResult.hypotheses.filter(h =>
    changedNames.some(name =>
      h.trigger.component.toLowerCase().includes(name.toLowerCase()) ||
      h.expectation.component.toLowerCase().includes(name.toLowerCase())
    )
  );

  if (relevantHypotheses.length === 0) {
    return {
      hypothesesGenerated: hypothesesResult.hypotheses.length,
      summary: null,
      nodesAnnotated: 0,
    };
  }

  // Create synthetic "inconclusive" results — we don't run Jest live,
  // but we annotate the tree to show what SHOULD be verified
  const syntheticResults: FlowTestResult[] = relevantHypotheses.map(h => ({
    hypothesisId: h.id,
    status: 'inconclusive' as const,
    duration: 0,
    testFilePath: '',
    errorMessage: 'Not yet tested — run run_flow_tests to verify',
  }));

  const syntheticSummary: VerificationSummary = {
    total: syntheticResults.length,
    verified: 0,
    failed: 0,
    inconclusive: syntheticResults.length,
    untested: 0,
  };

  // Annotate the tree with verification status
  const annotationResult = annotateTreeWithVerification({
    entryFile,
    results: syntheticResults,
    hypotheses: relevantHypotheses,
  });

  return {
    hypothesesGenerated: relevantHypotheses.length,
    summary: syntheticSummary,
    nodesAnnotated: annotationResult.nodesHighlighted,
  };
}

/**
 * Animate a triggered projection in the webview.
 *
 * 1. Clear previous annotations
 * 2. Highlight trigger components (blue, pulsing)
 * 3. Highlight unmounts (red)
 * 4. Trace flow paths (colored by flow type)
 * 5. Annotate triggers with labels
 */
export function animateProjection(
  projections: ProjectedFlow[],
  changes: ComponentChange[],
): { nodesHighlighted: number; flowsAnimated: number } {
  // Step 1: Clear
  visualizeClear('all');

  let nodesHighlighted = 0;
  let flowsAnimated = 0;

  // Step 2: Highlight triggers (blue, pulsing)
  const triggerNames = [...new Set(
    changes.filter(c => c.type !== 'unmount').map(c => c.displayName)
  )];
  if (triggerNames.length > 0) {
    visualizeHighlight(triggerNames, 'blue', { pulse: true, label: 'trigger' });
    nodesHighlighted += triggerNames.length;
  }

  // Step 3: Highlight unmounts (red)
  const unmountNames = [...new Set(
    changes.filter(c => c.type === 'unmount').map(c => c.displayName)
  )];
  if (unmountNames.length > 0) {
    visualizeHighlight(unmountNames, 'red', { label: 'unmounted' });
    nodesHighlighted += unmountNames.length;
  }

  // Step 4: Trace flows (colored by type)
  const flowColors: Record<string, string> = {
    context: '#a855f7',      // purple
    prop: '#3b82f6',         // blue
    'hook-state': '#f59e0b', // amber
  };

  for (const flow of projections) {
    if (flow.affectedPath.length >= 2) {
      visualizeTraceFlow(flow.affectedPath, {
        label: `${flow.flowType}: ${flow.trigger}`,
        color: flowColors[flow.flowType] || '#3b82f6',
        animated: true,
        flowType: flow.flowType === 'hook-state' ? 'state' : flow.flowType,
      });
      flowsAnimated++;
    }
  }

  // Step 5: Annotate triggers
  for (const change of changes) {
    if (change.type === 'unmount') continue;
    const relatedFlows = projections.filter(p => p.trigger === change.displayName);
    const label = relatedFlows.length > 0
      ? `${change.type} → ${relatedFlows.length} flow(s)`
      : change.type;

    visualizeAnnotate(change.displayName, label, {
      position: 'right',
      style: 'badge',
      color: '#3b82f6',
    });
  }

  return { nodesHighlighted, flowsAnimated };
}
