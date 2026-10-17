/**
 * Dendro Pro — Proprietary
 * Copyright (c) 2025 Rooney Industries LLC. All rights reserved.
 * Unauthorized copying, modification, or distribution is prohibited.
 */

import { exportJson, ExportJsonResult } from '../exporters/json-exporter';

type AnalysisType = 'tree' | 'navigation' | 'context' | 'complexity' | 'screens';

export interface BatchEntry {
  entryFile: string;
  label?: string;
}

export interface BatchEntryResult {
  label: string;
  entryFile: string;
  result: ExportJsonResult;
}

export interface BatchAggregate {
  totalEntries: number;
  totalComponents: number;
  highestComplexity: { componentName: string; filePath: string; score: number }[];
  sharedContexts: string[];
}

export interface BatchAnalysisResult {
  entries: BatchEntryResult[];
  aggregate: BatchAggregate;
  error?: string;
}

/**
 * Run multiple analyses across multiple entry files.
 */
export function batchAnalysis(
  entries: BatchEntry[],
  analyses: AnalysisType[],
  maxDepth?: number
): BatchAnalysisResult {
  if (!entries || entries.length === 0) {
    return {
      entries: [],
      aggregate: { totalEntries: 0, totalComponents: 0, highestComplexity: [], sharedContexts: [] },
      error: 'No entries provided',
    };
  }

  const entryResults: BatchEntryResult[] = [];
  const errors: string[] = [];
  let totalComponents = 0;

  // Track complexity across all entries
  const allComplexityComponents: { componentName: string; filePath: string; score: number }[] = [];

  // Track contexts per entry for intersection
  const contextSets: Set<string>[] = [];

  for (const entry of entries) {
    const label = entry.label || entry.entryFile.split('/').pop() || entry.entryFile;
    try {
      const result = exportJson(entry.entryFile, { analyses, maxDepth });
      entryResults.push({ label, entryFile: entry.entryFile, result });

      totalComponents += result.stats.totalComponents;

      // Collect complexity data
      if (result.complexity?.components) {
        for (const comp of result.complexity.components) {
          allComplexityComponents.push({
            componentName: comp.componentName || comp.file,
            filePath: comp.absolutePath,
            score: comp.score,
          });
        }
      }

      // Collect context names
      if (result.context?.contexts) {
        const names = new Set(result.context.contexts.map((c: { name: string }) => c.name));
        contextSets.push(names);
      }

      if (result.error) {
        errors.push(`${label}: ${result.error}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${label}: ${msg}`);
      entryResults.push({
        label,
        entryFile: entry.entryFile,
        result: {
          metadata: {
            version: '',
            timestamp: new Date().toISOString(),
            entryFile: entry.entryFile,
            analysesIncluded: [],
          },
          stats: { totalComponents: 0, analysesRun: 0 },
          error: msg,
        },
      });
    }
  }

  // Top 5 highest complexity components across all entries
  const highestComplexity = allComplexityComponents
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  // Shared contexts: contexts that appear in 2+ entries
  let sharedContexts: string[] = [];
  if (contextSets.length >= 2) {
    const contextCounts = new Map<string, number>();
    for (const set of contextSets) {
      for (const name of set) {
        contextCounts.set(name, (contextCounts.get(name) || 0) + 1);
      }
    }
    sharedContexts = [...contextCounts.entries()]
      .filter(([, count]) => count >= 2)
      .map(([name]) => name);
  }

  return {
    entries: entryResults,
    aggregate: {
      totalEntries: entries.length,
      totalComponents,
      highestComplexity,
      sharedContexts,
    },
    error: errors.length > 0 ? errors.join('; ') : undefined,
  };
}
