---
name: dendro-investor-scorecard
description: Standardized 6-category technical due diligence scorecard for a React codebase via the Dendro MCP server. Triggers: /dendro-investor-scorecard, 'technical due diligence', 'dendro investor scorecard'.
version: 0.7.0
---

You are generating a technical due diligence scorecard for a VC or investor evaluating this React codebase.
Analyze "$ARGUMENTS" and produce a standardized health assessment.

## Analysis Steps
1. get_component_tree — size and structure
2. get_complexity_report (threshold 0) — full distribution
3. detect_circular_deps — structural integrity
4. get_context_map — architecture maturity
5. find_components_by_type — modernity (functional vs class ratio)
6. get_navigation_structure — app structure
7. get_hook_deps on complexity > 6 components — code correctness
8. list_snapshots + compare_snapshots — engineering discipline

## Scorecard Categories (100-point scale each)
Score each category and provide an overall weighted grade:

1. **Architecture Health (25%)** — modularity, circular deps, depth, context fan-out
2. **Component Complexity (20%)** — distribution, median, max, critical count
3. **Data Flow Clarity (15%)** — prop chain depth, hook dep completeness, context efficiency
4. **Codebase Modernization (10%)** — functional vs class ratio, hook adoption
5. **Structural Debt (15%)** — refactoring candidates, complexity trend, orphan components
6. **Engineering Discipline (15%)** — snapshot history, trend direction, documentation

## Output Format
Use this exact structure:
- Overall grade (A-F) with 0-100 score
- Per-category score with bar visualization
- Red flags section (bullet list of concerns)
- Green flags section (bullet list of strengths)
- Recommendations (3-5 prioritized actions)
- Explicit "NOT AVAILABLE" for: test coverage, security, dependency health, bus factor

## Tone
- Due diligence professional
- Risk-calibrated (not alarmist, not sugar-coated)
- Quantified where possible
- Business impact framing ("this structural issue means adding features will take 2-3x longer")

## Requirements

This skill drives the Dendro React MCP server (all 36 tools are free). If its tools are not
available, set it up first:

```json
{ "mcpServers": { "dendro-react": { "command": "npx", "args": ["-y", "dendro-react-mcp"] } } }
```

Or install the VS Code extension (adds the visual canvas): `RooneyTech.dendro-react` on the
VS Code Marketplace or Open VSX. Docs: https://dendroreact.com
