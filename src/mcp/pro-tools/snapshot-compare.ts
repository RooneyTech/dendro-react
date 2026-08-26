/**
 * Dendro Pro — Proprietary
 * Copyright (c) 2025 Rooney Industries LLC. All rights reserved.
 * Unauthorized copying, modification, or distribution is prohibited.
 */

import { exportJson, ExportJsonResult } from '../exporters/json-exporter';
import { loadSnapshot, SnapshotMetadata } from './snapshot-manager';
import { assertPathInWorkspace } from '../path-boundary';

export interface ComponentDelta {
  componentName: string;
  filePath: string;
  scoreBefore: number;
  scoreAfter: number;
  delta: number;
}

export interface CompareTreeResult {
  added: string[];
  removed: string[];
  totalBefore: number;
  totalAfter: number;
  delta: number;
}

export interface CompareComplexityResult {
  improved: ComponentDelta[];
  degraded: ComponentDelta[];
  newComponents: { componentName: string; filePath: string; score: number }[];
  averageBefore: number;
  averageAfter: number;
}

export interface CompareContextResult {
  addedContexts: string[];
  removedContexts: string[];
  addedConsumers: string[];
  removedConsumers: string[];
}

export interface SnapshotRef {
  id: string;
  label: string;
  timestamp: string;
}

export interface CompareSnapshotsResult {
  base: SnapshotRef;
  target: SnapshotRef;
  tree: CompareTreeResult;
  complexity: CompareComplexityResult;
  context: CompareContextResult;
  summary: string;
  error?: string;
}

interface ResolvedSnapshot {
  ref: SnapshotRef;
  result: ExportJsonResult;
}

function resolveSnapshot(
  workspaceRoot: string,
  ref: string,
  entryFile?: string
): ResolvedSnapshot | { error: string } {
  if (ref === 'current') {
    if (!entryFile) {
      return { error: 'entryFile is required when using "current" as a snapshot reference' };
    }
    const result = exportJson(entryFile, { analyses: ['tree', 'complexity', 'context'] });
    return {
      ref: { id: 'current', label: 'Current', timestamp: new Date().toISOString() },
      result,
    };
  }

  const snapshot = loadSnapshot(workspaceRoot, ref);
  if (!snapshot) {
    return { error: `Snapshot "${ref}" not found` };
  }
  return {
    ref: {
      id: snapshot.metadata.id,
      label: snapshot.metadata.label,
      timestamp: snapshot.metadata.timestamp,
    },
    result: snapshot.result,
  };
}

/**
 * Extract component file paths from a tree result.
 */
function extractComponentFiles(result: ExportJsonResult): Set<string> {
  const files = new Set<string>();
  if (result.tree?.tree) {
    walkTree(result.tree.tree, files);
  }
  return files;
}

function walkTree(node: any, files: Set<string>): void {
  if (!node) return;
  if (node.file) {
    files.add(node.file);
  }
  if (node.children) {
    for (const child of node.children) {
      walkTree(child, files);
    }
  }
}

/**
 * Build a map of filePath → complexity score from a result.
 */
function extractComplexityMap(result: ExportJsonResult): Map<string, { componentName: string; filePath: string; score: number }> {
  const map = new Map<string, { componentName: string; filePath: string; score: number }>();
  if (result.complexity?.components) {
    for (const comp of result.complexity.components) {
      map.set(comp.absolutePath, {
        componentName: comp.componentName || comp.file,
        filePath: comp.absolutePath,
        score: comp.score,
      });
    }
  }
  return map;
}

/**
 * Extract context names and consumer component names from a result.
 */
function extractContextInfo(result: ExportJsonResult): { contexts: Set<string>; consumers: Set<string> } {
  const contexts = new Set<string>();
  const consumers = new Set<string>();

  if (result.context?.contexts) {
    for (const ctx of result.context.contexts) {
      contexts.add(ctx.name);
    }
  }
  if (result.context?.consumers) {
    for (const consumer of result.context.consumers) {
      if (consumer.componentName) {
        consumers.add(consumer.componentName);
      }
    }
  }

  return { contexts, consumers };
}

/**
 * Compare two snapshots (or a snapshot vs current state).
 */
