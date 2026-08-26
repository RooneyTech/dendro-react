/**
 * Dendro Pro — Proprietary
 * Copyright (c) 2025 Rooney Industries LLC. All rights reserved.
 * Unauthorized copying, modification, or distribution is prohibited.
 */

import { readRuntimeState } from '../../runtime/runtime-state-file';
import {
  writeInspectRequest,
  pollInspectResult,
  clearInspectResult,
  writeOverrideRequest,
  pollOverrideResult,
  clearOverrideResult,
  generateRequestId,
} from '../../runtime/inspect-bridge';
import type { InspectResult, OverrideResult } from '../../runtime/inspect-bridge';
import type { SerializedRuntimeComponent } from '../../runtime/types';
import {
  getHookDeps,
  getPropFlow,
  getNavigationStructure,
  visualizeClear,
  visualizeHighlight,
  visualizeTraceFlow,
  visualizeAnnotate,
} from '../tools';
import type { PropFlowNode } from '../tools';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InspectLiveComponentResult {
  componentName: string;
  runtimeId: number;
  sourceFile: string | null;
  props: Record<string, unknown>;
  state: Record<string, unknown> | null;
  hooks: Array<{ id: number; name: string; value: unknown; subHooks: unknown[] }> | null;
  context: Record<string, unknown> | null;
  parent: { id: number; displayName: string } | null;
  childCount: number;
  inspectedAt: number;
}

export interface StateDiff {
  field: string;
  location: 'props' | 'state' | 'hooks' | 'context';
  previous: unknown;
  current: unknown;
  changeType: 'added' | 'removed' | 'modified';
}

export interface DiffComponentStateResult {
  componentName: string;
  runtimeId: number;
  hasPreviousInspection: boolean;
  diffs: StateDiff[];
  previousInspectedAt: number | null;
  currentInspectedAt: number;
  summary: string;
}

export interface StateOwnerMatch {
  componentName: string;
  sourceFile: string | null;
  runtimeId: number | null;
  isMounted: boolean;
  stateVariables: string[];
  matchedVariable: string;
  confidence: number;
  source: 'static-analysis' | 'runtime-tree';
}

export interface FindStateOwnerResult {
  query: string;
  matches: StateOwnerMatch[];
  totalComponentsSearched: number;
  summary: string;
}

// ---------------------------------------------------------------------------
// Module state — previous inspection cache for diff tool
// ---------------------------------------------------------------------------

const previousInspections = new Map<string, InspectResult>();

/** Reset the inspection cache (for testing). */
export function resetInspectionCache(): void {
  previousInspections.clear();
}

// ---------------------------------------------------------------------------
// Tool 1: inspect_live_component
// ---------------------------------------------------------------------------

export async function inspectLiveComponent(
  componentName: string
): Promise<InspectLiveComponentResult | { error: string; message: string }> {
  // Read runtime state
  const state = readRuntimeState();
  if (!state || state.status === 'disconnected') {
    return {
      error: 'not_connected',
      message: 'No running React Native app is connected. Use get_runtime_status for instructions.',
    };
  }

  // Find component by name (case-insensitive, partial match)
  const searchLower = componentName.toLowerCase();
  const matches = state.elements.filter(
    (el) => el.displayName.toLowerCase().includes(searchLower) && el.type !== 'other' && el.type !== 'host'
  );

  if (matches.length === 0) {
    return {
      error: 'component_not_found',
      message: `No component matching "${componentName}" found in the live runtime tree (${state.componentCount} total components). Host components ("View", "Text") are excluded — use the exact display name.`,
    };
  }

  // Pick the best match: exact match first, then shortest name, then first
  const target = pickBestMatch(matches, searchLower);

  // Build element lookup for parent info
  const elementMap = new Map<number, SerializedRuntimeComponent>();
  for (const el of state.elements) {
    elementMap.set(el.id, el);
  }

  // Write inspect request and poll for result
  const requestId = generateRequestId();
  clearInspectResult();
  writeInspectRequest({
    requestId,
    elementId: target.id,
    componentName: target.displayName,
    timestamp: Date.now(),
  });

  const result = await pollInspectResult(requestId, 6000);

  if (!result || !result.success) {
    return {
      error: 'inspect_timeout',
      message: `Inspection of "${target.displayName}" (id: ${target.id}) timed out. The extension may not be watching for inspect requests, or the app may have disconnected. Ensure VS Code is running with the Dendro extension active.`,
    };
  }

  // Cache for diff tool
  previousInspections.set(target.displayName, result);

  const parent = target.parentId !== null ? elementMap.get(target.parentId) : null;

  return {
    componentName: target.displayName,
    runtimeId: target.id,
    sourceFile: state.sourceMap[target.displayName] || null,
    props: result.props,
    state: result.state,
    hooks: result.hooks,
    context: result.context,
    parent: parent ? { id: parent.id, displayName: parent.displayName } : null,
    childCount: target.children.length,
    inspectedAt: result.timestamp,
  };
}

