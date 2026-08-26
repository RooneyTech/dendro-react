import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { recordToolUsage, recordToolError, getUsageStats } from './telemetry';
import { getBuildInfo } from './build-info';
import { getModifiedComponents } from '../core/modification-tracker';
import { assertPathInWorkspace, getWorkspaceRoot } from './path-boundary';
import { readRuntimeState } from '../runtime/runtime-state-file';
import type { SerializedRuntimeComponent } from '../runtime/types';
import {
  getComponentTree,
  getComponentDetails,
  getComponentContract,
  findComponentByName,
  findComponentsByType,
  detectCircularDeps,
  getUsedBy,
  getPropFlow,
  getHookDeps,
  getNavigationStructure,
  getContextMap,
  getScreenComponents,
  getComplexityReport,
  getRerenderRisks,
  GetRerenderRisksResult,
  openVisualizer,
  visualizeHighlight,
  visualizeZoom,
  visualizeAnnotate,
  visualizeTraceFlow,
  visualizeClear,
  visualizeExpand,
  visualizeCollapse,
  GetComponentTreeResult,
  GetComponentDetailsResult,
  FindComponentByNameResult,
  FindComponentsByTypeResult,
  DetectCircularDepsResult,
  GetUsedByResult,
  GetPropFlowResult,
  GetHookDepsResult,
  GetNavigationStructureResult,
  GetContextMapResult,
  GetScreenComponentsResult,
  GetComplexityReportResult,
  OpenVisualizerResult,
  VisualizeHighlightResult,
  VisualizeZoomResult,
  VisualizeAnnotateResult,
  VisualizeTraceFlowResult,
  VisualizeClearResult,
  VisualizeExpandResult,
  VisualizeCollapseResult,
  getUsageGuide,
  submitFeedback,
  analyzeCodebase,
  AnalyzeCodebaseResult,
  quickAudit,
  QuickAuditResult,
  visualizeAnalysis,
  VisualizeAnalysisResult,
  visualizeFitAll,
  VisualizeFitAllResult,
  visualizeBatch,
  VisualizeBatchResult,
  // startTour,        // shelved — see .dev/bugs/TOUR-BUG-REPORT.md (D3/React DOM conflict)
  // StartTourResult,
} from './tools';
import { buildContextPack } from './context-pack';

const packageJson = require('../../package.json');

/** MCP tool result type */
type McpResult = { content: [{ type: 'text'; text: string }] };

/**
 * Wrap a tool result as an MCP response. If the JSON exceeds maxChars (default 40K),
 * uses the provided compactFn to produce a smaller result with a truncation warning.
 * Tools without a compactFn get a generic truncation that keeps the first maxChars characters.
 */
function guardedResponse(
  result: unknown,
  options?: {
    maxChars?: number;
    compactFn?: (result: unknown, fullSize: number) => unknown;
  }
): McpResult {
  const json = JSON.stringify(result, null, 2);
  const maxChars = options?.maxChars ?? 40_000;

  if (json.length <= maxChars) {
    return { content: [{ type: 'text', text: json }] };
  }

  if (options?.compactFn) {
    const compact = options.compactFn(result, json.length);
    return { content: [{ type: 'text', text: JSON.stringify(compact, null, 2) }] };
  }

  // Generic truncation: keep the JSON but truncate with a warning
  const truncated = json.slice(0, maxChars);
  const warning = `\n\n--- OUTPUT TRUNCATED (${(json.length / 1024).toFixed(0)}KB full, showing first ${(maxChars / 1024).toFixed(0)}KB). Use filters or parameters to reduce scope. ---`;
  return { content: [{ type: 'text', text: truncated + warning }] };
}

