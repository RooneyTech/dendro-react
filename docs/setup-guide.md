# Dendro React — Setup Guide

Detailed setup instructions for all AI assistants and editors.

## Manual MCP Setup

### 1. Find Your Extension Path

```bash
ls ~/.vscode/extensions/rooneytech.dendro-react-*/dist/mcp-server.js
```

### 2. Find Your Node Path

```bash
which node
```

This gives you the absolute path (e.g. `/opt/homebrew/bin/node`). You need this because AI assistants may not find `node` in their default PATH.

### 3. Configure Your AI Assistant

**Claude Code** — create `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "dendro-react": {
      "command": "ABSOLUTE_NODE_PATH_FROM_STEP_2",
      "args": ["MCP_SERVER_PATH_FROM_STEP_1"]
    }
  }
}
```

**Claude Desktop** — edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows) with the same config.

**Cursor / Continue** — these read MCP config from VS Code settings. The extension should register automatically — check your MCP tools list.

### 4. Restart Your AI Assistant

Restart Claude Code, Claude Desktop, or your editor to pick up the new MCP config.

## Project Instructions

Add a snippet to your project instructions file so the AI agent knows Dendro is available from the start of every session.

**Claude Code** — add to `CLAUDE.md` in your project root:

```markdown
## Dendro React (MCP Component Analyzer)

This project has a Dendro React MCP server configured. Use it to understand the codebase.

When analyzing this project:
1. Call `get_usage_guide` first to learn available tools
2. Use `analyze_codebase` with entryFile for a full architecture overview
3. Use `quick_audit` for a health grade and top issues
4. Use `open_visualizer` then visualization commands to see the component tree
5. Always call viz commands sequentially (wait for each to complete)

Key entry point: src/App.tsx
```

**Cursor** — add to `.cursorrules`:

```
# Dendro React (MCP Component Analyzer)

This project has a Dendro React MCP server configured. When analyzing React components,
call get_usage_guide first to learn available workflows. Use analyze_codebase
with the entry file (src/App.tsx) to understand structure. Always call
open_visualizer before visualization commands, and execute viz commands sequentially.
```

**Windsurf** — add the same content to `.windsurfrules`.

> Replace `src/App.tsx` with your actual root component path.

**Tip:** Say **"Dendro"** in your prompts — like "Use Dendro to show me the component tree." It'll use the visualizer and deeper analysis instead of just reading files.

## Runtime Connection (Optional)

Connect to a running React or React Native app for live inspection.

### Setup

1. Run `Cmd+Shift+P` → **"Dendro: Connect to Running App"** (start this **before** your app)
2. Start your app (`npx expo start`, `npm start`, etc.)
3. The app auto-connects to Dendro on startup

### Troubleshooting

| Problem | Fix |
|---------|-----|
| "EADDRINUSE" error | Expo/Metro also uses port 8097. Press `shift+m` in the Expo terminal to disable its DevTools, then retry. Or set `dendro.runtimePort` to `8098` in VS Code settings and start your app with `REACT_DEVTOOLS_PORT=8098 npx expo start` |
| "Disconnected" in status bar | App may have reloaded. Re-run "Dendro: Connect to Running App" |
| Android emulator won't connect | Dendro runs `adb reverse` automatically, but make sure adb is in your PATH |
| Physical device won't connect | In VS Code settings, set `dendro.runtimeHost` to `0.0.0.0` — device must be on same WiFi |

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
