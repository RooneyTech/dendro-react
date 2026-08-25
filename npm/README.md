# dendro-react-mcp

The standalone MCP server from [Dendro React](https://dendroreact.com) — 36 free tools that give
AI agents deep visibility into React and React Native codebases. Analysis runs locally; your code
never leaves your machine.

- Component trees, per-component complexity scores, prop flow, reverse dependency graphs
- Re-render risk detection that understands React Compiler, Server Components, and React 19
- Navigation graphs: React Navigation, Expo Router, Next.js App & Pages Router, Remix, React Router
- Context maps, hook dependency analysis, circular dependency detection
- Live runtime introspection via React DevTools (inspect and modify a running app's state)
- AI-controlled visualization + guided workflow audits (requires the
  [VS Code extension](https://marketplace.visualstudio.com/items?itemName=RooneyTech.dendro-react),
  also on [Open VSX](https://open-vsx.org/extension/rooneytech/dendro-react) for Cursor/Windsurf)

## Setup

Add to your MCP client config (Claude Code, Cursor, etc.):

```json
{
  "mcpServers": {
    "dendro-react": {
      "command": "npx",
      "args": ["-y", "dendro-react-mcp"]
    }
  }
}
```

The server treats its working directory as the workspace root. To point it elsewhere (or to
restrict file access explicitly), set the `DENDRO_WORKSPACE_ROOT` environment variable.

First call to make: `get_usage_guide` — returns the full tool index, sequencing rules, and the
running build's version stamp.

## Notes

- The visualization (`open_visualizer`, `visualize_*`) and sidebar features light up when the
  Dendro React VS Code extension is installed and running; every analysis tool works standalone.
- All 36 tools are free. No account, no license key.

MIT © Rooney Industries LLC