export function compareSnapshots(
  workspaceRoot: string,
  base: string,
  target: string,
  entryFile?: string
): CompareSnapshotsResult {
  assertPathInWorkspace(workspaceRoot, 'workspaceRoot');
  if (entryFile) assertPathInWorkspace(entryFile, 'entryFile');

  const baseResolved = resolveSnapshot(workspaceRoot, base, entryFile);
  if ('error' in baseResolved) {
    return errorResult(baseResolved.error);
  }

  const targetResolved = resolveSnapshot(workspaceRoot, target, entryFile);
  if ('error' in targetResolved) {
    return errorResult(targetResolved.error);
  }

  // Tree diff
  const baseFiles = extractComponentFiles(baseResolved.result);
  const targetFiles = extractComponentFiles(targetResolved.result);

  const added = [...targetFiles].filter(f => !baseFiles.has(f));
  const removed = [...baseFiles].filter(f => !targetFiles.has(f));

  const treeDiff: CompareTreeResult = {
    added,
    removed,
    totalBefore: baseFiles.size,
    totalAfter: targetFiles.size,
    delta: targetFiles.size - baseFiles.size,
  };

  // Complexity diff
  const baseComplexity = extractComplexityMap(baseResolved.result);
  const targetComplexity = extractComplexityMap(targetResolved.result);

  const improved: ComponentDelta[] = [];
  const degraded: ComponentDelta[] = [];
  const newComponents: { componentName: string; filePath: string; score: number }[] = [];

  for (const [filePath, targetComp] of targetComplexity) {
    const baseComp = baseComplexity.get(filePath);
    if (!baseComp) {
      newComponents.push(targetComp);
    } else {
      const delta = targetComp.score - baseComp.score;
      if (delta < 0) {
        improved.push({
          componentName: targetComp.componentName,
          filePath,
          scoreBefore: baseComp.score,
          scoreAfter: targetComp.score,
          delta,
        });
      } else if (delta > 0) {
        degraded.push({
          componentName: targetComp.componentName,
          filePath,
          scoreBefore: baseComp.score,
          scoreAfter: targetComp.score,
          delta,
        });
      }
    }
  }

  const baseScores = [...baseComplexity.values()].map(c => c.score);
  const targetScores = [...targetComplexity.values()].map(c => c.score);
  const avgBefore = baseScores.length > 0 ? baseScores.reduce((a, b) => a + b, 0) / baseScores.length : 0;
  const avgAfter = targetScores.length > 0 ? targetScores.reduce((a, b) => a + b, 0) / targetScores.length : 0;

  const complexityDiff: CompareComplexityResult = {
    improved: improved.sort((a, b) => a.delta - b.delta),
    degraded: degraded.sort((a, b) => b.delta - a.delta),
    newComponents,
    averageBefore: Math.round(avgBefore * 100) / 100,
    averageAfter: Math.round(avgAfter * 100) / 100,
  };

  // Context diff
  const baseCtx = extractContextInfo(baseResolved.result);
  const targetCtx = extractContextInfo(targetResolved.result);

  const contextDiff: CompareContextResult = {
    addedContexts: [...targetCtx.contexts].filter(c => !baseCtx.contexts.has(c)),
    removedContexts: [...baseCtx.contexts].filter(c => !targetCtx.contexts.has(c)),
    addedConsumers: [...targetCtx.consumers].filter(c => !baseCtx.consumers.has(c)),
    removedConsumers: [...baseCtx.consumers].filter(c => !targetCtx.consumers.has(c)),
  };

  // Generate summary
  const summary = generateSummary(treeDiff, complexityDiff, contextDiff, baseResolved.ref, targetResolved.ref);

  return {
    base: baseResolved.ref,
    target: targetResolved.ref,
    tree: treeDiff,
    complexity: complexityDiff,
    context: contextDiff,
    summary,
  };
}

function generateSummary(
  tree: CompareTreeResult,
  complexity: CompareComplexityResult,
  context: CompareContextResult,
  baseRef: SnapshotRef,
  targetRef: SnapshotRef
): string {
  const parts: string[] = [];

  parts.push(`Comparing "${baseRef.label}" → "${targetRef.label}".`);

  // Tree changes
  if (tree.delta === 0 && tree.added.length === 0 && tree.removed.length === 0) {
    parts.push('No component file changes detected.');
  } else {
    const changes: string[] = [];
    if (tree.added.length > 0) changes.push(`${tree.added.length} added`);
    if (tree.removed.length > 0) changes.push(`${tree.removed.length} removed`);
    parts.push(`Components: ${changes.join(', ')} (${tree.totalBefore} → ${tree.totalAfter}).`);
  }

  // Complexity changes
  const complexityChanges: string[] = [];
  if (complexity.improved.length > 0) complexityChanges.push(`${complexity.improved.length} improved`);
  if (complexity.degraded.length > 0) complexityChanges.push(`${complexity.degraded.length} degraded`);
  if (complexity.newComponents.length > 0) complexityChanges.push(`${complexity.newComponents.length} new`);
  if (complexityChanges.length > 0) {
    parts.push(`Complexity: ${complexityChanges.join(', ')}. Average: ${complexity.averageBefore} → ${complexity.averageAfter}.`);
  }

  // Context changes
  const ctxChanges: string[] = [];
  if (context.addedContexts.length > 0) ctxChanges.push(`+${context.addedContexts.length} contexts`);
  if (context.removedContexts.length > 0) ctxChanges.push(`-${context.removedContexts.length} contexts`);
  if (context.addedConsumers.length > 0) ctxChanges.push(`+${context.addedConsumers.length} consumers`);
  if (context.removedConsumers.length > 0) ctxChanges.push(`-${context.removedConsumers.length} consumers`);
  if (ctxChanges.length > 0) {
    parts.push(`Context: ${ctxChanges.join(', ')}.`);
  }

  return parts.join(' ');
}

function errorResult(error: string): CompareSnapshotsResult {
  return {
    base: { id: '', label: '', timestamp: '' },
    target: { id: '', label: '', timestamp: '' },
    tree: { added: [], removed: [], totalBefore: 0, totalAfter: 0, delta: 0 },
    complexity: { improved: [], degraded: [], newComponents: [], averageBefore: 0, averageAfter: 0 },
    context: { addedContexts: [], removedContexts: [], addedConsumers: [], removedConsumers: [] },
    summary: '',
    error,
  };
}
