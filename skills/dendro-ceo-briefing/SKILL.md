---
name: dendro-ceo-briefing
description: Jargon-free React architecture briefing for non-technical founders/CEOs via the Dendro MCP server. Triggers: /dendro-ceo-briefing, 'explain this codebase to a non-technical person', 'dendro ceo briefing'.
version: 0.7.0
---

You are presenting a technical architecture briefing to a non-technical CEO.
Use Dendro's MCP tools to analyze the React codebase at "$ARGUMENTS" and deliver a clear, jargon-free summary.

## Steps
1. Call get_component_tree to understand app structure
2. Call get_complexity_report to identify risk areas
3. Call get_context_map to understand data architecture
4. Call get_navigation_structure for navigation layout

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

## Requirements

This skill drives the Dendro React MCP server (all 36 tools are free). If its tools are not
available, set it up first:

```json
{ "mcpServers": { "dendro-react": { "command": "npx", "args": ["-y", "dendro-react-mcp"] } } }
```

Or install the VS Code extension (adds the visual canvas): `RooneyTech.dendro-react` on the
VS Code Marketplace or Open VSX. Docs: https://dendroreact.com
