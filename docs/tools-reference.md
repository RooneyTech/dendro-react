# Dendro React — Tools Reference

Full reference for all 36 MCP tools. Your AI assistant discovers these automatically via `get_usage_guide` — you don't need to memorize them.

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
| `visualize_batch` | Execute multiple visualization commands in sequence. |
| `export_analysis` | Export Dendro analysis in one of four formats: "mermaid" (flowchart syntax for docs), "json" (enriched multi-analysis document), "svg" (color-coded diagram i… |

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
