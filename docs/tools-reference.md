# Dendro React — Tools Reference

Full reference for all 36 MCP tools. Your AI assistant discovers these automatically via `get_usage_guide` — you don't need to memorize them.

## Large analysis responses

`get_component_tree`, `analyze_codebase`, `get_component_contract`,
`get_modified_components`, `detect_circular_deps`, `get_context_map`,
`get_screen_components`, `get_complexity_report`, `get_rerender_risks` and
`quick_audit` return valid JSON within 40,000 characters, including metadata.
This is a response-size limit, not a limit on how much source is analyzed.

Large responses include `_output.partial: true`. Its `omissions` list identifies
reduced collections/text with original and returned counts; `omissionDetailsOmitted`
counts additional omission records beyond the first 24. Paths use JSON Pointer;
exceptionally long labels have `pathTruncated: true`. Formatted text reports may
be empty when their structured data is retained. Full analysis statistics and
summaries describe the requested scope, while `_output.tree` counts the displayed
tree nodes. An omitted collection is not evidence that there are no findings.

Tree previews retain up to three levels and 60 nodes, subject to the final size
limit. Each node's `absolutePath` is an exact locator. To expand a branch, call
`get_component_tree` with that path as `entryFile` and `maxDepth: 2`, or use
`get_component_details` with that path as `filePath`. The composite keeps its
tree and supplies concrete `_output.followUp` calls for individual analyses.
For other large results, narrow the file/directory or use the tool's filters.
Small responses keep their existing shape; JSON whitespace may be removed when
that alone is enough to fit the budget.

## Getting Started (3 tools)

| Tool | What it does |
|------|-------------|
| `get_usage_guide` | Get recommended workflows, tool categories, sequencing rules, and tips for using Dendro MCP effectively. |
| `get_usage_stats` | Show local tool usage statistics. |
| `get_context_pack` | Whole-repo orientation in one dense CTX-PACK/0.1 text block (~200-400 tokens): directory rollups with lines-of-code and 6-month commit heat, the largest and … |

## Composite (6 tools)

| Tool | What it does |
|------|-------------|
| `analyze_codebase` | Comprehensive codebase analysis in one call. |
| `quick_audit` | Quick health check for a React codebase. |
| `visualize_analysis` | Open the visualizer and auto-highlight based on analysis focus. |
| `run_workflow` | Guided persona-driven analysis playbooks. |
| `get_component_contract` | Call this BEFORE editing a component — its full contract in one call: props (from the TypeScript type when resolvable, destructuring otherwise), state variab… |
| `get_modified_components` | What changed, as components: every file changed vs a git ref (default HEAD — uncommitted work; pass base:"main" for PR scope) with the components each declares. |

## Static Analysis (13 tools)

| Tool | What it does |
|------|-------------|
| `get_component_tree` | Start here for structure. |
| `get_component_details` | Get detailed info about a single React component file: type (functional/class), state variables, imports, and direct children. |
| `detect_circular_deps` | Detect circular import dependencies. |
| `get_used_by` | Find every component that imports the given component — its dependents / reverse dependency graph. |
| `get_prop_flow` | Trace how a prop flows from a source component down through its children, tracking renames and pass-through HOCs. |
| `get_hook_deps` | Analyze React hook dependencies in a component file. |
| `get_navigation_structure` | Parse the declaratively-defined routing structure. |
| `get_context_map` | Map React Context providers to their consumers: createContext(), Provider usage, useContext(), custom context hooks. |
| `get_screen_components` | Map which screens use which components in a React Native codebase. |
| `get_complexity_report` | Score every component's complexity (1-10) from ITS OWN declaration span — lines, JSX depth, props, and hooks are counted per component, so co-located compone… |
| `get_rerender_risks` | Detect React re-render anti-patterns: inline objects/arrays/functions in JSX props, missing useCallback/useMemo. |
| `find_state_owner` | Find which component(s) own a given state variable by name. |
| `batch_analysis` | Run multiple analyses across multiple entry files in one call. |

## Visualization (3 tools)

| Tool | What it does |
|------|-------------|
| `open_visualizer` | Open the Dendro visualizer webview in VS Code. |
| `visualize_batch` | Execute sequential visual commands and return per-command node matches and rendered results; query an existing request's status. |
| `export_analysis` | Export Dendro analysis in one of four formats: "mermaid" (flowchart syntax for docs), "json" (enriched multi-analysis document), "svg" (color-coded diagram i… |

### Batch acknowledgments (0.9.3+)

`visualize_batch` accepts 1–100 commands and waits up to `timeoutMs` (default
10,000; range 100–30,000). `success: true` means every command was acknowledged
as rendered with no missing targets. Each result includes its original `index`,
`commandType`, `success`, `rendered`, `matched` and `notFound` selectors where
applicable. Exact source paths are preferred; ambiguous basenames fail rather
than choosing an arbitrary node.

With `waitForUser: true`, the tool returns `waiting_for_user` after the first
rendered step. Failed steps are reported and advance to the next step. Back
replays the earlier prefix; Next advances; Skip returns `skipped`. Pending
steps have not been acknowledged. Starting another batch cancels the old one
with `superseded` status.

Use the returned `requestId` to read progress without dispatching again:

```json
{"action": "status", "requestId": "<returned requestId>"}
```

`waitForResult: false` returns `queued`, which does not confirm rendering.
`timed_out` means the caller's wait ended; later status queries may show
completion. Partial matches return `partial`; delivery/render failures return
`failed`. Receipts are local to the workspace and expire after 24 hours;
unknown or expired IDs return `not_found`. Large match lists retain exact
selectors within a byte budget, with `matchedCount`, `notFoundCount` and explicit
`omitted` counts. MCP responses also apply the 40,000-character response budget
and disclose any additional compaction in `_output`.

## Runtime (live app) (10 tools)

| Tool | What it does |
|------|-------------|
| `get_runtime_status` | Check runtime connection status. |
| `get_live_tree` | Get the live component tree from a connected React Native app. |
| `get_runtime_state` | Find a component in the live runtime tree by name. |
| `inspect_live_component` | Deep inspect a running component's props, state, hooks, and context values. |
| `trace_live_prop` | Trace live prop changes through the component tree and animate in the visualizer. |
| `get_live_navigation` | Get live navigation state — which screens are mounted (active) vs defined but not visible. |
| `modify_runtime_state` | Modify a component's props/state/hooks/context at runtime. |
| `trigger_projection` | Diff runtime snapshots and project downstream effects. |
| `verify_state_flows` | Verified Projection in one call: generate testable state-flow hypotheses from static analysis, write Jest tests for them, run the tests, and annotate the vis… |
| `manage_snapshots` | Analysis snapshots for historical tracking, one tool, three actions: "save" (run analyses and store under .dendro/snapshots/ — requires entryFile), "list" (m… |

## Feedback (1 tool)

| Tool | What it does |
|------|-------------|
| `submit_feedback` | Send a feedback debrief about Dendro to its maker. |

---

*Generated from the live MCP server tool list (v0.8.0 + get_context_pack). Regenerate on each release.*
