/**
 * Dendro Pro — Proprietary
 * Copyright (c) 2025 Rooney Industries LLC. All rights reserved.
 * Unauthorized copying, modification, or distribution is prohibited.
 */

import * as path from 'path';
import {
  visualizeHighlight,
  visualizeTraceFlow,
  visualizeAnnotate,
  visualizeClear,
} from '../tools';
import type {
  FlowTestResult,
  StateFlowHypothesis,
  VerificationSummary,
  AnnotateVerificationInput,
  AnnotateVerificationResult,
} from './verification-types';

// --- Color Constants ---

const COLORS = {
  verified: '#22c55e',     // green
  failed: '#ef4444',       // red
  inconclusive: '#f59e0b', // amber
  partial: '#a855f7',      // purple
} as const;

type NodeStatus = 'verified' | 'failed' | 'inconclusive' | 'partial';

// --- Node Aggregation ---

interface NodeVerificationInfo {
  componentName: string;
  verified: number;
  failed: number;
  inconclusive: number;
  total: number;
  status: NodeStatus;
}

/**
 * Aggregate test results per component node.
 *
 * Each hypothesis has a trigger component and an expectation component.
 * We collect all results that reference each component and determine
 * its aggregate status.
 */
function aggregateByNode(
  results: FlowTestResult[],
  hypotheses: StateFlowHypothesis[],
): Map<string, NodeVerificationInfo> {
  const nodeMap = new Map<string, NodeVerificationInfo>();

  // Build a lookup from hypothesis ID to hypothesis
  const hypothesisMap = new Map<string, StateFlowHypothesis>();
  for (const h of hypotheses) {
    hypothesisMap.set(h.id, h);
  }

  // For each result, attribute it to both trigger and expectation components
  for (const result of results) {
    const hypothesis = hypothesisMap.get(result.hypothesisId);
    if (!hypothesis) continue;

    // Attribute to trigger component
    addResultToNode(nodeMap, hypothesis.trigger.component, result);

    // Attribute to expectation component (if different)
    if (hypothesis.expectation.component !== hypothesis.trigger.component) {
      addResultToNode(nodeMap, hypothesis.expectation.component, result);
    }
  }

  // Calculate aggregate status for each node
  for (const info of nodeMap.values()) {
    info.status = calculateNodeStatus(info);
  }

  return nodeMap;
}

function addResultToNode(
  nodeMap: Map<string, NodeVerificationInfo>,
  componentName: string,
  result: FlowTestResult,
): void {
  if (!nodeMap.has(componentName)) {
    nodeMap.set(componentName, {
      componentName,
      verified: 0,
      failed: 0,
      inconclusive: 0,
      total: 0,
      status: 'verified', // Will be recalculated
    });
  }

  const info = nodeMap.get(componentName)!;
  info.total++;

  switch (result.status) {
    case 'verified':
      info.verified++;
      break;
    case 'failed':
      info.failed++;
      break;
    case 'inconclusive':
      info.inconclusive++;
      break;
  }
}

/**
 * Calculate aggregate node status.
 * Priority: any failure → red, mix verified+inconclusive → purple,
 * all inconclusive → amber, all verified → green
 */
function calculateNodeStatus(info: NodeVerificationInfo): NodeStatus {
  if (info.failed > 0) return 'failed';
  if (info.verified > 0 && info.inconclusive > 0) return 'partial';
  if (info.inconclusive > 0) return 'inconclusive';
  return 'verified';
}

// --- Main Entry Point ---

/**
 * Annotate the tree visualization with verification results.
 *
 * 1. Optionally clear previous annotations
 * 2. Highlight nodes by aggregate status
 * 3. Annotate nodes with "X/Y verified" labels
 * 4. Draw colored flow lines between trigger and expectation
 */
