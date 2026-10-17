# dendro-react-mcp

React codebase semantics for AI agents, with a visualizer you both share.
The standalone MCP server from [Dendro React](https://dendroreact.com) analyzes
React and React Native projects locally. Use Node 22.12+ or Node 20.19+ in the
20.x line (required by the native parser).

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
      "args": ["-y", "dendro-react-mcp"],
      "env": {
        "DENDRO_WORKSPACE_ROOT": "/absolute/path/to/project"
      }
    }
  }
}
```

The server treats its working directory as the workspace root. To point it elsewhere (or to
restrict file access explicitly), set the `DENDRO_WORKSPACE_ROOT` environment variable.

Replace the workspace path and merge the entry into your existing config.
Restart or reconnect the MCP client. First call: `get_usage_guide` — check the
running version, then request `get_component_contract` for a component you
plan to edit. Read its source and a reported importer; verify props, state and
one change impact before proposing an edit.

Findings require source review. In particular, v0.9.0 can flag correct implicit
or optional-chained effect cleanup as a leak. A health grade is a heuristic,
not a correctness or runtime performance verdict.

See the [setup guide](https://github.com/RooneyTech/dendro-react/blob/main/docs/setup-guide.md)
for client configuration and the visualizer. Queued visual commands do not
confirm rendering; verify the visible result in the intended editor window.

## Notes

- The visualization (`open_visualizer`, `visualize_*`) and sidebar features light up when the
  Dendro React VS Code extension is installed and running; every analysis tool works standalone.
- Every tool is free. No account, no license key.
- `submit_feedback` sends a debrief off-machine only with your explicit consent.
  You can also [report an issue](https://github.com/RooneyTech/dendro-feedback/issues).

MIT © Rooney Industries LLC
