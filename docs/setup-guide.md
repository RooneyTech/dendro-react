# Dendro React — Setup Guide

Connect an MCP client, then verify one component contract against source before
using a finding to change code. Static analysis works without the visualizer.
The extension requires VS Code 1.101 or later (or a compatible editor runtime).
Use Node 22.12+ or Node 20.19+ in the 20.x line; the native parser dependency
requires this even though older Dendro npm metadata advertised Node 18.

## Standalone MCP Setup

Merge this server into your client's MCP config, preserving other servers.
Replace `/absolute/path/to/project` with the project you want to analyze:

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

Claude Code uses the project's `.mcp.json`.
[Cursor uses `.cursor/mcp.json`](https://cursor.com/docs/mcp).
For [Windsurf](https://docs.windsurf.com/windsurf/cascade/mcp) or another client,
open its MCP settings and add the same stdio server. The extension does not
register an MCP server automatically. If `npx` is not found by the client, use
its absolute path (`which npx` on macOS/Linux). If it still cannot find `node`,
include Node's bin directory in the client's PATH or use the absolute-node
configuration below.

Restart or reconnect the MCP client after changing config, then follow
[First useful result](#first-useful-result) below. The first npm launch needs
network access to download the package; analysis runs locally.

## Use the Installed Extension's MCP Server

Install Dendro React from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=RooneyTech.dendro-react)
or [Open VSX](https://open-vsx.org/extension/rooneytech/dendro-react).
The extension supplies the shared visual map and a bundled MCP server.

### 1. Find Your Extension Path

```bash
ls ~/.vscode/extensions/rooneytech.dendro-react-*/dist/mcp-server.js
```

If the command lists several versions, choose the newest installed version.
Cursor, Windsurf and remote editors use different extension directories;
locate `RooneyTech.dendro-react` in the editor where you installed it.

### 2. Find Your Node Path

```bash
which node
```

This gives you the absolute path (e.g. `/opt/homebrew/bin/node`). You need this because AI assistants may not find `node` in their default PATH.

### 3. Configure Your AI Assistant

**Claude Code** — merge into `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "dendro-react": {
      "command": "ABSOLUTE_NODE_PATH_FROM_STEP_2",
      "args": ["MCP_SERVER_PATH_FROM_STEP_1"],
      "env": {
        "DENDRO_WORKSPACE_ROOT": "/absolute/path/to/project"
      }
    }
  }
}
```

**Claude Desktop** — edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows) with the same config.

**Cursor / Windsurf / other clients** — add this same stdio server through the
client's MCP configuration as described above. Installing the extension alone
does not connect its MCP tools.

### 4. Restart Your AI Assistant

Restart Claude Code, Claude Desktop, or your editor to pick up the new MCP config.

## First useful result

Ask your agent:

> Call `get_usage_guide` and report the running Dendro version. Get
> `get_component_contract` for a component I plan to change, using its absolute
> file path and this project's source directory as `searchDir`. Read the component
> and one reported importer. Check props, state and the import relationship;
> explain one concrete change impact with file references. List mismatches and
> scope limits. If no importer is reported, check the scan scope and inspect a
> known caller before drawing a conclusion. Do not edit code yet.

Success means one accurate, source-checked answer you can act on. A responding
server alone does not establish that its findings are true. Contracts describe
static relationships within the reported search scope, not all runtime callers.
`hooks.total` currently counts dependency-tracked hooks, so a component with
`useState` alone can report zero; read the separate `state` field and source.
The editor's CodeLens currently follows relative/absolute imports only; alias
imports can produce “No usages found” even when callers exist. Use the MCP
contract with an explicit search scope and verify the reported callers.

The published v0.9.0 cleanup rule can misread implicitly returned or
optional-chained cleanup as a leak. Check the flagged code before applying a
fix, and check the running version after any upgrade.

For the shared map, call `open_visualizer` with your entry file, then
`visualize_batch` with sequential labeled steps. Confirm the intended node is
visible and highlighted in the intended editor window. Version 0.9.3 and later
report per-command matches and rendering; a queued result or manual pause does
not confirm later steps. Earlier versions report dispatch only.
Runtime connection is optional.

On the next change, call `get_modified_components` (choose the appropriate git
base), then get contracts for the changed components and inspect their callers.
This is a repeatable review workflow; it is not evidence that developers will
choose to return.

## Project Instructions

Add a snippet to your project instructions file so the AI agent knows Dendro is available from the start of every session.

**Claude Code** — add to `CLAUDE.md` in your project root:

```markdown
## Dendro React (MCP Component Analyzer)

This project has a Dendro React MCP server configured. Use it to understand the codebase.

When analyzing this project:
1. Call `get_usage_guide` first to learn available tools
2. Before an edit, use `get_component_contract` and verify the relevant source and callers
3. For recent changes, use `get_modified_components` with an appropriate git base
4. Treat `quick_audit` findings as review prompts; read the source before applying fixes
5. For the map, call `open_visualizer`, then `visualize_batch` with labeled steps and `waitForUser: true`; confirm the visible result

Key entry point: src/App.tsx
```

**Cursor** — add to `.cursorrules`:

```
# Dendro React (MCP Component Analyzer)

This project has a Dendro React MCP server configured. When analyzing React components,
call get_usage_guide first and check the running version. Before editing, get
get_component_contract and verify its claims against source and callers. For
recent changes, start with get_modified_components using an appropriate git base.
For the map, call open_visualizer with src/App.tsx, then visualize_batch with
labeled steps and waitForUser: true. Confirm the visible result.
```

**Windsurf** — add the same content to `.windsurfrules`.

> Replace `src/App.tsx` with your actual root component path.

**Tip:** Say **"Dendro"** in your prompts — like "Use Dendro to show me the component tree." It'll use the visualizer and deeper analysis instead of just reading files.

## Runtime Connection (Optional)

Connect to a running React or React Native app for live inspection.

### Setup

1. Run `Cmd+Shift+P` → **"Dendro React: Connect to Running App"** (start this **before** your app)
2. Start your app (`npx expo start`, `npm start`, etc.)
3. The app auto-connects to Dendro on startup

### Troubleshooting

| Problem | Fix |
|---------|-----|
| "EADDRINUSE" error | Expo/Metro also uses port 8097. Press `shift+m` in the Expo terminal to disable its DevTools, then retry. Or set `dendro-react.runtimePort` to `8098` in VS Code settings and start your app with `REACT_DEVTOOLS_PORT=8098 npx expo start` |
| "Disconnected" in status bar | App may have reloaded. Re-run "Dendro React: Connect to Running App" |
| Android emulator won't connect | Dendro runs `adb reverse` automatically, but make sure adb is in your PATH |
| Physical device won't connect | In VS Code settings, set `dendro-react.runtimeHost` to `0.0.0.0` — device must be on same WiFi |

### React Native DevTools Bridge

Add this line at the very top of `App.tsx` (before all other imports):

```javascript
if (__DEV__) require('react-devtools-core').connectToDevTools();
```

Then install the package if it's not already there:

```bash
npm install --save-dev react-devtools-core
```

This only runs in development mode.

## Other Ways to Use Dendro

- **Sidebar tree**: Always-visible component tree in the activity bar (click the tree icon)
- **CodeLens**: See "Used by X components" inline in your editor
- **Context menu**: Right-click any `.tsx`/`.jsx` file → "Show Dendrogram"
- **Keyboard shortcut**: `Shift+Option+D` (Mac) / `Shift+Alt+D` (Windows/Linux)
