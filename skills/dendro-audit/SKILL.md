---
name: dendro-audit
description: Deep technical audit of a React codebase via the Dendro MCP server — complexity hotspots, circular deps, rerender risks, actionable recommendations. Triggers: /dendro-audit, 'audit this React codebase', 'dendro audit'.
version: 0.7.0
---

You are conducting a deep technical audit of a React codebase using the Dendro MCP server.
The target codebase is at: $ARGUMENTS

## STOP — Pre-flight check
Your FIRST action must be to call the `quick_audit` MCP tool with the target path.
If `quick_audit` is not available as an MCP tool, STOP IMMEDIATELY and tell the user:
"The Dendro MCP server is not connected. Please start it with: node dist/mcp-server.js"
DO NOT fall back to manual file exploration. DO NOT use grep, find, bash, ls, wc, or file reads to analyze the codebase. Those tools cannot replicate what Dendro's parsers do.

## Analysis Steps (call these Dendro MCP tools in order)
1. `quick_audit` with entryFile pointing to the main App/index file
2. `get_component_tree` — full hierarchy with stats
3. `get_complexity_report` (threshold: 5) — components above moderate complexity
4. `detect_circular_deps` — all cycles with paths
5. `get_context_map` — state management assessment
6. `get_hook_deps` on the top 3 highest-complexity components from step 3
7. `get_prop_flow` on the top 3 most-used props identified in step 1

Wait for each tool result before proceeding. Do NOT parallelize tool calls — each step informs the next.

## Visualization — REQUIRED (do this BEFORE writing the report)
After collecting all data and BEFORE writing your report:
1. `open_visualizer` with the entry file — call this EXACTLY ONCE. Do NOT call open_visualizer again.
2. `visualize_highlight` complexity > 7 in red (pulse: true)
3. `visualize_highlight` complexity 5-6 in orange
4. `visualize_annotate` the top 5 flagged components with their complexity scores
5. If circular deps found, `visualize_trace_flow` them
6. `visualize_fit_all` to show the full picture
Call each viz command sequentially — wait for each to complete before the next.
Do NOT call open_visualizer more than once — it creates a new panel each time.

## Report — SYNTHESIZE, don't dump
DO NOT paste raw JSON output from tool calls. Synthesize findings into a concise, readable report.
Keep the full report under 800 words. Use tables and bullet points, not walls of text.

1. **Executive Summary** (3-4 sentences) — grade, component count, top concern
2. **Complexity Hotspots** — table: component | score | why | recommendation (top 5 only)
3. **Circular Dependencies** — each cycle with one-line fix
4. **State Management** — context count, heaviest providers, missing memoization (bullet points)
5. **Prop Drilling** — worst offenders with prop counts (table, top 5)
6. **Action Items** — numbered list, 3-5 items, ordered by impact

## Tone
- Direct, technical, actionable
- Every finding has a specific recommendation
- Include file paths but not full absolute paths — use relative from project root

## Requirements

This skill drives the Dendro React MCP server (all 36 tools are free). If its tools are not
available, set it up first:

```json
{ "mcpServers": { "dendro-react": { "command": "npx", "args": ["-y", "dendro-react-mcp"] } } }
```

Or install the VS Code extension (adds the visual canvas): `RooneyTech.dendro-react` on the
VS Code Marketplace or Open VSX. Docs: https://dendroreact.com
