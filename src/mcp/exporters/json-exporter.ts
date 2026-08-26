/**
 * Dendro Pro — Proprietary
 * Copyright (c) 2025 Rooney Industries LLC. All rights reserved.
 * Unauthorized copying, modification, or distribution is prohibited.
 */

import {
  getComponentTree,
  getNavigationStructure,
  getContextMap,
  getComplexityReport,
  getScreenComponents,
  GetComponentTreeResult,
  GetNavigationStructureResult,
  GetContextMapResult,
  GetComplexityReportResult,
  GetScreenComponentsResult
} from '../tools';

const packageJson = require('../../../package.json');

type AnalysisType = 'tree' | 'navigation' | 'context' | 'complexity' | 'screens';

const VALID_ANALYSES: AnalysisType[] = ['tree', 'navigation', 'context', 'complexity', 'screens'];

export interface ExportJsonResult {
  metadata: {
    version: string;
    timestamp: string;
    entryFile: string;
    analysesIncluded: string[];
  };
  tree?: GetComponentTreeResult;
  navigation?: GetNavigationStructureResult;
  context?: GetContextMapResult;
  complexity?: GetComplexityReportResult;
  screens?: GetScreenComponentsResult;
  stats: {
    totalComponents: number;
    analysesRun: number;
  };
  error?: string;
}

/**
 * Export an enriched JSON report combining multiple Dendro analyses.
 *
 * @param entryFile - Path to the root component file (or project root for directory-based analyses)
 * @param optionsOrAnalyses - Either a string[] of analysis names, or an options object { analyses?, maxDepth? }
 * @returns ExportJsonResult with metadata envelope, selected analysis results, and summary stats
 */
export function exportJson(
  entryFile: string,
  optionsOrAnalyses?: string[] | { analyses?: string[]; maxDepth?: number }
): ExportJsonResult {
  // Normalize the second argument: accept either a plain array or an options object
  let rawAnalyses: string[] | undefined;
  let maxDepth: number | undefined;

  if (Array.isArray(optionsOrAnalyses)) {
    rawAnalyses = optionsOrAnalyses;
  } else if (optionsOrAnalyses && typeof optionsOrAnalyses === 'object') {
    rawAnalyses = optionsOrAnalyses.analyses;
    maxDepth = optionsOrAnalyses.maxDepth;
  }

  const selectedAnalyses: AnalysisType[] = [];

  // Validate and normalize the requested analyses
  if (rawAnalyses && rawAnalyses.length > 0) {
    for (const a of rawAnalyses) {
      if (VALID_ANALYSES.includes(a as AnalysisType)) {
        selectedAnalyses.push(a as AnalysisType);
      }
      // Silently skip invalid analysis names
    }
  }

  // Default to 'tree' if nothing valid was selected
  if (selectedAnalyses.length === 0) {
    selectedAnalyses.push('tree');
  }

  const result: ExportJsonResult = {
    metadata: {
      version: packageJson.version,
      timestamp: new Date().toISOString(),
      entryFile,
      analysesIncluded: [...selectedAnalyses]
    },
    stats: {
      totalComponents: 0,
      analysesRun: 0
    }
  };

  const errors: string[] = [];

  // Run each selected analysis, catching errors individually so one failure
  // doesn't prevent the others from completing.

  if (selectedAnalyses.includes('tree')) {
    try {
      const treeResult = getComponentTree(entryFile, maxDepth);
      result.tree = treeResult;
      result.stats.analysesRun++;
      if (treeResult.stats) {
        result.stats.totalComponents = treeResult.stats.totalComponents;
      }
      if (treeResult.error) {
        errors.push(`tree: ${treeResult.error}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`tree: ${msg}`);
      result.tree = {
        tree: null,
        stats: { totalComponents: 0, functionalCount: 0, classCount: 0, maxDepth: 0 },
        error: msg
      };
    }
  }

  if (selectedAnalyses.includes('navigation')) {
    try {
      const navResult = getNavigationStructure(entryFile);
      result.navigation = navResult;
      result.stats.analysesRun++;
      if (navResult.error) {
        errors.push(`navigation: ${navResult.error}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`navigation: ${msg}`);
      result.navigation = {
        navigators: [],
        screens: [],
        tree: null,
        formattedTree: '',
        totalNavigators: 0,
        totalScreens: 0,
        warnings: [],
        error: msg
      };
    }
  }

  if (selectedAnalyses.includes('context')) {
    try {
      const ctxResult = getContextMap(entryFile);
      result.context = ctxResult;
      result.stats.analysesRun++;
      if (ctxResult.error) {
        errors.push(`context: ${ctxResult.error}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`context: ${msg}`);
      result.context = {
        contexts: [],
        providers: [],
        consumers: [],
        customHooks: [],
        hierarchy: [],
        formattedTree: '',
        totalContexts: 0,
        totalConsumers: 0,
        warnings: [],
        error: msg
      };
    }
  }

  if (selectedAnalyses.includes('complexity')) {
    try {
      const compResult = getComplexityReport(entryFile);
      result.complexity = compResult;
      result.stats.analysesRun++;
      // If tree wasn't run, use complexity's component count as a fallback
      if (!selectedAnalyses.includes('tree') && compResult.summary) {
        result.stats.totalComponents = compResult.summary.totalComponents;
      }
      if (compResult.error) {
        errors.push(`complexity: ${compResult.error}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`complexity: ${msg}`);
      result.complexity = {
        components: [],
        summary: { high: 0, medium: 0, low: 0, average: 0, totalComponents: 0 },
        formattedReport: '',
        warnings: [],
        error: msg
      };
    }
  }

  if (selectedAnalyses.includes('screens')) {
    try {
      const screenResult = getScreenComponents(entryFile);
      result.screens = screenResult;
      result.stats.analysesRun++;
      if (screenResult.error) {
        errors.push(`screens: ${screenResult.error}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`screens: ${msg}`);
      result.screens = {
        screens: [],
        formattedTree: '',
        totalScreens: 0,
        warnings: [],
        error: msg
      };
    }
  }

  // If any individual analyses had errors, collect them into the top-level error field
  if (errors.length > 0) {
    result.error = errors.join('; ');
  }

  return result;
}

// Alias for server.ts compatibility
export const exportToJson = exportJson;
