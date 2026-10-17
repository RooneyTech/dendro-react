---
name: dendro-react
description: Use the Dendro React MCP server effectively when analyzing or editing React/React Native code — the reflex of which tool answers which question, and which tools to trust for what. Triggers: working in a React codebase with dendro-react MCP tools available; "use dendro", "dendro reflex".
version: 0.7.0
---

# The Dendro reflex — use the MCP, don't just grep

Dendro's 36 tools give structural answers one call at a time. The reflex below is the proven
usage pattern (from months of agent dogfooding). Follow it whenever the `dendro-react` MCP
server's tools are available.

## Before editing a component

Call `get_component_contract` with the component NAME (it resolves workspace-wide, including
`index.tsx` exports and kebab-case files). One call returns: props (from the TypeScript type
when resolvable), state, hooks, contexts read/provided, **who imports it (blast radius)**,
per-component complexity, and re-render risk count. Its `notCovered` field lists what it
deliberately omits — don't infer absence from it.

## When reviewing or testing recent work

Call `get_modified_components` first (default: uncommitted work vs HEAD; pass `base: "main"`
for PR scope). Then `get_component_contract` on each changed component. That pair answers
"what did I touch and what depends on it" in two calls.

## Which tools to trust for what

- **Coarse structural facts you can't cheaply grep** — blast radius (`get_used_by`), reachability
  (`get_navigation_structure`), complexity triage (`get_complexity_report`), cycles
  (`detect_circular_deps`): these are authoritative within the scope each response DISCLOSES.
  Read the `note`/`warnings`/`scanScope` fields — an empty result explains what it means.
- **Navigation graphs model declared routes only.** Imperative transitions (`navigate()`,
  `router.push`) are not edges; a warning flags when they're present. Don't conclude a screen is
  unreachable from the graph alone — grep the route string too.
- **Re-render findings are modern-React aware**: on React Compiler projects, memoization findings
  arrive downgraded to low — do NOT add manual useCallback/useMemo there.
- **Verify the server build after recompiling it**: `get_usage_guide` returns a `build` stamp
  (version/SHA/time). A running MCP server never hot-reloads — restart the client if stale.

## Visualization (needs the VS Code extension)

Call `open_visualizer` ONCE, then batch everything through `visualize_batch` with
`waitForUser: true` and a `label` per step. `success: true` on visualize tools means
*dispatched*, not rendered — and vscode:// URIs land in the most recently focused VS Code window.

## Setup (if tools are missing)

```json
{ "mcpServers": { "dendro-react": { "command": "npx", "args": ["-y", "dendro-react-mcp"] } } }
```

VS Code extension (visual canvas + sidebar): `RooneyTech.dendro-react` on the Marketplace or
Open VSX. All 36 tools are free; analysis runs locally. Docs: https://dendroreact.com
