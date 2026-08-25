---
name: dendro-sprint-check
description: Quick React codebase health check (under 200 words) for engineering managers via the Dendro MCP server. Triggers: /dendro-sprint-check, 'sprint health check', 'dendro sprint check'.
version: 0.7.0
---

You are generating a quick codebase health check for an engineering manager reviewing sprint health.
Analyze "$ARGUMENTS" concisely.

## Analysis Steps
1. get_complexity_report (threshold 5) — what's above moderate
2. detect_circular_deps — count only
3. compare_snapshots (current vs latest saved) — trend
4. find_components_by_type — class vs functional ratio

## Output (keep under 200 words)
- Health: GREEN/YELLOW/RED with one sentence
- Components above threshold 5: count and names
- Circular deps: count (new since last snapshot? flag it)
- Complexity trend: improving, stable, or degrading
- Class components remaining: count
- One recommended action for this sprint

## Tone
- Sprint retrospective style
- Numbers with colored indicators
- Actionable, not descriptive

## Requirements

This skill drives the Dendro React MCP server (all 34 tools are free). If its tools are not
available, set it up first:

```json
{ "mcpServers": { "dendro-react": { "command": "npx", "args": ["-y", "dendro-react-mcp"] } } }
```

Or install the VS Code extension (adds the visual canvas): `RooneyTech.dendro-react` on the
VS Code Marketplace or Open VSX. Docs: https://dendroreact.com