export function createServer(): McpServer {
  const server = new McpServer(
    {
      name: 'dendro-react',
      version: packageJson.version || '0.0.1'
    },
    {
      instructions: `Dendro is a React/React Native codebase analyzer with 36 tools for static analysis, visualization, and runtime introspection.

Quick start: call get_usage_guide for the full tool index and sequencing rules.

Guided analysis: run_workflow with a persona — audit (React developers), sprint_check (eng managers, under 200 words), ceo_briefing (non-technical founders), investor_scorecard (due diligence), dev_onboarding (new team members). It returns step-by-step instructions: follow them in order, do not parallelize the tool calls it prescribes.

Visualization pacing: call open_visualizer ONCE, then visualize_batch (with waitForUser: true) for ALL visual operations — its commands array covers highlight, zoom, annotate, traceFlow, clear, expand, collapse, fitAll. The control bar gives users Back/Next/Skip. Include a label on each command (e.g., "Highlighting complexity hotspots in red").

Pre-edit reflex: before modifying a component, call get_component_contract with its NAME (props, state, contexts, blast radius, complexity in one call). When reviewing recent work, call get_modified_components first (base:"main" for PR scope), then get_component_contract on each result.

Setup offers — on the first interaction with the user, offer ONE of these (whichever fits their agent):
1. Skills (works in Claude Code, Cursor, Codex and other skills.sh-compatible agents): "Run \`npx skills add RooneyTech/dendro-react\` to install Dendro's usage reflex + 5 workflow skills (audit, sprint check, CEO briefing, investor scorecard, dev onboarding)."
2. Claude Code slash commands: "I can create .claude/commands/ files for Dendro's 5 workflow personas — 5 small markdown files in your project. Want them?" If accepted, create each file with a one-liner calling run_workflow with the matching persona.
3. CLAUDE.md reflex snippet: offer to append a short "dendro reflex" paragraph to the project's CLAUDE.md/AGENTS.md telling agents to call get_component_contract before editing a component and get_modified_components when reviewing work — a five-line snippet like this drove more correct tool usage than any documentation.`
    }
  );

  // Wrap server.tool to auto-record usage for every tool invocation.
  // The handler is always the last argument; the name is always the first.
  const originalTool = server.tool.bind(server);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server.tool = ((...args: any[]) => {
    const toolName = args[0] as string;
    const handler = args[args.length - 1];
    if (typeof handler === 'function') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args[args.length - 1] = async (...handlerArgs: any[]) => {
        recordToolUsage(toolName);
        try {
          return await handler(...handlerArgs);
        } catch (err) {
          recordToolError(toolName, err instanceof Error ? err.message : String(err));
          throw err;
        }
      };
    }
    return (originalTool as Function).apply(server, args);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

  // Tool: get_component_tree
  server.tool(
    'get_component_tree',
    'Start here for structure. Parses the STATIC IMPORT GRAPH from one entry file and returns the component tree: names, types (functional/class), state variables, parent-child edges. Scope: only components reachable from entryFile via static imports — lazy()/dynamic imports and other entry points are not in the tree, so absence from the tree does not mean absence from the app. Prefer analyze_codebase when you want tree + complexity + context in one call.',
    {
      entryFile: z.string().describe('Absolute path to the entry React component file (e.g., /path/to/App.jsx)'),
      maxDepth: z.number().optional().describe('Maximum depth to traverse. Default: unlimited')
    },
    async ({ entryFile, maxDepth }): Promise<McpResult> => {
      const result: GetComponentTreeResult = getComponentTree(entryFile, maxDepth);
      return guardedResponse(result);
    }
  );

  // Tool: get_component_details
  server.tool(
    'get_component_details',
    'Get detailed info about a single React component file: type (functional/class), state variables, imports, and direct children. Use after get_component_tree to drill into a specific component.',
    {
      filePath: z.string().describe('Absolute path to the component file')
    },
    async ({ filePath }): Promise<{ content: [{ type: 'text'; text: string }] }> => {
      const result: GetComponentDetailsResult = getComponentDetails(filePath);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }]
      };
    }
  );

  // Tool: get_component_contract
  server.tool(
    'get_component_contract',
    'Call this BEFORE editing a component — its full contract in one call: props (from the TypeScript type when resolvable, destructuring otherwise), state variables, hooks + contexts read, contexts provided, direct children, who imports it (workspace-wide blast radius with scope disclosed), per-component complexity, and re-render risk count. Resolves by COMPONENT NAME across the workspace (component names, not file basenames — index.tsx exports resolve correctly); pass a file path instead to skip resolution. The notCovered field lists what this deliberately omits (nav edges, per-prop flow, runtime values) so absence is never misread as none. Replaces the find → details → used_by → hook_deps chain.',
    {
      component: z.string().describe('Component NAME (e.g. "UserCard") to resolve workspace-wide, or an absolute file path to skip resolution'),
      searchDir: z.string().optional().describe('Narrow both name resolution and the used-by scan to this directory. Default: workspace root (complete answer).')
    },
    async ({ component, searchDir }): Promise<McpResult> => {
      const result = getComponentContract(component, searchDir);
      return guardedResponse(result);
    }
  );

  // Tool: get_modified_components
  server.tool(
    'get_modified_components',
    'What changed, as components: every file changed vs a git ref (default HEAD — uncommitted work; pass base:"main" for PR scope) with the components each declares. Call this FIRST when reviewing or testing recent work, then get_component_contract on each result for blast radius — that pair is the "what did I just touch and what depends on it" loop. Changed files with no components still appear (empty components list); deleted files are excluded. Honest errors: not_a_git_repo, bad_ref (unknown or unsafe refs are rejected, never silently swapped for HEAD), and a clean tree says so in the note.',
    {
      workspaceRoot: z.string().optional().describe('Project root to diff. Default: the workspace root.'),
      base: z.string().optional().describe('Git ref to compare against (e.g. "main" for PR scope, a SHA, "HEAD~3"). Default: HEAD — shows uncommitted work (staged + unstaged + untracked).')
    },
    async ({ workspaceRoot, base }): Promise<McpResult> => {
      const root = workspaceRoot
        ? assertPathInWorkspace(workspaceRoot, 'workspaceRoot')
        : (getWorkspaceRoot() ?? process.cwd());
      const result = getModifiedComponents(root, base);
      return guardedResponse(result);
    }
  );

  // Tool: detect_circular_deps
  server.tool(
    'detect_circular_deps',
    'Detect circular import dependencies. Pass the project SOURCE ROOT as a directory for a full scan (scan is capped at depth 5 below rootPath, node_modules excluded — the response discloses the scanned scope, and hasCircularDeps:false only covers that scope). Returns each cycle with its file path and a fix recommendation. To show cycles visually afterwards: open_visualizer + visualize_batch with highlight (red, pulse) steps.',
    {
      rootPath: z.string().describe('Path to scan - can be a single file or a directory. If a directory, scans all .ts/.tsx/.js/.jsx files.')
    },
    async ({ rootPath }): Promise<McpResult> => {
      const result: DetectCircularDepsResult = detectCircularDeps(rootPath);
      return guardedResponse(result, {
        compactFn: (r: unknown) => {
          const d = r as DetectCircularDepsResult;
          const topCycles = d.circularDependencies.slice(0, 15).map(c => ({
            cycle: c.cycle,
            description: c.description,
            recommendation: c.recommendation
          }));
          return {
            hasCircularDeps: d.hasCircularDeps,
            totalCycles: d.circularDependencies.length,
            circularDependencies: topCycles,
            formattedOutput: d.formattedOutput?.slice(0, 3000) || '',
            totalFilesScanned: d.totalFilesScanned,
            _compacted: true,
            _note: `Showing top 15 of ${d.circularDependencies.length} cycles. Full paths omitted to reduce output size.`
          };
        }
      });
    }
  );

  // Tool: get_used_by
  server.tool(
    'get_used_by',
    'Find every component that imports the given component — its dependents / reverse dependency graph. Call this BEFORE modifying or renaming a component to measure blast radius; follow with get_prop_flow on affected edges. Scans the workspace root by default (depth ≤ 8, node_modules excluded) and the response reports the exact scope searched. An empty usedBy with workspace-root scope means genuinely unimported (a removal candidate); with a narrower searchDir it is inconclusive — widen and retry.',
    {
      componentPath: z.string().describe('Absolute path to the component file to find usages of'),
      searchDir: z.string().optional().describe('Directory to scan. Default: the workspace root (complete answer). Pass a subdirectory only to deliberately narrow the search — importers outside it will be missed.')
    },
    async ({ componentPath, searchDir }): Promise<{ content: [{ type: 'text'; text: string }] }> => {
      const result: GetUsedByResult = getUsedBy(componentPath, searchDir);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }]
      };
    }
  );

  // Tool: get_prop_flow
  server.tool(
    'get_prop_flow',
    'Trace how a prop flows from a source component down through its children, tracking renames and pass-through HOCs. An empty flow means the prop is missing, never forwarded, or forwarded through a pattern the tracer cannot follow (spreads into unknown components, render props, context) — the response note disambiguates; it does NOT prove the prop is unused. Visualize afterwards with visualize_trace_flow (flowType: "prop").',
    {
      sourceFile: z.string().describe('Absolute path to the source component file where the prop originates'),
      propName: z.string().describe('Name of the prop to trace through the component tree'),
      maxDepth: z.number().optional().describe('Maximum depth to trace. Default: 10')
    },
    async ({ sourceFile, propName, maxDepth }): Promise<{ content: [{ type: 'text'; text: string }] }> => {
      const result: GetPropFlowResult = getPropFlow(sourceFile, propName, maxDepth);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }]
      };
    }
  );

  // Tool: get_hook_deps
  server.tool(
    'get_hook_deps',
    'Analyze React hook dependencies in a component file. Returns details about useEffect, useMemo, useCallback, and other hooks including their dependency arrays, classified by source (prop, state, context, ref). Identifies potential issues like missing dependency arrays.',
    {
      filePath: z.string().describe('Absolute path to the React component file to analyze')
    },
    async ({ filePath }): Promise<{ content: [{ type: 'text'; text: string }] }> => {
      const result: GetHookDepsResult = getHookDeps(filePath);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }]
      };
    }
  );

  // Tool: get_navigation_structure
  server.tool(
    'get_navigation_structure',
    'Parse the declaratively-defined routing structure. Auto-detects: React Navigation, Expo Router, Next.js App Router, Next.js Pages Router, React Router v6/v7, Remix. Returns navigators + screens + a formatted tree, and names which framework was detected when nothing parses. KNOWN LIMIT: models route DEFINITIONS only — transitions made imperatively (navigate(), router.push()) are not edges, so the graph can under-report reachability (a warning flags this when detected). Pass the PROJECT ROOT directory, not a component file.',
    {
      rootPath: z.string().describe('Path to the root navigation/routing file or directory containing the project')
    },
    async ({ rootPath }): Promise<{ content: [{ type: 'text'; text: string }] }> => {
      const result: GetNavigationStructureResult = getNavigationStructure(rootPath);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }]
      };
    }
  );

  // Tool: get_context_map
  server.tool(
    'get_context_map',
    'Map React Context providers to their consumers: createContext(), Provider usage, useContext(), custom context hooks. Pass the project source root — the scan covers rootPath to depth 5 (node_modules excluded) and zero contexts outside that scope will be missed (the response note says what was scanned). NOT covered: Zustand/Redux/Jotai and other state libraries. Visualize afterwards with visualize_trace_flow (flowType: "context").',
    {
      rootPath: z.string().describe('Path to the root file or directory to scan for Context patterns')
    },
    async ({ rootPath }): Promise<McpResult> => {
      const result: GetContextMapResult = getContextMap(rootPath);
      return guardedResponse(result, {
        compactFn: (r: unknown) => {
          const d = r as GetContextMapResult;
          return {
            contexts: d.contexts.map(c => ({ name: c.name, file: c.filePath?.split('/').pop() })),
            providers: d.providers.map(p => ({ contextName: p.contextName, file: p.filePath?.split('/').pop(), wrapper: p.wrapperComponent })),
            consumers: d.consumers.slice(0, 30).map(c => ({ contextName: c.contextName, hookName: c.hookName, file: c.filePath?.split('/').pop(), component: c.componentName })),
            customHooks: d.customHooks.map(h => ({ hookName: h.hookName, contextName: h.contextName })),
            formattedTree: d.formattedTree,
            totalContexts: d.totalContexts,
            totalConsumers: d.totalConsumers,
            warnings: d.warnings,
            _compacted: true,
            _note: `Showing ${Math.min(d.consumers.length, 30)} of ${d.consumers.length} consumers. Hierarchy and full paths omitted to reduce output size.`
          };
        }
      });
    }
  );

  // Tool: get_screen_components
  server.tool(
    'get_screen_components',
    'Map which screens use which components in a React Native codebase. Identifies screens from navigation configuration, screens/ folder, or *Screen suffix. For each screen, traces component imports and builds a usage tree showing all components used. Use maxDepth to limit tree depth for large codebases.',
    {
      rootPath: z.string().describe('Path to the root file or directory to scan for screens and components'),
      screenName: z.string().optional().describe('Optional: filter to a specific screen by name (case-insensitive, partial match)'),
      maxDepth: z.number().optional().describe('Maximum depth to traverse component imports (default: 6, range: 1-12). Lower values produce smaller output for large codebases.')
    },
    async ({ rootPath, screenName, maxDepth }): Promise<McpResult> => {
      const result: GetScreenComponentsResult = getScreenComponents(rootPath, screenName, maxDepth);
      return guardedResponse(result, {
        compactFn: (r, fullSize) => {
          const res = r as GetScreenComponentsResult;
          return {
            totalScreens: res.totalScreens,
            screens: res.screens.map(s => ({
              name: s.screen.name,
              source: s.screen.source,
              totalComponents: s.totalComponents,
              maxDepth: s.maxDepth,
            })),
            formattedTree: res.formattedTree,
            warnings: [...res.warnings, `Output compacted (${(fullSize / 1024).toFixed(0)}KB full). Use screenName filter for detailed per-screen output.`],
          };
        }
      });
    }
  );

  // Tool: get_complexity_report
  server.tool(
    'get_complexity_report',
    'Score every component\'s complexity (1-10) from ITS OWN declaration span — lines, JSX depth, props, and hooks are counted per component, so co-located components in one file each get their own accurate score. Use threshold 5+ for moderate issues, 7+ for refactoring candidates. Scope: rootPath scanned to depth 5, node_modules excluded; unparseable files are reported in warnings rather than silently dropped.',
    {
      rootPath: z.string().describe('Path to scan for React components'),
      threshold: z.number().optional().describe('Minimum complexity score to include (default: 0)')
    },
    async ({ rootPath, threshold }): Promise<McpResult> => {
      const result: GetComplexityReportResult = getComplexityReport(rootPath, threshold);
      return guardedResponse(result, {
        compactFn: (r, fullSize) => {
          const res = r as GetComplexityReportResult;
          return {
            summary: res.summary,
            formattedReport: res.formattedReport,
            components: res.components.slice(0, 20),
            warnings: [...res.warnings, `Output compacted (${(fullSize / 1024).toFixed(0)}KB full). Use threshold parameter to filter by complexity score.`],
          };
        }
      });
    }
  );

  // Tool: get_rerender_risks
  server.tool(
    'get_rerender_risks',
    'Detect React re-render anti-patterns: inline objects/arrays/functions in JSX props, missing useCallback/useMemo. Returns risks by file with severity, line, and fix suggestions. Modern-React aware: when the project uses React Compiler, memoization findings are auto-downgraded to low (the compiler handles them — do NOT add manual memoization there); "use server" files are skipped (server code never re-renders); <form action> handlers are not flagged (React 19 idiom). Read the warnings field — it states every adjustment made.',
    {
      rootPath: z.string().describe('Path to scan — a single file or directory of React components'),
      minSeverity: z.enum(['low', 'medium', 'high']).optional().describe('Minimum severity to include. Default: all severities')
    },
    async ({ rootPath, minSeverity }): Promise<McpResult> => {
      const result: GetRerenderRisksResult = getRerenderRisks(rootPath, minSeverity);
      return guardedResponse(result, {
        compactFn: (r, fullSize) => {
          const res = r as GetRerenderRisksResult;
          // Strip per-risk details, keep only file-level summary
          const compactFiles = res.files
            .filter(f => f.riskCount > 0)
            .slice(0, 20)
            .map(f => ({ file: f.file, componentName: f.componentName, riskCount: f.riskCount, hasMemo: f.hasMemo }));
          return {
            summary: res.summary,
            formattedReport: res.formattedReport,
            files: compactFiles,
            warnings: [...res.warnings, `Output compacted (${(fullSize / 1024).toFixed(0)}KB full). Use minSeverity parameter to filter by severity, or pass a single file path for full details.`],
          };
        }
      });
    }
  );

  // ============================================================================
  // Visualization Tools (require VS Code extension context)
  // ============================================================================

  // Tool: open_visualizer
  server.tool(
    'open_visualizer',
    'Open the Dendro visualizer webview in VS Code. Call this ONCE before visualize_batch or visualize_analysis (they can also auto-open by passing an entryFile param). The response reports the parsed tree size — a 1-2 node tree means the entry file is likely a wrapper/layout; pick a higher-fan-out entry instead.',
    {
      entryFile: z.string().describe('Absolute path to the entry React component file (e.g., /path/to/App.tsx)')
    },
    async ({ entryFile }): Promise<{ content: [{ type: 'text'; text: string }] }> => {
      const result: OpenVisualizerResult = await openVisualizer(entryFile);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }]
      };
    }
  );

  // Tool: visualize_batch
  server.tool(
    'visualize_batch',
    'Execute multiple visualization commands in sequence. ALWAYS use this instead of calling individual viz tools in sequence. Each command has a type, payload, and optional label (shown in the control bar). Set waitForUser: true so users can use Back/Next/Skip buttons to control pacing — this is the default for workflow visualizations. Always include a label on each command describing what it does.',
    {
      commands: z.array(z.object({
        type: z.enum(['highlight', 'zoom', 'annotate', 'traceFlow', 'clear', 'expand', 'collapse', 'fitAll']).describe('Command type'),
        payload: z.record(z.string(), z.unknown()).optional().describe('Command payload (same fields as individual tool)'),
        label: z.string().optional().describe('Human-readable step description shown in control bar (e.g., "Highlighting complexity hotspots"). Auto-generated from command type if omitted.')
      })).describe('Array of visualization commands to execute sequentially'),
      waitForUser: z.boolean().optional().describe('Show a "Next" button between commands so user controls pacing. Recommended: true for presentations and audits.'),
      delay: z.number().optional().describe('Auto-play delay between commands in ms (only used when waitForUser is false). Default: 800.'),
      entryFile: z.string().optional().describe('Entry file path — if provided and no visualizer is open, auto-opens one'),
      sessionId: z.string().optional().describe('Target specific visualizer session')
    },
    async ({ commands, waitForUser, delay, entryFile, sessionId }): Promise<{ content: [{ type: 'text'; text: string }] }> => {
      const result: VisualizeBatchResult = visualizeBatch(commands, { sessionId, delay, waitForUser, entryFile });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }]
      };
    }
  );

  // Tool: start_tour — SHELVED (D3/React DOM conflict, see .dev/bugs/TOUR-BUG-REPORT.md)
  // Re-enable when Bug 3 (removeChild) is resolved. Implementation in tools.ts is intact.
  // server.tool('start_tour', ...);

  // ============================================================================
  // Pro Tools — conditionally loaded via DefinePlugin
  // When DENDRO_INCLUDE_PRO=false (free build), webpack eliminates this block
  // and all transitive Pro dependencies from the bundle.
  // ============================================================================
  if (DENDRO_INCLUDE_PRO) {
    const { registerProTools } = require('./pro-registry');
    registerProTools(server);
  }

  // ============================================================================
  // Runtime Tools (FREE — read from cross-process state bridge)
  // ============================================================================

  // Tool: get_runtime_status
  server.tool(
    'get_runtime_status',
    'Check runtime connection status. MUST call this first before get_live_tree, get_runtime_state, or any live introspection tools. Returns connection status, component count, and setup instructions if disconnected.',
    {},
    async (): Promise<{ content: [{ type: 'text'; text: string }] }> => {
      const state = readRuntimeState();

      if (!state || state.status === 'disconnected') {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'disconnected',
              componentCount: 0,
              message: 'No running React Native app is connected.',
              instructions: [
                '1. Make sure your React Native app is running in a simulator/emulator or on a device.',
                '2. The app must have React DevTools support enabled (default in dev mode).',
                '3. Run "Dendro React: Connect to Running App" (Cmd+Shift+P) to start listening on port 8097.',
                '4. The app should auto-connect when it detects the DevTools server.',
                '5. Check the VS Code status bar for "Dendro React: Connected" confirmation.',
              ],
              troubleshooting: {
                expo_port_conflict: 'Expo DevTools also uses port 8097. If you see EADDRINUSE errors, quit Metro/Expo DevTools first, then retry "Dendro React: Connect to Running App". Or set dendro-react.runtimePort to 8098 and start your app with REACT_DEVTOOLS_PORT=8098.',
                auto_start_disabled: 'dendro-react.autoStartRuntime defaults to false to avoid port conflicts with Expo. You must manually connect each session.',
                android_emulator: 'Android emulators need port forwarding. Dendro runs "adb reverse tcp:8097 tcp:8097" automatically when platform is set to android.',
              }
            }, null, 2)
          }]
        };
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: state.status,
            componentCount: state.componentCount,
            rootCount: state.roots.length,
            lastUpdated: new Date(state.timestamp).toISOString(),
            sourceMappedComponents: Object.keys(state.sourceMap).length,
          }, null, 2)
        }]
      };
    }
  );

  // Tool: get_live_tree
  server.tool(
    'get_live_tree',
    'Get the live component tree from a connected React Native app. Call get_runtime_status first to verify connection. Returns the full hierarchy as currently rendered, including component types and parent-child relationships.',
    {
      rootComponent: z.string().optional().describe('Filter to a specific root component by display name'),
      maxDepth: z.number().optional().describe('Maximum depth to return. Default: unlimited'),
      includeNative: z.boolean().optional().default(true).describe('Include native/host components like View, Text. Default: true')
    },
    async ({ rootComponent, maxDepth, includeNative }): Promise<{ content: [{ type: 'text'; text: string }] }> => {
      const state = readRuntimeState();

      if (!state || state.status === 'disconnected') {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'not_connected',
              message: 'No running React Native app is connected. Use get_runtime_status for instructions.'
            }, null, 2)
          }]
        };
      }

      // Build element lookup
      const sourceMap = state.sourceMap;
      const elementMap = new Map<number, SerializedRuntimeComponent>();
      for (const el of state.elements) {
        elementMap.set(el.id, el);
      }

      // Filter and build tree
      type TreeNode = {
        id: number;
        displayName: string;
        type: string;
        key: string | null;
        sourceFile: string | null;
        children: TreeNode[];
      };

      /**
       * Collect tree nodes from a subtree. If the node itself is filtered out
       * (e.g. native/host when includeNative=false), its children are returned
       * instead, re-parented to the caller's level.
       */
      function collectTreeNodes(id: number, depth: number): TreeNode[] {
        const el = elementMap.get(id);
        if (!el) return [];
        if (maxDepth !== undefined && depth > maxDepth) return [];

        const children: TreeNode[] = [];
        for (const childId of el.children) {
          const childNodes = collectTreeNodes(childId, depth + 1);
          children.push(...childNodes);
        }

        // Skip native/host components but promote their children
        if (includeNative === false && el.type === 'host') {
          return children;
        }

        return [{
          id: el.id,
          displayName: el.displayName,
          type: el.type,
          key: el.key,
          sourceFile: sourceMap[el.displayName] || null,
          children,
        }];
      }

      const roots: TreeNode[] = [];
      for (const rootId of state.roots) {
        const rootEl = elementMap.get(rootId);
        if (rootComponent && rootEl?.displayName !== rootComponent) continue;
        const nodes = collectTreeNodes(rootId, 0);
        roots.push(...nodes);
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'connected',
            componentCount: state.componentCount,
            roots,
          }, null, 2)
        }]
      };
    }
  );

  // Tool: get_runtime_state
  server.tool(
    'get_runtime_state',
    'Find a component in the live runtime tree by name. Call get_runtime_status first to verify connection. Returns source file path, parent, children, and position in the live tree.',
    {
      componentName: z.string().describe('Display name of the component to find (case-insensitive, partial match)'),
      includeChildren: z.boolean().optional().default(true).describe('Include direct children in the response. Default: true')
    },
    async ({ componentName, includeChildren }): Promise<{ content: [{ type: 'text'; text: string }] }> => {
      const state = readRuntimeState();

      if (!state || state.status === 'disconnected') {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'not_connected',
              message: 'No running React Native app is connected. Use get_runtime_status for instructions.'
            }, null, 2)
          }]
        };
      }

      const searchLower = componentName.toLowerCase();
      const matches = state.elements.filter(el =>
        el.displayName.toLowerCase().includes(searchLower)
      );

      if (matches.length === 0) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              matches: [],
              message: `No components matching "${componentName}" found in the live tree.`,
              totalComponents: state.componentCount,
            }, null, 2)
          }]
        };
      }

      // Build element lookup for children
      const elementMap = new Map<number, SerializedRuntimeComponent>();
      for (const el of state.elements) {
        elementMap.set(el.id, el);
      }

      const results = matches.map(el => {
        const parent = el.parentId !== null ? elementMap.get(el.parentId) : null;
        const children = includeChildren
          ? el.children.map(childId => {
              const child = elementMap.get(childId);
              return child ? { id: child.id, displayName: child.displayName, type: child.type } : null;
            }).filter(Boolean)
          : undefined;

        return {
          id: el.id,
          displayName: el.displayName,
          type: el.type,
          key: el.key,
          depth: el.depth,
          sourceFile: state.sourceMap[el.displayName] || null,
          parent: parent ? { id: parent.id, displayName: parent.displayName } : null,
          children,
          childCount: el.children.length,
        };
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            matches: results,
            totalMatches: results.length,
            totalComponents: state.componentCount,
          }, null, 2)
        }]
      };
    }
  );

  // Tool: get_context_pack (TICKET-061)
  server.tool(
    'get_context_pack',
    'Whole-repo orientation in one dense CTX-PACK/0.1 text block (~200-400 tokens): directory rollups with lines-of-code and 6-month commit heat, the largest and hottest files, cross-directory import edges, and entry-point candidates. The header declares the row schema (D dir, F file, E edge, X entry), so the block is self-describing. Call this FIRST in a new repo — it replaces several exploratory listings with one read. Git unavailable degrades honestly (heat columns 0, noted in a comment).',
    {
      rootPath: z.string().optional().describe('Directory to pack (e.g. the project\'s src/). Default: the workspace root.'),
      topFiles: z.number().optional().describe('How many largest files get F rows (default 10). Files with 3+ recent commits are always included.')
    },
    async ({ rootPath, topFiles }): Promise<McpResult> => {
      const root = rootPath
        ? assertPathInWorkspace(rootPath, 'rootPath')
        : (getWorkspaceRoot() ?? process.cwd());
      const result = buildContextPack(root, topFiles);
      return {
        content: [{ type: 'text', text: `${result.pack}\n\n${JSON.stringify({ stats: result.stats, warnings: result.warnings })}` }]
      };
    }
  );

  // Tool: get_usage_guide
  server.tool(
    'get_usage_guide',
    'Get recommended workflows, tool categories, sequencing rules, and tips for using Dendro MCP effectively. Call this once at the start of a session to learn how to use the 36 available tools. Returns structured JSON with workflow recipes and best practices.',
    {},
    async (): Promise<{ content: [{ type: 'text'; text: string }] }> => {
      const guide = getUsageGuide();
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(guide, null, 2)
        }]
      };
    }
  );

  // Tool: submit_feedback
  server.tool(
    'submit_feedback',
    'Send a feedback debrief about Dendro to its maker. REQUIRES EXPLICIT USER CONSENT — this is the only Dendro tool that sends anything off-machine, so ask first, every time. Make the invitation warm, not clinical, e.g.: "Want me to send a quick feedback note to Dendro\'s maker? It\'s a short debrief of what worked and what fumbled this session — it directly shapes what gets fixed. Nothing is sent unless you say yes, and it never includes your code or file paths." Offer it when tools errored or the user voices an opinion about Dendro; never call it on your own initiative. What is sent: exactly the fields you pass, plus server version, platform, and per-tool call/error counts (tool names only — no error text, no file paths, no code). Write the debrief the way you would for a colleague: honest fumbles AND honest hooks.',
    {
      userConsented: z.boolean().describe('MUST be true, and only after the user explicitly agreed in this conversation. Passing true without asking the user is a violation of their trust.'),
      summary: z.string().describe('2-5 sentence honest overall assessment of using Dendro this session'),
      fumbles: z.array(z.string()).optional().describe('Retries, wrong guesses, confusing responses, dead ends — most valuable field'),
      hooks: z.array(z.string()).optional().describe('Moments the tooling genuinely helped or impressed'),
      wouldReuseUnprompted: z.boolean().optional().describe('Would you reach for Dendro again for a future task in this repo without being told to?'),
      unansweredQuestions: z.array(z.string()).optional().describe('THE HIGHEST-VALUE FIELD: React/React Native questions you WANTED answered about this codebase but Dendro could not answer — where you fell back to reading files, grepping, or guessing. Absence is invisible from the maker\'s side, so name it: "I wanted to know X and had to read N files to find out". Include questions no tool asked you to consider.'),
      contact: z.string().optional().describe('Optional contact handle IF the user wants a reply (never fill this without the user providing it)')
    },
    async ({ userConsented, summary, fumbles, hooks, wouldReuseUnprompted, unansweredQuestions, contact }): Promise<McpResult> => {
      const result = await submitFeedback({ userConsented, summary, fumbles, hooks, wouldReuseUnprompted, unansweredQuestions, contact });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
      };
    }
  );

  // ============================================================================
  // Composite Agent Tools (TICKET-042)
  // ============================================================================

  // Tool: analyze_codebase
  server.tool(
    'analyze_codebase',
    'Comprehensive codebase analysis in one call. Runs get_component_tree + get_complexity_report + get_context_map + detect_circular_deps and returns a combined report with summary. Use this instead of calling 4 tools separately. Pass the entry file (e.g., App.tsx) and optionally a root path for directory-level scans.',
    {
      entryFile: z.string().describe('Absolute path to the entry React component file (e.g., /path/to/App.tsx)'),
      rootPath: z.string().optional().describe('Root directory for complexity/context/deps scanning. Defaults to the entry file\'s directory.')
    },
    async ({ entryFile, rootPath }): Promise<McpResult> => {
      const result: AnalyzeCodebaseResult = analyzeCodebase(entryFile, rootPath);
      return guardedResponse(result, {
        compactFn: (r, fullSize) => {
          const res = r as AnalyzeCodebaseResult;
          return {
            summary: res.summary,
            tree: { totalComponents: res.tree?.stats?.totalComponents, maxDepth: res.tree?.stats?.maxDepth },
            complexity: res.complexity ? {
              totalComponents: res.complexity.summary?.totalComponents,
              averageScore: res.complexity.summary?.average,
              topComponents: res.complexity.components?.slice(0, 10),
            } : undefined,
            context: res.context ? {
              totalContexts: res.context.totalContexts,
              totalConsumers: res.context.totalConsumers,
              contexts: res.context.contexts?.map((c) => ({ name: c.name, variableName: c.variableName })),
            } : undefined,
            circularDeps: res.circularDeps,
            warnings: [`Output compacted (${(fullSize / 1024).toFixed(0)}KB full). Use individual tools for detailed per-analysis output.`],
          };
        }
      });
    }
  );

  // Tool: quick_audit
  server.tool(
    'quick_audit',
    'Quick health check for a React codebase. Returns top 5 most complex components, circular dependencies, prop-drilling candidates (5+ props), heavy context providers, effect-hygiene findings (leaked subscriptions/timers without cleanup, state mirrored via effects), unused files nothing imports (dead code — verify before deleting), and an overall health grade (A-F). Baseline support: baseline:"update" records current issues as known; subsequent audits then report NEW issues separately (gate CI on those, not the backlog).',
    {
      rootPath: z.string().describe('Root directory to audit (e.g., /path/to/src/)'),
      baseline: z.enum(['compare', 'update', 'off']).optional().describe('Known-issues baseline at <rootPath>/.dendro/audit-baseline.json. "compare" (default): if a baseline exists, split findings into known vs NEW. "update": write the current findings as the new baseline. "off": ignore any baseline.')
    },
    async ({ rootPath, baseline }): Promise<McpResult> => {
      const result: QuickAuditResult = quickAudit(rootPath, baseline);
      return guardedResponse(result, {
        compactFn: (r: unknown) => {
          const d = r as QuickAuditResult;
          return {
            topComplexComponents: d.topComplexComponents,
            circularDeps: {
              found: d.circularDeps.found,
              count: d.circularDeps.count,
              cycles: d.circularDeps.cycles.slice(0, 10).map(c => ({
                cycle: c.cycle,
                description: c.description
              }))
            },
            propDrillingCandidates: d.propDrillingCandidates,
            heavyContextProviders: d.heavyContextProviders,
            rerenderRisks: d.rerenderRisks,
            healthSummary: d.healthSummary,
            errors: d.errors,
            _compacted: true,
            _note: d.circularDeps.count > 10 ? `Showing 10 of ${d.circularDeps.count} circular dependency cycles. Full paths omitted.` : undefined
          };
        }
      });
    }
  );

  // Tool: visualize_analysis
  server.tool(
    'visualize_analysis',
    'Open the visualizer and auto-highlight based on analysis focus. Combines open_visualizer + analysis + highlight + annotate + zoom into one call. Focus options: "complexity" (red/orange highlights with scores), "deps" (circular dependency cycles in red with pulse), "context" (providers in purple), "performance" (re-render risks in orange), "all" (everything). Requires VS Code extension.',
    {
      entryFile: z.string().describe('Absolute path to the entry React component file (e.g., /path/to/App.tsx)'),
      focus: z.enum(['complexity', 'deps', 'context', 'performance', 'all']).optional().describe('Analysis focus to visualize. Default: "all"')
    },
    async ({ entryFile, focus }): Promise<{ content: [{ type: 'text'; text: string }] }> => {
      const result: VisualizeAnalysisResult = await visualizeAnalysis(entryFile, focus);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }]
      };
    }
  );

  // ============================================================================
  // Workflow Tools — Persona-Guided Analysis (returns instructions for the agent)
  // ============================================================================

  // Consolidated persona workflows. The five run_* tools were structurally
  // identical (same schema, static prompt string) and tripled tool-selection
  // noise; one tool with a persona enum carries the same five playbooks.
  const WORKFLOW_PROMPTS: Record<string, { summary: string; build: (entryFile: string) => string }> = {
    audit: {
      summary: 'Deep technical audit of a React codebase. Returns step-by-step instructions for analyzing complexity hotspots, circular deps, state management, prop drilling, and producing an actionable report with visualizations. Follow the returned instructions in order.',
      build: (entryFile: string): string => `You are conducting a deep technical audit of this React codebase.
Analyze "${entryFile}" and produce a comprehensive report.

## Pre-flight
Your FIRST action must be to call quick_audit with entryFile "${entryFile}".
If the tool call fails, STOP and tell the user: "The Dendro MCP server is not responding. Check your MCP configuration."

## IMPORTANT: Use ONLY Dendro MCP tools. Do NOT fall back to grep, find, bash, ls, wc, or manual file reads. Those tools cannot replicate what Dendro's parsers do.

## Analysis Steps (call in order — each informs the next)
1. quick_audit with entryFile "${entryFile}" — get health grade and top issues
2. get_component_tree — full hierarchy with stats
3. get_complexity_report (threshold: 5) — components above moderate complexity
4. detect_circular_deps — all cycles with paths
5. get_context_map — state management assessment
6. get_hook_deps on the top 3 highest-complexity components from step 3
7. get_prop_flow on the top 3 most-used props from step 1

Wait for each tool result before proceeding. Do NOT parallelize tool calls.

## Visualization (do this BEFORE writing the report)
First, explain to the user what you're about to visualize and why — describe which components will be highlighted, what the colors mean, and what patterns to look for. THEN send the visualization commands.

IMPORTANT: Use visualize_batch for ALL visualization after opening — one call, an array of commands (highlight, zoom, annotate, traceFlow, clear, fitAll). There are no per-step viz tools.

1. open_visualizer with entryFile "${entryFile}" — call EXACTLY ONCE. Do NOT call open_visualizer again — it creates a new panel each time.
2. After the tree renders, narrate what you see, then call visualize_batch with waitForUser: true and all remaining ops in one call. Include a label on each command:
   - highlight complexity > 7 in red, pulse: true (label: "Critical complexity hotspots (score > 7)")
   - highlight complexity 5-6 in orange (label: "Moderate complexity warnings (score 5-6)")
   - annotate the top 5 flagged components with their complexity scores (label: "Annotating top 5 flagged components")
   - if circular deps found, trace_flow them (label: "Circular dependency cycles")
   - fit_all to show the full picture (label: "Full tree overview")
The user will see Back/Next/Skip buttons to step through each visualization at their own pace.

## Report — SYNTHESIZE, don't dump raw JSON
DO NOT paste raw JSON output from tool calls. Synthesize findings into a concise, readable report.
Keep the full report under 800 words. Use tables and bullet points, not walls of text.

1. **Executive Summary** (3-4 sentences) — grade, component count, top concern
2. **Complexity Hotspots** — table: component | score | why | recommendation (top 5 only)
3. **Circular Dependencies** — each cycle with one-line fix
4. **State Management** — context count, heaviest providers, missing memoization
5. **Prop Drilling** — worst offenders with prop counts (top 5)
6. **Action Items** — numbered list, 3-5 items, ordered by impact

## Tone: Direct, technical, actionable. Every finding has a specific recommendation. Use relative paths from project root.`
    },
    sprint_check: {
      summary: 'Quick codebase health check for engineering managers reviewing sprint health. Returns instructions for a concise under-200-word assessment with trend tracking. Follow the returned instructions in order.',
      build: (entryFile: string): string => `You are generating a quick codebase health check for an engineering manager reviewing sprint health.
Analyze "${entryFile}" concisely.

## Analysis Steps (call in order)
1. get_complexity_report (threshold 5) — what's above moderate
2. detect_circular_deps — count only
3. compare_snapshots (current vs latest saved) — trend. If compare_snapshots is not available (Pro feature), skip trend analysis and note "Trend data requires Pro license."
4. find_components_by_type — class vs functional ratio

## Output (keep under 200 words)
- Health: GREEN/YELLOW/RED with one sentence
- Components above threshold 5: count and names
- Circular deps: count (new since last snapshot? flag it)
- Complexity trend: improving, stable, or degrading (or "requires Pro" if unavailable)
- Class components remaining: count
- One recommended action for this sprint

## Visualization
After analysis, show the health visually.

IMPORTANT: Use visualize_batch for ALL visualization after opening — one call, an array of commands (highlight, zoom, annotate, traceFlow, clear, fitAll). There are no per-step viz tools.

- open_visualizer with entryFile "${entryFile}" — call EXACTLY ONCE
- After the tree renders, narrate what you see, then call visualize_batch with waitForUser: true and all remaining ops in one call. Include a label on each command:
  - highlight components above threshold in red (label: "Flagging high-complexity components")
  - highlight circular dep participants in orange (label: "Circular dependency participants")
  - fit_all (label: "Full tree overview")
The user will see Back/Next/Skip buttons to step through each visualization at their own pace.

## Tone: Sprint retrospective style. Numbers with colored indicators. Actionable, not descriptive.`
    },
    ceo_briefing: {
      summary: 'Jargon-free architecture briefing for a non-technical CEO. Returns instructions for producing a plain-English summary with health grade, key numbers, and risks in business terms. Follow the returned instructions in order.',
      build: (entryFile: string): string => `You are presenting a technical architecture briefing to a non-technical CEO.
Use Dendro's MCP tools to analyze the React codebase at "${entryFile}" and deliver a clear, jargon-free summary.

## Steps (call in order)
1. get_component_tree — understand app structure
2. get_complexity_report — identify risk areas
3. get_context_map — understand data architecture
4. get_navigation_structure — navigation layout

## What to Present
- One-paragraph summary: What this app is, in plain English
- Health grade: A-F with one-sentence explanation
- Key numbers: screen count, component count, critical components
- Top 3 risks: In BUSINESS terms ("this area is hard to change" not "cyclomatic complexity is 8")
- One concrete recommendation

## Rules
- No code snippets
- No jargon (no "hooks," "props," "state management," "memoization")
- Use analogies ("Think of Context like a company-wide announcement system")
- Keep it under 500 words
- If export_mermaid is available, generate a simplified architecture diagram (max 10 nodes)

## Visualization
Show the CEO what the app looks like structurally.

IMPORTANT: Use visualize_batch for ALL visualization after opening — one call, an array of commands (highlight, zoom, annotate, traceFlow, clear, fitAll). There are no per-step viz tools.

- open_visualizer with entryFile "${entryFile}" — call EXACTLY ONCE
- After the tree renders, narrate what you see in plain English, then call visualize_batch with waitForUser: true and all remaining ops in one call. Include a label on each command:
  - highlight the main screens/pages in green (label: "Main screens of the app")
  - highlight risk areas in red (label: "Areas that need attention")
  - fit_all (label: "Full application overview")
The user will see Back/Next/Skip buttons to step through each visualization at their own pace.`
    },
    investor_scorecard: {
      summary: 'Standardized technical due diligence scorecard for VCs and investors. Returns instructions for a 6-category health assessment on a 100-point scale with A-F grades. Follow the returned instructions in order.',
      build: (entryFile: string): string => `You are generating a technical due diligence scorecard for a VC or investor evaluating this React codebase.
Analyze "${entryFile}" and produce a standardized health assessment.

## Analysis Steps (call in order)
1. get_component_tree — size and structure
2. get_complexity_report (threshold 0) — full distribution
3. detect_circular_deps — structural integrity
4. get_context_map — architecture maturity
5. find_components_by_type — modernity (functional vs class ratio)
6. get_navigation_structure — app structure
7. get_hook_deps on complexity > 6 components — code correctness
8. list_snapshots + compare_snapshots — engineering discipline. If these tools are not available (Pro feature), score Engineering Discipline based on available data and note "Snapshot history requires Pro license."

## Scorecard Categories (100-point scale each)
1. **Architecture Health (25%)** — modularity, circular deps, depth, context fan-out
2. **Component Complexity (20%)** — distribution, median, max, critical count
3. **Data Flow Clarity (15%)** — prop chain depth, hook dep completeness, context efficiency
4. **Codebase Modernization (10%)** — functional vs class ratio, hook adoption
5. **Structural Debt (15%)** — refactoring candidates, complexity trend, orphan components
6. **Engineering Discipline (15%)** — snapshot history, trend direction, documentation

## Output Format
- Overall grade (A-F) with 0-100 score
- Per-category score with bar visualization
- Red flags section (bullet list of concerns)
- Green flags section (bullet list of strengths)
- Recommendations (3-5 prioritized actions)
- Explicit "NOT AVAILABLE" for: test coverage, security, dependency health, bus factor

## Visualization
Show the architecture visually to support the scorecard.

IMPORTANT: Use visualize_batch for ALL visualization after opening — one call, an array of commands (highlight, zoom, annotate, traceFlow, clear, fitAll). There are no per-step viz tools.

- open_visualizer with entryFile "${entryFile}" — call EXACTLY ONCE
- After the tree renders, narrate what you see, then call visualize_batch with waitForUser: true and all remaining ops in one call. Include a label on each command:
  - highlight high-complexity components in red (label: "Complexity hotspots — structural debt")
  - highlight circular dep cycles in orange (label: "Circular dependencies — architecture risk")
  - highlight context providers in purple (label: "Data flow architecture")
  - annotate the worst offender with its score (label: "Highest-risk component")
  - fit_all (label: "Full codebase overview")
The user will see Back/Next/Skip buttons to step through each visualization at their own pace.

## Tone: Due diligence professional. Risk-calibrated. Quantified. Business impact framing.`
    },
    dev_onboarding: {
      summary: 'Progressive codebase walkthrough for a new React developer joining the team. Returns instructions for a guided tour from high-level navigation down to complexity hotspots, with visualization. Follow the returned instructions in order.',
      build: (entryFile: string): string => `You are onboarding a new React developer to this codebase. Walk them through the architecture progressively — start high-level and get more detailed.
Use Dendro's MCP tools to analyze "${entryFile}".

## Steps (in order — each step builds on the previous)
1. get_navigation_structure — "Here's how the app is organized into screens"
2. get_screen_components — "Each screen uses these components"
3. get_context_map — "Data flows through these context providers"
4. get_complexity_report (threshold 5) — "These are the complex areas you should understand first"
5. detect_circular_deps — "Watch out for these known structural issues"

## For each step:
- Explain WHAT it means, not just the raw data
- Point out patterns: "Notice how all auth-related components are grouped under screens/auth/"
- Highlight things a new dev should know: "The OrderContext is the most important context — it's used by 8 screens"
- Give practical advice: "If you need to change user state, start in AuthContext at src/contexts/AuthContext.tsx"

## After all steps:
Explain to the user what the visualization will show — what the colors mean and which areas to focus on.

IMPORTANT: Use visualize_batch for ALL visualization after opening — one call, an array of commands (highlight, zoom, annotate, traceFlow, clear, fitAll). There are no per-step viz tools.

- open_visualizer with entryFile "${entryFile}" — call EXACTLY ONCE
- After the tree renders, narrate what you see, then call visualize_batch with waitForUser: true and all remaining ops in one call. Include a label on each command:
  - highlight entry points in green (label: "App entry points")
  - highlight high-complexity components in orange/red (label: "Complex areas to learn first")
  - highlight context providers in purple (label: "Data flow — context providers")
  - zoom to the most important area (label: "Key area to focus on")
The user will see Back/Next/Skip buttons to step through each visualization at their own pace.

## Tone: Welcoming, not intimidating. "Here's what you need to know" not "here's everything." Technical but not overwhelming.`
    },
  };

  server.tool(
    'run_workflow',
    'Guided persona-driven analysis playbooks. Returns step-by-step instructions to follow IN ORDER (do not parallelize the tool calls it prescribes). Personas: audit (deep technical audit for React developers), sprint_check (under-200-word health check for engineering managers), ceo_briefing (jargon-free architecture briefing), investor_scorecard (6-category technical due diligence), dev_onboarding (progressive walkthrough for developers joining the project).',
    {
      persona: z.enum(['audit', 'sprint_check', 'ceo_briefing', 'investor_scorecard', 'dev_onboarding']).describe('Which playbook to run'),
      entryFile: z.string().describe('Absolute path to the entry React component file (e.g., /path/to/App.tsx)')
    },
    async ({ persona, entryFile }): Promise<McpResult> => ({
      content: [{ type: 'text', text: WORKFLOW_PROMPTS[persona].build(entryFile) }]
    })
  );





  // Tool: get_usage_stats
  server.tool(
    'get_usage_stats',
    'Show local tool usage statistics. Returns invocation counts, first/last used timestamps for each tool. Data is stored locally in ~/.dendro/telemetry.json and never leaves the machine.',
    {},
    async (): Promise<McpResult> => {
      const stats = getUsageStats();
      return { content: [{ type: 'text', text: JSON.stringify({ build: getBuildInfo(), ...stats }, null, 2) }] };
    }
  );

  return server;
}

