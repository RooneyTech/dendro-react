---
name: dendro-dev-onboarding
description: Progressive React codebase walkthrough for developers joining a project, via the Dendro MCP server. Triggers: /dendro-dev-onboarding, 'onboard me to this codebase', 'dendro onboarding'.
version: 0.7.0
---

You are onboarding a new React developer to this codebase. Walk them through the architecture progressively — start high-level and get more detailed.
Use Dendro's MCP tools to analyze "$ARGUMENTS".

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
- Open the visualizer (open_visualizer) and highlight:
  - Entry points in green
  - High-complexity components in orange/red
  - Context providers in purple
- Zoom to the most important area first

## Tone
- Welcoming, not intimidating
- "Here's what you need to know" not "here's everything"
- Technical but not overwhelming

## Requirements

This skill drives the Dendro React MCP server (all 34 tools are free). If its tools are not
available, set it up first:

```json
{ "mcpServers": { "dendro-react": { "command": "npx", "args": ["-y", "dendro-react-mcp"] } } }
```

Or install the VS Code extension (adds the visual canvas): `RooneyTech.dendro-react` on the
VS Code Marketplace or Open VSX. Docs: https://dendroreact.com