// ---------------------------------------------------------------------------
// Tool 2: diff_component_state
// ---------------------------------------------------------------------------

export async function diffComponentState(
  componentName: string
): Promise<DiffComponentStateResult | { error: string; message: string }> {
  // Read runtime state
  const state = readRuntimeState();
  if (!state || state.status === 'disconnected') {
    return {
      error: 'not_connected',
      message: 'No running React Native app is connected. Use get_runtime_status for instructions.',
    };
  }

  // Find component
  const searchLower = componentName.toLowerCase();
  const matches = state.elements.filter(
    (el) => el.displayName.toLowerCase().includes(searchLower) && el.type !== 'other' && el.type !== 'host'
  );

  if (matches.length === 0) {
    return {
      error: 'component_not_found',
      message: `No component matching "${componentName}" found in the live runtime tree.`,
    };
  }

  const target = pickBestMatch(matches, searchLower);

  // Get previous inspection if any
  const previousResult = previousInspections.get(target.displayName) || null;

  // Perform fresh inspection
  const requestId = generateRequestId();
  clearInspectResult();
  writeInspectRequest({
    requestId,
    elementId: target.id,
    componentName: target.displayName,
    timestamp: Date.now(),
  });

  const currentResult = await pollInspectResult(requestId, 6000);

  if (!currentResult || !currentResult.success) {
    return {
      error: 'inspect_timeout',
      message: `Inspection of "${target.displayName}" timed out. Ensure VS Code and Dendro extension are active.`,
    };
  }

  // Cache for next diff
  previousInspections.set(target.displayName, currentResult);

  if (!previousResult) {
    return {
      componentName: target.displayName,
      runtimeId: target.id,
      hasPreviousInspection: false,
      diffs: [],
      previousInspectedAt: null,
      currentInspectedAt: currentResult.timestamp,
      summary: `First inspection of "${target.displayName}" — no previous state to diff. Call again after a state change to see diffs.`,
    };
  }

  // Compute diffs
  const diffs: StateDiff[] = [];

  diffObjects(previousResult.props, currentResult.props, 'props', diffs);
  diffObjects(previousResult.state || {}, currentResult.state || {}, 'state', diffs);
  diffObjects(previousResult.context || {}, currentResult.context || {}, 'context', diffs);
  diffHooks(previousResult.hooks || [], currentResult.hooks || [], diffs);

  const summary = diffs.length === 0
    ? `No state changes detected in "${target.displayName}" since last inspection (${formatTimeDelta(previousResult.timestamp, currentResult.timestamp)} ago).`
    : `${diffs.length} change(s) detected in "${target.displayName}": ${diffs.map(d => `${d.location}.${d.field} (${d.changeType})`).join(', ')}`;

  return {
    componentName: target.displayName,
    runtimeId: target.id,
    hasPreviousInspection: true,
    diffs,
    previousInspectedAt: previousResult.timestamp,
    currentInspectedAt: currentResult.timestamp,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Tool 3: find_state_owner
// ---------------------------------------------------------------------------

export function findStateOwner(
  stateName: string,
  entryFile?: string
): FindStateOwnerResult {
  const matches: StateOwnerMatch[] = [];

  // Read runtime state for mounted component list
  const runtimeState = readRuntimeState();
  const mountedComponents = new Set<string>();
  const runtimeIdMap = new Map<string, number>();

  if (runtimeState && runtimeState.status === 'connected') {
    for (const el of runtimeState.elements) {
      if (el.type !== 'other' && el.type !== 'host') {
        mountedComponents.add(el.displayName);
        runtimeIdMap.set(el.displayName, el.id);
      }
    }
  }

  // Strategy 1: Use static analysis (getHookDeps) on source-mapped components
  const sourceMap = runtimeState?.sourceMap || {};
  const searchedFiles = new Set<string>();
  const searchLower = stateName.toLowerCase();

  for (const [displayName, filePath] of Object.entries(sourceMap)) {
    if (searchedFiles.has(filePath)) continue;
    searchedFiles.add(filePath);

    try {
      const hookResult = getHookDeps(filePath);
      if (hookResult.error) continue;

      // Check if any stateVariable name matches the query
      const matchedVars = hookResult.stateVariables.filter(
        (v) => v.toLowerCase().includes(searchLower)
      );

      if (matchedVars.length > 0) {
        const componentName = hookResult.component || displayName;
        matches.push({
          componentName,
          sourceFile: filePath,
          runtimeId: runtimeIdMap.get(componentName) ?? null,
          isMounted: mountedComponents.has(componentName),
          stateVariables: hookResult.stateVariables,
          matchedVariable: matchedVars[0],
          confidence: matchedVars.some((v) => v.toLowerCase() === searchLower) ? 0.95 : 0.7,
          source: 'static-analysis',
        });
      }
    } catch {
      // Skip files that fail to parse
    }
  }

  // Strategy 2: If entryFile provided and no matches yet, scan from entry
  if (entryFile && matches.length === 0) {
    try {
      const hookResult = getHookDeps(entryFile);
      if (!hookResult.error) {
        const matchedVars = hookResult.stateVariables.filter(
          (v) => v.toLowerCase().includes(searchLower)
        );
        if (matchedVars.length > 0) {
          matches.push({
            componentName: hookResult.component || 'Unknown',
            sourceFile: entryFile,
            runtimeId: null,
            isMounted: false,
            stateVariables: hookResult.stateVariables,
            matchedVariable: matchedVars[0],
            confidence: 0.6,
            source: 'static-analysis',
          });
        }
      }
    } catch {
      // Skip
    }
  }

  // Sort by confidence (highest first), then by mounted status
  matches.sort((a, b) => {
    if (a.isMounted !== b.isMounted) return a.isMounted ? -1 : 1;
    return b.confidence - a.confidence;
  });

  const summary = matches.length === 0
    ? `No component found with state variable matching "${stateName}". ${searchedFiles.size} source files were analyzed via static analysis.`
    : `Found ${matches.length} component(s) with state matching "${stateName}": ${matches.map(m => `${m.componentName} (${m.matchedVariable}, ${m.isMounted ? 'mounted' : 'not mounted'})`).join(', ')}`;

  return {
    query: stateName,
    matches,
    totalComponentsSearched: searchedFiles.size,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Types for state modification tools
// ---------------------------------------------------------------------------

export interface ModifyRuntimeStateResult {
  componentName: string;
  runtimeId: number;
  type: 'props' | 'state' | 'hooks' | 'context';
  path: string[];
  value: unknown;
  success: boolean;
  error?: string;
  newState?: InspectLiveComponentResult;
}

export interface PokeComponentResult {
  componentName: string;
  runtimeId: number;
  stateName: string;
  value: unknown;
  success: boolean;
  hookID?: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Tool 4: modify_runtime_state
// ---------------------------------------------------------------------------

export async function modifyRuntimeState(
  componentName: string,
  type: 'props' | 'state' | 'hooks' | 'context',
  path: string[],
  value: unknown,
  hookID?: number
): Promise<ModifyRuntimeStateResult | { error: string; message: string }> {
  // Read runtime state
  const state = readRuntimeState();
  if (!state || state.status === 'disconnected') {
    return {
      error: 'not_connected',
      message: 'No running React Native app is connected. Use get_runtime_status for instructions.',
    };
  }

  // Find component by name
  const searchLower = componentName.toLowerCase();
  const matches = state.elements.filter(
    (el) => el.displayName.toLowerCase().includes(searchLower) && el.type !== 'other' && el.type !== 'host'
  );

  if (matches.length === 0) {
    return {
      error: 'component_not_found',
      message: `No component matching "${componentName}" found in the live runtime tree (${state.componentCount} total components).`,
    };
  }

  const target = pickBestMatch(matches, searchLower);

  // Write override request and poll for result
  const requestId = generateRequestId();
  clearOverrideResult();
  writeOverrideRequest({
    requestId,
    elementId: target.id,
    componentName: target.displayName,
    type,
    path,
    value,
    hookID,
    timestamp: Date.now(),
  });

  const result = await pollOverrideResult(requestId, 6000);

  if (!result) {
    return {
      error: 'override_timeout',
      message: `Override for "${target.displayName}" timed out. The extension may not be watching for override requests, or the app may have disconnected.`,
    };
  }

  if (!result.success) {
    return {
      componentName: target.displayName,
      runtimeId: target.id,
      type,
      path,
      value,
      success: false,
      error: result.error || 'Override failed',
    };
  }

  return {
    componentName: target.displayName,
    runtimeId: target.id,
    type,
    path,
    value,
    success: true,
  };
}

// ---------------------------------------------------------------------------
// Tool 5: poke_component
// ---------------------------------------------------------------------------

export async function pokeComponent(
  componentName: string,
  stateName: string,
  value: unknown
): Promise<PokeComponentResult | { error: string; message: string }> {
  // Read runtime state
  const state = readRuntimeState();
  if (!state || state.status === 'disconnected') {
    return {
      error: 'not_connected',
      message: 'No running React Native app is connected. Use get_runtime_status for instructions.',
    };
  }

  // Find component
  const searchLower = componentName.toLowerCase();
  const matches = state.elements.filter(
    (el) => el.displayName.toLowerCase().includes(searchLower) && el.type !== 'other' && el.type !== 'host'
  );

  if (matches.length === 0) {
    return {
      error: 'component_not_found',
      message: `No component matching "${componentName}" found in the live runtime tree.`,
    };
  }

  const target = pickBestMatch(matches, searchLower);

  // First, inspect the component to find the hook ID for the state variable
  const inspectRequestId = generateRequestId();
  clearInspectResult();
  writeInspectRequest({
    requestId: inspectRequestId,
    elementId: target.id,
    componentName: target.displayName,
    timestamp: Date.now(),
  });

  const inspectResult = await pollInspectResult(inspectRequestId, 6000);

  if (!inspectResult || !inspectResult.success) {
    return {
      error: 'inspect_timeout',
      message: `Could not inspect "${target.displayName}" to locate state variable "${stateName}". The extension may not be active.`,
    };
  }

  // Try to find the state variable in hooks
  const stateNameLower = stateName.toLowerCase();
  let hookID: number | undefined;
  let targetPath: string[] = [stateName];
  let overrideType: 'hooks' | 'state' | 'props' = 'hooks';

  if (inspectResult.hooks) {
    // Look for useState hooks whose name matches the state variable
    for (const hook of inspectResult.hooks) {
      if (hook.name === 'State' || hook.name === 'useState') {
        // Check if any subHook or the hook value itself relates to stateName
        // useState hooks are identified by their hookID
        // The value is the current state; path would typically be empty for primitive overrides
        // For useState, the convention is hookID + empty path for the whole value
        if (typeof hook.value === 'object' && hook.value !== null) {
          const hookObj = hook.value as Record<string, unknown>;
          if (stateNameLower in Object.fromEntries(
            Object.keys(hookObj).map(k => [k.toLowerCase(), k])
          )) {
            // State is an object with the named field
            const actualKey = Object.keys(hookObj).find(k => k.toLowerCase() === stateNameLower);
            if (actualKey) {
              hookID = hook.id;
              targetPath = [actualKey];
              overrideType = 'hooks';
              break;
            }
          }
        }
      }
    }

    // If we didn't match inside an object state, try matching hook index by position
    // Convention: first useState → hookID 0, second → hookID 1, etc.
    if (hookID === undefined) {
      const stateHooks = inspectResult.hooks.filter(
        h => h.name === 'State' || h.name === 'useState'
      );
      for (let i = 0; i < stateHooks.length; i++) {
        // Check if the hook's subHooks have a matching name, or if we can match by variable name
        // In practice, React DevTools doesn't expose variable names for hooks,
        // so we try to match by checking state in the inspected component
        hookID = stateHooks[i].id;
        targetPath = [];
        overrideType = 'hooks';
        // Use the first useState hook if there's only one
        if (stateHooks.length === 1) break;
      }
    }
  }

  // Fallback: try as a plain state field (class components)
  if (hookID === undefined && inspectResult.state) {
    const stateObj = inspectResult.state as Record<string, unknown>;
    const actualKey = Object.keys(stateObj).find(k => k.toLowerCase() === stateNameLower);
    if (actualKey) {
      targetPath = [actualKey];
      overrideType = 'state';
    }
  }

  // Fallback: try as a prop
  if (hookID === undefined && overrideType === 'hooks') {
    const propKeys = Object.keys(inspectResult.props);
    const matchedProp = propKeys.find(k => k.toLowerCase() === stateNameLower);
    if (matchedProp) {
      targetPath = [matchedProp];
      overrideType = 'props';
    }
  }

  // Send the override request
  const overrideRequestId = generateRequestId();
  clearOverrideResult();
  writeOverrideRequest({
    requestId: overrideRequestId,
    elementId: target.id,
    componentName: target.displayName,
    type: overrideType,
    path: targetPath,
    value,
    hookID,
    timestamp: Date.now(),
  });

  const overrideResult = await pollOverrideResult(overrideRequestId, 6000);

  if (!overrideResult) {
    return {
      error: 'override_timeout',
      message: `Override for "${target.displayName}.${stateName}" timed out.`,
    };
  }

  if (!overrideResult.success) {
    return {
      componentName: target.displayName,
      runtimeId: target.id,
      stateName,
      value,
      success: false,
      hookID,
      error: overrideResult.error || 'Override failed',
    };
  }

  return {
    componentName: target.displayName,
    runtimeId: target.id,
    stateName,
    value,
    success: true,
    hookID,
  };
}

// ---------------------------------------------------------------------------
// Types for Phase 4B tools
// ---------------------------------------------------------------------------

export interface TracedPropFlow {
  propName: string;
  changeType: 'added' | 'removed' | 'modified';
  previousValue: unknown;
  currentValue: unknown;
  flowPath: string[];
  totalComponentsTraced: number;
  confidence: number;
}

export interface TraceLivePropResult {
  componentName: string;
  runtimeId: number;
  tracedFlows: TracedPropFlow[];
  nodesHighlighted: number;
  flowsAnimated: number;
  summary: string;
}

export interface LiveNavigationScreen {
  name: string;
  componentName: string | null;
  isMounted: boolean;
  runtimeId: number | null;
  navigatorType: string | null;
  navigatorName: string | null;
  depth: number;
}

export interface GetLiveNavigationResult {
  screens: LiveNavigationScreen[];
  activeScreens: string[];
  totalScreens: number;
  totalMountedScreens: number;
  navigationContainerFound: boolean;
  summary: string;
}

// ---------------------------------------------------------------------------
// Tool 6: trace_live_prop
// ---------------------------------------------------------------------------

/**
 * Trace live prop flow when a prop changes at runtime.
 *
 * Inspects the component, diffs against previous inspection to find changed
 * props, then traces each changed prop through the static component tree
 * using getPropFlow. Animates the flow paths in the webview.
 *
 * If propName is specified, traces only that prop (even without a diff).
 * If propName is omitted, inspects + diffs to find changed props, then traces all.
 */
export async function traceLiveProp(
  componentName: string,
  entryFile: string,
  propName?: string
): Promise<TraceLivePropResult | { error: string; message: string }> {
  // Read runtime state
  const state = readRuntimeState();
  if (!state || state.status === 'disconnected') {
    return {
      error: 'not_connected',
      message: 'No running React Native app is connected. Use get_runtime_status for instructions.',
    };
  }

  // Find component by name
  const searchLower = componentName.toLowerCase();
  const matches = state.elements.filter(
    (el) => el.displayName.toLowerCase().includes(searchLower) && el.type !== 'other' && el.type !== 'host'
  );

  if (matches.length === 0) {
    return {
      error: 'component_not_found',
      message: `No component matching "${componentName}" found in the live runtime tree (${state.componentCount} total components).`,
    };
  }

  const target = pickBestMatch(matches, searchLower);
  const sourceFile = state.sourceMap[target.displayName] || null;

  if (!sourceFile) {
    return {
      error: 'no_source_file',
      message: `Component "${target.displayName}" has no source-mapped file. Source mapping is required for prop flow tracing.`,
    };
  }

  // Determine which props to trace
  let propsToTrace: Array<{ name: string; changeType: 'added' | 'removed' | 'modified'; previous: unknown; current: unknown }> = [];

  if (propName) {
    // Trace a specific prop — inspect to get current value
    const requestId = generateRequestId();
    clearInspectResult();
    writeInspectRequest({
      requestId,
      elementId: target.id,
      componentName: target.displayName,
      timestamp: Date.now(),
    });

    const result = await pollInspectResult(requestId, 6000);
    if (!result || !result.success) {
      return {
        error: 'inspect_timeout',
        message: `Inspection of "${target.displayName}" timed out. Ensure VS Code and Dendro extension are active.`,
      };
    }

    const previousResult = previousInspections.get(target.displayName);
    const prevValue = previousResult ? (previousResult.props as Record<string, unknown>)[propName] : undefined;
    const currValue = (result.props as Record<string, unknown>)[propName];

    previousInspections.set(target.displayName, result);

    propsToTrace.push({
      name: propName,
      changeType: previousResult ? (prevValue === undefined ? 'added' : 'modified') : 'modified',
      previous: prevValue,
      current: currValue,
    });
  } else {
    // Auto-detect changed props via diff
    const requestId = generateRequestId();
    clearInspectResult();
    writeInspectRequest({
      requestId,
      elementId: target.id,
      componentName: target.displayName,
      timestamp: Date.now(),
    });

    const currentResult = await pollInspectResult(requestId, 6000);
    if (!currentResult || !currentResult.success) {
      return {
        error: 'inspect_timeout',
        message: `Inspection of "${target.displayName}" timed out. Ensure VS Code and Dendro extension are active.`,
      };
    }

    const previousResult = previousInspections.get(target.displayName);
    previousInspections.set(target.displayName, currentResult);

    if (!previousResult) {
      return {
        componentName: target.displayName,
        runtimeId: target.id,
        tracedFlows: [],
        nodesHighlighted: 0,
        flowsAnimated: 0,
        summary: `First inspection of "${target.displayName}" — baseline captured. Call again after a prop change to trace flows.`,
      };
    }

    // Find changed props
    const prevProps = previousResult.props as Record<string, unknown>;
    const currProps = currentResult.props as Record<string, unknown>;
    const allPropKeys = new Set([...Object.keys(prevProps), ...Object.keys(currProps)]);

    for (const key of allPropKeys) {
      const inPrev = key in prevProps;
      const inCurr = key in currProps;

      if (!inPrev && inCurr) {
        propsToTrace.push({ name: key, changeType: 'added', previous: undefined, current: currProps[key] });
      } else if (inPrev && !inCurr) {
        propsToTrace.push({ name: key, changeType: 'removed', previous: prevProps[key], current: undefined });
      } else if (inPrev && inCurr && !deepEqual(prevProps[key], currProps[key])) {
        propsToTrace.push({ name: key, changeType: 'modified', previous: prevProps[key], current: currProps[key] });
      }
    }

    if (propsToTrace.length === 0) {
      return {
        componentName: target.displayName,
        runtimeId: target.id,
        tracedFlows: [],
        nodesHighlighted: 0,
        flowsAnimated: 0,
        summary: `No prop changes detected in "${target.displayName}" since last inspection.`,
      };
    }
  }

  // Trace each changed prop through static analysis
  const tracedFlows: TracedPropFlow[] = [];

  for (const prop of propsToTrace) {
    try {
      const flowResult = getPropFlow(sourceFile, prop.name);
      if (!flowResult.error && flowResult.totalComponentsTraced > 0) {
        const flowPath = flattenPropFlowNames(flowResult.flow);
        tracedFlows.push({
          propName: prop.name,
          changeType: prop.changeType,
          previousValue: prop.previous,
          currentValue: prop.current,
          flowPath: flowPath.length > 0 ? flowPath : [target.displayName],
          totalComponentsTraced: flowResult.totalComponentsTraced,
          confidence: flowResult.totalComponentsTraced > 1 ? 0.8 : 0.5,
        });
      } else {
        // No static flow found — still record the change
        tracedFlows.push({
          propName: prop.name,
          changeType: prop.changeType,
          previousValue: prop.previous,
          currentValue: prop.current,
          flowPath: [target.displayName],
          totalComponentsTraced: 1,
          confidence: 0.3,
        });
      }
    } catch {
      // Static analysis failed, record with low confidence
      tracedFlows.push({
        propName: prop.name,
        changeType: prop.changeType,
        previousValue: prop.previous,
        currentValue: prop.current,
        flowPath: [target.displayName],
        totalComponentsTraced: 1,
        confidence: 0.2,
      });
    }
  }

  // Animate in webview
  const { nodesHighlighted, flowsAnimated } = animatePropTracing(target.displayName, tracedFlows);

  const summary = `${tracedFlows.length} prop(s) traced from "${target.displayName}": ` +
    tracedFlows.map(f => `${f.propName} (${f.changeType}, ${f.flowPath.length} components)`).join(', ') +
    `. ${nodesHighlighted} node(s) highlighted, ${flowsAnimated} flow(s) animated.`;

  return {
    componentName: target.displayName,
    runtimeId: target.id,
    tracedFlows,
    nodesHighlighted,
    flowsAnimated,
    summary,
  };
}

/**
 * Animate prop flow tracing in the webview.
 */
function animatePropTracing(
  triggerComponent: string,
  tracedFlows: TracedPropFlow[]
): { nodesHighlighted: number; flowsAnimated: number } {
  visualizeClear('all');

  let nodesHighlighted = 0;
  let flowsAnimated = 0;

  // Highlight the trigger component
  visualizeHighlight([triggerComponent], 'blue', { pulse: true, label: 'prop source' });
  nodesHighlighted++;

  // Collect all affected component names
  const allAffected = new Set<string>();
  for (const flow of tracedFlows) {
    for (const name of flow.flowPath) {
      if (name !== triggerComponent) {
        allAffected.add(name);
      }
    }
  }

  if (allAffected.size > 0) {
    visualizeHighlight([...allAffected], 'yellow', { label: 'receives prop' });
    nodesHighlighted += allAffected.size;
  }

  // Draw flow lines for each traced prop
  for (const flow of tracedFlows) {
    if (flow.flowPath.length >= 2) {
      visualizeTraceFlow(flow.flowPath, {
        label: `prop: ${flow.propName} (${flow.changeType})`,
        color: '#3b82f6', // blue
        animated: true,
        flowType: 'prop',
      });
      flowsAnimated++;
    }
  }

  // Annotate trigger with summary
  const propNames = tracedFlows.map(f => f.propName).join(', ');
  visualizeAnnotate(triggerComponent, `${tracedFlows.length} prop(s): ${propNames}`, {
    position: 'right',
    style: 'badge',
    color: '#3b82f6',
  });

  return { nodesHighlighted, flowsAnimated };
}

// ---------------------------------------------------------------------------
// Tool 7: get_live_navigation
// ---------------------------------------------------------------------------

/**
 * Get live navigation state by cross-referencing runtime tree with
 * static navigation analysis. Shows which screens are currently mounted.
 */
export function getLiveNavigation(
  rootPath: string
): GetLiveNavigationResult {
  // Read runtime state
  const runtimeState = readRuntimeState();

  // Get static navigation structure
  const staticNav = getNavigationStructure(rootPath);

  // Build runtime element lookup
  const mountedComponents = new Set<string>();
  const runtimeIdMap = new Map<string, number>();
  let navigationContainerFound = false;

  if (runtimeState && runtimeState.status === 'connected') {
    for (const el of runtimeState.elements) {
      if (el.type !== 'other' && el.type !== 'host') {
        mountedComponents.add(el.displayName);
        runtimeIdMap.set(el.displayName, el.id);
      }
      // Detect NavigationContainer in runtime tree
      if (
        el.displayName === 'NavigationContainer' ||
        el.displayName === 'NavigationContainerInner' ||
        el.displayName === 'BaseNavigationContainer'
      ) {
        navigationContainerFound = true;
      }
    }
  }

  // Build screen list with mount status
  const screens: LiveNavigationScreen[] = [];

  if (staticNav.screens && staticNav.screens.length > 0) {
    for (const screen of staticNav.screens) {
      const componentName = screen.componentName || screen.name;
      const isMounted = mountedComponents.has(componentName) || mountedComponents.has(screen.name);

      // Find navigator info for this screen
      const navigator = staticNav.navigators.find(n => n.name === screen.navigatorName);

      screens.push({
        name: screen.name,
        componentName: screen.componentName,
        isMounted,
        runtimeId: runtimeIdMap.get(componentName) ?? runtimeIdMap.get(screen.name) ?? null,
        navigatorType: navigator?.type ?? null,
        navigatorName: screen.navigatorName || null,
        depth: 0, // Will be calculated below
      });
    }
  }

  // If no static screens found, try to detect screens from runtime tree
  if (screens.length === 0 && runtimeState && runtimeState.status === 'connected') {
    for (const el of runtimeState.elements) {
      if (el.type !== 'other' && el.type !== 'host') {
        // Heuristic: components ending in "Screen"
        if (el.displayName.endsWith('Screen')) {
          screens.push({
            name: el.displayName,
            componentName: el.displayName,
            isMounted: true,
            runtimeId: el.id,
            navigatorType: null,
            navigatorName: null,
            depth: el.depth,
          });
        }
      }
    }
  }

  // Calculate depth from navigation tree if available
  if (staticNav.tree) {
    assignDepthsFromNavTree(staticNav.tree, screens, 0);
  }

  const activeScreens = screens.filter(s => s.isMounted).map(s => s.name);
  const totalMountedScreens = activeScreens.length;

  const summary = runtimeState && runtimeState.status === 'connected'
    ? `${screens.length} screen(s) found, ${totalMountedScreens} currently mounted: ${activeScreens.join(', ') || 'none'}. ` +
      `Navigation container ${navigationContainerFound ? 'detected' : 'not detected'} in runtime tree.`
    : `${screens.length} screen(s) found via static analysis (no runtime connection — mount status unavailable). ` +
      `Use get_runtime_status for connection instructions.`;

  return {
    screens,
    activeScreens,
    totalScreens: screens.length,
    totalMountedScreens,
    navigationContainerFound,
    summary,
  };
}

/**
 * Recursively assign depth from the navigation tree to screen entries.
 */
function assignDepthsFromNavTree(
  node: { navigator: { name: string }; screens: Array<{ name: string }>; children: unknown[] },
  screens: LiveNavigationScreen[],
  depth: number
): void {
  for (const screenInfo of node.screens) {
    const match = screens.find(s => s.name === screenInfo.name);
    if (match) {
      match.depth = depth;
    }
  }
  for (const child of node.children as Array<typeof node>) {
    assignDepthsFromNavTree(child, screens, depth + 1);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function pickBestMatch(
  matches: SerializedRuntimeComponent[],
  searchLower: string
): SerializedRuntimeComponent {
  // Exact match first
  const exact = matches.find((m) => m.displayName.toLowerCase() === searchLower);
  if (exact) return exact;

  // Shortest name (closest match)
  return matches.sort((a, b) => a.displayName.length - b.displayName.length)[0];
}

function diffObjects(
  prev: Record<string, unknown>,
  curr: Record<string, unknown>,
  location: 'props' | 'state' | 'context',
  diffs: StateDiff[]
): void {
  const allKeys = new Set([...Object.keys(prev), ...Object.keys(curr)]);

  for (const key of allKeys) {
    const inPrev = key in prev;
    const inCurr = key in curr;

    if (!inPrev && inCurr) {
      diffs.push({ field: key, location, previous: undefined, current: curr[key], changeType: 'added' });
    } else if (inPrev && !inCurr) {
      diffs.push({ field: key, location, previous: prev[key], current: undefined, changeType: 'removed' });
    } else if (inPrev && inCurr && !deepEqual(prev[key], curr[key])) {
      diffs.push({ field: key, location, previous: prev[key], current: curr[key], changeType: 'modified' });
    }
  }
}

function diffHooks(
  prev: Array<{ id: number; name: string; value: unknown; subHooks: unknown[] }>,
  curr: Array<{ id: number; name: string; value: unknown; subHooks: unknown[] }>,
  diffs: StateDiff[]
): void {
  const maxLen = Math.max(prev.length, curr.length);

  for (let i = 0; i < maxLen; i++) {
    const prevHook = prev[i];
    const currHook = curr[i];

    if (!prevHook && currHook) {
      diffs.push({
        field: `hook[${i}]:${currHook.name}`,
        location: 'hooks',
        previous: undefined,
        current: currHook.value,
        changeType: 'added',
      });
    } else if (prevHook && !currHook) {
      diffs.push({
        field: `hook[${i}]:${prevHook.name}`,
        location: 'hooks',
        previous: prevHook.value,
        current: undefined,
        changeType: 'removed',
      });
    } else if (prevHook && currHook && !deepEqual(prevHook.value, currHook.value)) {
      diffs.push({
        field: `hook[${i}]:${currHook.name}`,
        location: 'hooks',
        previous: prevHook.value,
        current: currHook.value,
        changeType: 'modified',
      });
    }
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;

  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);

  if (aKeys.length !== bKeys.length) return false;

  for (const key of aKeys) {
    if (!deepEqual(aObj[key], bObj[key])) return false;
  }

  return true;
}

function formatTimeDelta(prev: number, curr: number): string {
  const deltaMs = curr - prev;
  if (deltaMs < 1000) return `${deltaMs}ms`;
  if (deltaMs < 60000) return `${(deltaMs / 1000).toFixed(1)}s`;
  return `${(deltaMs / 60000).toFixed(1)}m`;
}
