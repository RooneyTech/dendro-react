# Dendro React — Field Testing Feedback

**Date:** 2026-02-18
**Tested by:** Colin Rooney (via Claude Code / Claude Opus 4.6)
**Test project:** Solsis frontend — React Native / Expo app, 83 components, max depth 12

---

## Testing Round 2 (Session 47 build — post-fixes)

Retested on current `main` after rebuilding. URI bridge fix applied, all Session 44-46 fixes present.

### Bug Found & Fixed: URI Bridge Mismatch

`src/mcp/tools.ts:1414` hardcoded `vscode://dendro-mcp.dendro-mcp` but the installed extension ID is `rooneytech.dendro-react` (changed in Session 45 rename). This caused `open_visualizer` via MCP to silently fail — no webview opened, no error, tool returned `success: true`. The manual route (Cmd+Shift+P → "Dendro: Visualize Component Tree") still worked, making it hard to diagnose.

**Fix:** `const DENDRO_URI_BASE = 'vscode://rooneytech.dendro-react';` — applied and verified.

### Setup Friction

- **`.mcp.json` stale path** — Solsis project's `.mcp.json` pointed to `dendro-mcp/dist/mcp-server.js` (old repo name). Had to update to `dendro-react/dist/mcp-server.js`. MCP tools were unavailable until fixed.
- **Lingering old extensions** — Three Dendro extensions installed (`dendro-mcp.dendro-mcp`, `dendro-swiftui.dendro-swiftui`, `rooneytech.dendro-react`). Old extension directories persisted in `~/.vscode/extensions/` even after VS Code uninstall. Had to manually `rm -rf` the leftovers.
- **Port 8097 held by previous session** — Required full Cmd+Q quit (not just reload) to release. Error message was helpful but didn't suggest the full-quit resolution. Suggestion: add "Try fully quitting and reopening VS Code" to the port-in-use message.
- **Multiple reloads** — Reload after `.mcp.json` fix, reload after uninstalling old extensions, full quit for port, reload after `.vsix` reinstall. Each cycle cost a few minutes.

### What Works (confirmed post-fix)

Once the URI bridge was fixed, everything clicked:
- `open_visualizer` returned `ready: true` with session ID
- Highlights, annotations, and flow traces all rendered correctly
- `get_component_tree` / `get_context_map` / `get_navigation_structure` solid throughout
- Command sequencing fix from Sessions 44-46 working — sequential commands rendered without drops

### Previously Open Issues — Now Resolved

**~~1. Header overlaps root node on large trees~~** — **Fixed** (Session 47). Replaced hardcoded `scale(0.8)` with bounding-box-based zoom-to-fit. Computes tree extent from all laid-out nodes, calculates scale to fit within viewport minus header and padding. TICKET-037 closed.

**~~2. Dendrogram opens zoomed in~~** — **Fixed** (same commit). Same bounding-box calculation now fits the full tree in the viewport on open.

A `visualize_fit_all` MCP tool would still be useful from the agent side for re-fitting after expand/collapse.

---

## Testing Round 1 (pre-Session 44 build)

### What Works Well

The static analysis + visualizer combo is genuinely impressive. Here's a screenshot of the Solsis frontend with all state flows animated — context flows (dashed) and local state flows (dotted) color-coded across the full component tree:

![Dendro visualization of Solsis frontend](../../../_archive/collaborations/solsis/solsis-frontend/Screenshot%202026-02-18%20at%2012.32.22%20PM.png)

Tools that worked great:
- `get_component_tree` — full tree with state vars, types, depth
- `get_context_map` — provider/consumer hierarchy with custom hooks
- `get_navigation_structure` — navigator types, screens, formatted tree
- `open_visualizer` — interactive dendrogram in VS Code webview
- `visualize_highlight` — color-coded node grouping by architectural layer
- `visualize_annotate` — callouts explaining component roles
- `visualize_trace_flow` — animated state flow lines (context + local state)

Being able to layer highlights, annotations, and animated flows onto a live dendrogram made it easy to explain the entire architecture of an 83-component app in one view.

### Issues Found (all resolved in Sessions 44-45)

| Issue | Resolution |
|-------|-----------|
| EADDRINUSE 8097 error spam | TICKET-036 — exponential backoff, max 5 retries, dedup (Session 44) |
| Header overlaps root node | TICKET-037 — y-offset 50→120px (Session 44). *Partially fixed — see Round 2.* |
| Viz commands lack sequencing | TICKET-038 — visualizer-bridge.ts ready signal (Session 45) |
| LLM discoverability | TICKET-040/041/044 — usage guide, project instructions, tool hints (Session 44) |

---

## Feature Ideas (from both rounds)

| Idea | Description | Priority |
|------|-------------|----------|
| ~~Dynamic initial zoom~~ | ~~Calculate scale from tree bounding box instead of hardcoded 0.8~~ | **Done** (Session 47) |
| `visualize_fit_all` | MCP tool to zoom viewport to fit entire tree | High — natural first call after `open_visualizer` |
| `visualize_batch` | Array of viz ops executed sequentially with internal timing | Medium — eliminates LLM parallel-batching |
| Internal command queue | Webview-side buffer + debounce for rapid-fire commands | Medium — transparent fix |
| Better port error message | Add "Try fully quitting VS Code" to EADDRINUSE message | Low — QoL |
