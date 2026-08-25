/**
 * Copyright (c) 2025 Rooney Industries LLC. Licensed under MIT (see LICENSE.md).
 *
 * Advanced tool registrations for the MCP server (the former Pro tier — all
 * tools ship free as of v0.5.1; gating is dormant, see pro-gate.ts).
 * This module is conditionally required via DENDRO_INCLUDE_PRO DefinePlugin flag.
 * When building with DENDRO_INCLUDE_PRO=false, webpack eliminates this entire
 * module and all its transitive dependencies from the bundle.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { proFeatureResponse, isGated } from './pro-gate';

// --- Export tools ---
import { exportMermaid, ExportMermaidResult } from './exporters/mermaid-exporter';
import { exportJson, ExportJsonResult } from './exporters/json-exporter';
import { exportSvg, ExportSvgResult } from './exporters/svg-exporter';
import { exportMarkdown, ExportMarkdownResult } from './exporters/markdown-exporter';

// --- Pro analysis tools ---
import { batchAnalysis, BatchAnalysisResult } from './pro-tools/batch-analysis';
import { saveSnapshot, listSnapshots, SaveSnapshotResult, ListSnapshotsResult } from './pro-tools/snapshot-manager';
import { compareSnapshots, CompareSnapshotsResult } from './pro-tools/snapshot-compare';

// --- Verified Projection ---
import { generateHypotheses } from './pro-tools/hypothesis-engine';
import { generateFlowTests } from './pro-tools/template-engine';
import { runFlowTests } from './pro-tools/test-runner';
import { annotateTreeWithVerification } from './pro-tools/verification-annotator';
import type { GenerateHypothesesResult, GenerateFlowTestResult, RunFlowTestsResult, AnnotateVerificationResult } from './pro-tools/verification-types';

// --- Triggered Projection ---
import { projectFromRuntime } from './pro-tools/triggered-projection';
import type { TriggerProjectionResult } from './pro-tools/triggered-projection';

// --- Live Introspection ---
import {
  inspectLiveComponent,
  diffComponentState,
  findStateOwner,
  modifyRuntimeState,
  traceLiveProp,
  getLiveNavigation,
} from './pro-tools/live-introspection';
import type { FindStateOwnerResult } from './pro-tools/live-introspection';

export function registerProTools(server: McpServer): void {

  // ============================================================================
  // Export (consolidated — the four per-format tools differed only by format)
  // ============================================================================

  server.tool(
    'export_analysis',
    'Export Dendro analysis in one of four formats: "mermaid" (flowchart syntax for docs), "json" (enriched multi-analysis document), "svg" (color-coded diagram image), "markdown" (formatted report — supports persona: developer/ceo/investor/eng-manager/onboarding). Format-specific options are ignored by other formats.',
    {
      format: z.enum(['mermaid', 'json', 'svg', 'markdown']).describe('Output format'),
      entryFile: z.string().describe('Absolute path to the entry React component file'),
      maxDepth: z.number().optional().describe('Maximum depth for tree traversal. Default: unlimited'),
      analyses: z.array(z.enum(['tree', 'navigation', 'context', 'complexity', 'screens'])).optional()
        .describe('json/markdown: which analyses to include. Default: ["tree"] (markdown default depends on persona)'),
      direction: z.enum(['TB', 'LR']).optional().describe('mermaid: graph direction. Default: LR'),
      theme: z.enum(['light', 'dark']).optional().describe('svg: color theme. Default: dark'),
      persona: z.enum(['developer', 'ceo', 'investor', 'eng-manager', 'onboarding']).optional()
        .describe('markdown: target audience — changes formatting, language, structure. Default: developer')
    },
    async ({ format, entryFile, maxDepth, analyses, direction, theme, persona }): Promise<{ content: [{ type: 'text'; text: string }] }> => {
      if (isGated('export_analysis')) return proFeatureResponse('export_analysis');
      let result: ExportMermaidResult | ExportJsonResult | ExportSvgResult | ExportMarkdownResult;
      switch (format) {
        case 'mermaid': result = exportMermaid(entryFile, maxDepth, direction); break;
        case 'json': result = exportJson(entryFile, { analyses, maxDepth }); break;
        case 'svg': result = exportSvg(entryFile, maxDepth, theme); break;
        case 'markdown': result = exportMarkdown(entryFile, { analyses, maxDepth, persona }); break;
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ============================================================================
  // Snapshots (consolidated save/list/compare)
  // ============================================================================

  server.tool(
    'manage_snapshots',
    'Analysis snapshots for historical tracking, one tool, three actions: "save" (run analyses and store under .dendro/snapshots/ — requires entryFile), "list" (metadata for every saved snapshot), "compare" (diff two snapshots or a snapshot vs "current" live analysis — requires base and target; entryFile required when either side is "current"). Typical loop: save before a refactor, compare base:"<id>" target:"current" after.',
    {
      action: z.enum(['save', 'list', 'compare']).describe('What to do'),
      workspaceRoot: z.string().describe('Absolute path to the workspace root directory'),
      entryFile: z.string().optional().describe('save: entry file to analyze (required). compare: required when base or target is "current".'),
      label: z.string().optional().describe('save: human-readable label (defaults to filename)'),
      analyses: z.array(z.enum(['tree', 'navigation', 'context', 'complexity', 'screens'])).optional()
        .describe('save: which analyses to include. Default: ["tree", "complexity", "context"]'),
      base: z.string().optional().describe('compare: snapshot ID or "current"'),
      target: z.string().optional().describe('compare: snapshot ID or "current"')
    },
    async ({ action, workspaceRoot, entryFile, label, analyses, base, target }): Promise<{ content: [{ type: 'text'; text: string }] }> => {
      if (isGated('manage_snapshots')) return proFeatureResponse('manage_snapshots');
      let result: SaveSnapshotResult | ListSnapshotsResult | CompareSnapshotsResult | { error: string };
      switch (action) {
        case 'save':
          result = entryFile
            ? saveSnapshot(entryFile, workspaceRoot, label, analyses)
            : { error: 'action "save" requires entryFile' };
          break;
        case 'list':
          result = listSnapshots(workspaceRoot);
          break;
        case 'compare':
          result = base && target
            ? compareSnapshots(workspaceRoot, base, target, entryFile)
            : { error: 'action "compare" requires base and target (snapshot IDs or "current")' };
          break;
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ============================================================================
  // Verified Projection (consolidated — the 4 steps were a strictly linear
  // pipeline agents always ran in order; one tool runs the chain and stops
  // where asked)
  // ============================================================================

  server.tool(
    'verify_state_flows',
    'Verified Projection in one call: generate testable state-flow hypotheses from static analysis, write Jest tests for them, run the tests, and annotate the visualizer tree (green=verified, red=failed, amber=inconclusive). Use stopAfter to run only part of the chain and inspect intermediates: "hypotheses" (static analysis only, no files written), "tests" (also writes Jest files to __dendro__/tests/), "run" (also executes them). Default runs everything including annotation.',
    {
      entryFile: z.string().describe('Absolute path to the entry React component file'),
      workspaceRoot: z.string().describe('Absolute path to the workspace root directory'),
      stopAfter: z.enum(['hypotheses', 'tests', 'run', 'annotate']).optional()
        .describe('How far to run the chain. Default: annotate (full pipeline)'),
      maxHypotheses: z.number().optional().describe('Maximum hypotheses to generate. Default: 20'),
      flowTypes: z.array(z.enum(['context', 'prop', 'hook-state'])).optional()
        .describe('Which flow types to analyze. Default: all three'),
      timeout: z.number().optional().describe('Jest execution timeout in ms. Default: 60000'),
      clearPrevious: z.boolean().optional().describe('annotate: clear existing annotations first. Default: true')
    },
    async ({ entryFile, workspaceRoot, stopAfter, maxHypotheses, flowTypes, timeout, clearPrevious }): Promise<{ content: [{ type: 'text'; text: string }] }> => {
      if (isGated('verify_state_flows')) return proFeatureResponse('verify_state_flows');
      const respond = (payload: unknown): { content: [{ type: 'text'; text: string }] } =>
        ({ content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] });

      const hypothesesResult: GenerateHypothesesResult = generateHypotheses({ entryFile, maxHypotheses, flowTypes });
      if (hypothesesResult.error || stopAfter === 'hypotheses') {
        return respond({ stage: 'hypotheses', ...hypothesesResult });
      }

      const testsResult: GenerateFlowTestResult = generateFlowTests({ hypotheses: hypothesesResult.hypotheses, workspaceRoot });
      if (testsResult.error || stopAfter === 'tests') {
        return respond({ stage: 'tests', hypotheses: hypothesesResult.hypotheses, ...testsResult });
      }

      const runResult: RunFlowTestsResult = await runFlowTests({ workspaceRoot, timeout });
      if (runResult.error || stopAfter === 'run') {
        return respond({ stage: 'run', hypotheses: hypothesesResult.hypotheses, ...runResult });
      }

      const annotateResult: AnnotateVerificationResult = annotateTreeWithVerification({
        entryFile,
        results: runResult.results,
        hypotheses: hypothesesResult.hypotheses,
        clearPrevious,
      });
      return respond({ stage: 'annotate', testSummary: runResult.summary, results: runResult.results, ...annotateResult });
    }
  );

  // ============================================================================
  // Pro Analysis Tools
  // ============================================================================

  // Tool: batch_analysis (PRO)
  server.tool(
    'batch_analysis',
    'Run multiple analyses across multiple entry files in one call. Returns per-entry results plus aggregate summary (total components, highest complexity, shared contexts). Ideal for monorepos and multi-entry apps.',
    {
      entries: z.array(z.object({
        entryFile: z.string().describe('Absolute path to an entry React component file'),
        label: z.string().optional().describe('Human-readable label for this entry')
      })).describe('Array of entry files to analyze'),
      analyses: z.array(z.enum(['tree', 'navigation', 'context', 'complexity', 'screens']))
        .describe('Which analyses to run on each entry'),
      maxDepth: z.number().optional().describe('Maximum depth for tree traversal. Default: unlimited')
    },
    async ({ entries, analyses, maxDepth }): Promise<{ content: [{ type: 'text'; text: string }] }> => {
      if (isGated('batch_analysis')) return proFeatureResponse('batch_analysis');
      const result: BatchAnalysisResult = batchAnalysis(entries, analyses, maxDepth);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }]
      };
    }
  );

  // ============================================================================
  // Verified Projection Tools (PRO — Paradigm 2)
  // ============================================================================

  // ============================================================================
  // Triggered Projection (PRO — Paradigm 3)
  // ============================================================================

  // Tool: trigger_projection (PRO)
  server.tool(
    'trigger_projection',
    'Diff runtime snapshots and project downstream effects. Call get_runtime_status first. Call once for baseline, then again after a re-render to see what changed and how data flows. Set verify=true to also run Verified Projection.',
    {
      entryFile: z.string().describe('Absolute path to the entry React component file (e.g., /path/to/App.tsx)'),
      componentName: z.string().optional().describe('Filter to a specific component by name (case-insensitive, partial match)'),
      verify: z.boolean().optional().describe('If true, also run Verified Projection on changed components to annotate verification status')
    },
    async ({ entryFile, componentName, verify }): Promise<{ content: [{ type: 'text'; text: string }] }> => {
      if (isGated('trigger_projection')) return proFeatureResponse('trigger_projection');
      const result: TriggerProjectionResult = projectFromRuntime({ entryFile, componentName, verify });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }]
      };
    }
  );

  // ============================================================================
  // Live Introspection (PRO — Paradigm 4)
  // ============================================================================

  // Tool: inspect_live_component (PRO)
  server.tool(
    'inspect_live_component',
    'Deep inspect a running component\'s props, state, hooks, and context values. Call get_runtime_status first to verify connection. Returns real runtime values. Use before modify_runtime_state. Pass diffFromPrevious:true on a SECOND call to get what changed since the last inspection of the same component (props/state/hooks/context deltas) instead of the full snapshot.',
    {
      componentName: z.string().describe('Display name of the component to inspect (case-insensitive, partial match). Must be a user-defined component, not a host element like "View" or "Text".'),
      diffFromPrevious: z.boolean().optional().describe('Compare against the previous inspection of this component and return only the deltas. Requires a prior call without this flag (that call is the baseline).')
    },
    async ({ componentName, diffFromPrevious }): Promise<{ content: [{ type: 'text'; text: string }] }> => {
      if (isGated('inspect_live_component')) return proFeatureResponse('inspect_live_component');
      const result = diffFromPrevious
        ? await diffComponentState(componentName)
        : await inspectLiveComponent(componentName);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }]
      };
    }
  );

  // Tool: find_state_owner (PRO)
  server.tool(
    'find_state_owner',
    'Find which component(s) own a given state variable by name. Uses static analysis (getHookDeps) cross-referenced with the live runtime tree to identify mounted components that define the matching useState variable.',
    {
      stateName: z.string().describe('Name of the state variable to search for (case-insensitive, partial match). E.g., "loading", "user", "email"'),
      entryFile: z.string().optional().describe('Optional entry file path to scan if no matches found in source-mapped components')
    },
    async ({ stateName, entryFile }): Promise<{ content: [{ type: 'text'; text: string }] }> => {
      if (isGated('find_state_owner')) return proFeatureResponse('find_state_owner');
      const result: FindStateOwnerResult = findStateOwner(stateName, entryFile);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }]
      };
    }
  );

  // ============================================================================
  // State Modification (PRO — Paradigm 4 Phase 4)
  // ============================================================================

  // Tool: modify_runtime_state (PRO)
  server.tool(
    'modify_runtime_state',
    'Modify a component\'s props/state/hooks/context at runtime. Call inspect_live_component first to see current values and identify the right paths. For a simple single-value state change, targetType "state" with the hook index from inspect_live_component is the usual path.',
    {
      componentName: z.string().describe('Display name of the component to modify (case-insensitive, partial match)'),
      type: z.enum(['props', 'state', 'hooks', 'context']).describe('Which part of the component to modify'),
      path: z.array(z.string()).describe('Path within the value to modify (e.g., ["user", "name"] for state.user.name). Empty array [] to replace the whole value.'),
      value: z.any().describe('New value to set at the path'),
      hookID: z.number().optional().describe('Hook ID for hook state overrides (from inspect_live_component hooks array)')
    },
    async ({ componentName, type, path, value, hookID }): Promise<{ content: [{ type: 'text'; text: string }] }> => {
      if (isGated('modify_runtime_state')) return proFeatureResponse('modify_runtime_state');
      const result = await modifyRuntimeState(componentName, type, path, value, hookID);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }]
      };
    }
  );

  // ============================================================================
  // Live Prop Tracing + Navigation (PRO — Paradigm 4 Phase 4B)
  // ============================================================================

  // Tool: trace_live_prop (PRO)
  server.tool(
    'trace_live_prop',
    'Trace live prop changes through the component tree and animate in the visualizer. Call get_runtime_status first. Call once for baseline, then again after a prop change to see animated flow paths.',
    {
      componentName: z.string().describe('Display name of the component to trace prop flows from (case-insensitive, partial match)'),
      entryFile: z.string().describe('Absolute path to the entry React component file (needed for static analysis)'),
      propName: z.string().optional().describe('Specific prop name to trace. If omitted, auto-detects changed props via diff.')
    },
    async ({ componentName, entryFile, propName }): Promise<{ content: [{ type: 'text'; text: string }] }> => {
      if (isGated('trace_live_prop')) return proFeatureResponse('trace_live_prop');
      const result = await traceLiveProp(componentName, entryFile, propName);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }]
      };
    }
  );

  // Tool: get_live_navigation (PRO)
  server.tool(
    'get_live_navigation',
    'Get live navigation state — which screens are mounted (active) vs defined but not visible. Cross-references runtime tree with static React Navigation analysis. Works without runtime too (static-only mode).',
    {
      rootPath: z.string().describe('Path to the root navigation file or directory containing navigation files (same as get_navigation_structure)')
    },
    async ({ rootPath }): Promise<{ content: [{ type: 'text'; text: string }] }> => {
      if (isGated('get_live_navigation')) return proFeatureResponse('get_live_navigation');
      const result = getLiveNavigation(rootPath);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }]
      };
    }
  );
}