export function annotateTreeWithVerification(
  input: AnnotateVerificationInput,
): AnnotateVerificationResult {
  const { results, hypotheses, clearPrevious = true } = input;

  if (!results || results.length === 0) {
    return {
      nodesHighlighted: 0,
      flowsColored: 0,
      summary: { ...emptySummary(), coveragePercent: 0 },
      error: 'No results to annotate.',
    };
  }

  if (!hypotheses || hypotheses.length === 0) {
    return {
      nodesHighlighted: 0,
      flowsColored: 0,
      summary: { ...emptySummary(), coveragePercent: 0 },
      error: 'No hypotheses provided.',
    };
  }

  // Step 1: Clear previous annotations if requested
  if (clearPrevious) {
    visualizeClear('all');
  }

  // Step 2: Aggregate results by node
  const nodeMap = aggregateByNode(results, hypotheses);

  // Step 3: Highlight nodes by status
  let nodesHighlighted = 0;
  const statusGroups: Record<NodeStatus, string[]> = {
    verified: [],
    failed: [],
    inconclusive: [],
    partial: [],
  };

  for (const [componentName, info] of nodeMap) {
    statusGroups[info.status].push(componentName);
  }

  // Highlight each group with appropriate color
  for (const [status, nodes] of Object.entries(statusGroups)) {
    if (nodes.length === 0) continue;
    const color = COLORS[status as NodeStatus];
    const highlightColor = statusToHighlightColor(status as NodeStatus);

    visualizeHighlight(nodes, highlightColor, {
      label: status,
      pulse: status === 'failed',
    });

    nodesHighlighted += nodes.length;
  }

  // Step 4: Annotate nodes with "X/Y verified" labels
  for (const [componentName, info] of nodeMap) {
    const label = `${info.verified}/${info.total} verified`;
    const color = COLORS[info.status];

    visualizeAnnotate(componentName, label, {
      position: 'right',
      style: 'badge',
      color,
    });
  }

  // Step 5: Draw colored flow lines between trigger and expectation
  let flowsColored = 0;
  const hypothesisMap = new Map<string, StateFlowHypothesis>();
  for (const h of hypotheses) {
    hypothesisMap.set(h.id, h);
  }

  for (const result of results) {
    const hypothesis = hypothesisMap.get(result.hypothesisId);
    if (!hypothesis) continue;

    const flowColor = result.status === 'verified'
      ? COLORS.verified
      : result.status === 'failed'
        ? COLORS.failed
        : COLORS.inconclusive;

    const flowType = hypothesis.flowType === 'context' ? 'context'
      : hypothesis.flowType === 'prop' ? 'prop'
      : 'state';

    visualizeTraceFlow(
      [hypothesis.trigger.component, hypothesis.expectation.component],
      {
        label: `${hypothesis.id}: ${result.status}`,
        color: flowColor,
        animated: result.status === 'verified',
        flowType,
      },
    );

    flowsColored++;
  }

  // Build summary
  const summary = buildAnnotationSummary(results, hypotheses);

  return {
    nodesHighlighted,
    flowsColored,
    summary,
  };
}

// --- Helpers ---

/**
 * Map our custom status to the HighlightColor enum available in visualize tools.
 */
function statusToHighlightColor(status: NodeStatus): 'green' | 'red' | 'orange' | 'purple' | 'yellow' {
  switch (status) {
    case 'verified': return 'green';
    case 'failed': return 'red';
    case 'inconclusive': return 'orange';
    case 'partial': return 'purple';
  }
}

function buildAnnotationSummary(
  results: FlowTestResult[],
  hypotheses: StateFlowHypothesis[],
): VerificationSummary & { coveragePercent: number } {
  const verified = results.filter(r => r.status === 'verified').length;
  const failed = results.filter(r => r.status === 'failed').length;
  const inconclusive = results.filter(r => r.status === 'inconclusive').length;
  const tested = results.length;
  const total = hypotheses.length;
  const untested = total - tested;
  const coveragePercent = total > 0 ? Math.round((tested / total) * 100) : 0;

  return {
    total,
    verified,
    failed,
    inconclusive,
    untested,
    coveragePercent,
  };
}

function emptySummary(): VerificationSummary {
  return { total: 0, verified: 0, failed: 0, inconclusive: 0, untested: 0 };
}
