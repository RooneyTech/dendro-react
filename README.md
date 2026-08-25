# Dendro

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/RooneyTech.dendro-react?label=VS%20Code%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=RooneyTech.dendro-react)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/RooneyTech.dendro-react)](https://marketplace.visualstudio.com/items?itemName=RooneyTech.dendro-react)

**See your React app's constellation.**

Dendro gives your AI assistant deep understanding of your React and React Native codebase — component trees, complexity scores, navigation maps, data flow, and an interactive visual canvas. 36 MCP tools, zero configuration on your part.

## Getting Started

1. Install **Dendro React** — run `ext install RooneyTech.dendro-react` in VS Code, or install from the [Marketplace](https://marketplace.visualstudio.com/items?itemName=RooneyTech.dendro-react)
2. Open your React or React Native project in Claude Code
3. Paste this:

> Set up Dendro React for this project. The extension is already installed in VS Code. Do these steps in order:
>
> 1. Find the MCP server path: `ls ~/.vscode/extensions/rooneytech.dendro-react-*/dist/mcp-server.js`
> 2. Find the absolute node path: `which node`
> 3. Create `.mcp.json` in the project root using the absolute node path as `"command"` and the MCP server path as the first arg
> 4. Add a Dendro section to `CLAUDE.md` (create it if needed) with: the entry file path, `get_usage_guide` as first call, and a note to run viz commands sequentially
> 5. Verify by calling `get_usage_guide`

That's it. Your agent handles the rest.

## Things to Try

Say **"Dendro"** in your prompts — like "Use Dendro to show me how this app is structured." It'll use the visualizer and deeper analysis instead of just reading files.

- **"Use Dendro to give me an overview of this project's architecture"**
- **"Use Dendro to check how healthy this codebase is"**
- **"Show me how navigation works in this app with Dendro"**
- **"Use Dendro to visualize the component tree and highlight complex components"**
- **"Where does state live? Use Dendro to trace the data flow"**
- **"Open the Dendro visualizer and walk me through the app"**

## What It Does

- **Component tree analysis** — full hierarchy, relationships, and structure
- **Complexity scoring** — every component graded 1-10 with refactoring candidates
- **Navigation mapping** — React Navigation, Next.js, React Router, Remix
- **Context & data flow** — providers, consumers, prop drilling detection
- **Health audits** — A-F grade with actionable issues
- **Visual canvas** — AI highlights, annotates, and traces flows in a live dendrogram
- **Runtime inspection** — connect to a running app for live state, props, and hooks (optional)

## Pricing

All 36 tools are free — exports, snapshots, verified projection, live introspection, and batch analysis included. No account, no license key, and no code leaves your machine.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `dendro-react.autoStartRuntime` | `false` | Auto-connect to React Native apps on activation |
| `dendro-react.runtimePlatform` | `auto` | Target platform: `auto`, `ios`, `android`, or `device` |
| `dendro-react.runtimePort` | `8097` | DevTools WebSocket port |
| `dendro-react.runtimeHost` | `localhost` | WebSocket host (`0.0.0.0` for physical devices) |
| `dendro-react.projectorMode` | `false` | Larger fonts/strokes for screen sharing |

## Learn More

- [Setup Guide](docs/setup-guide.md) — manual setup, Cursor/Windsurf config, runtime connection, troubleshooting
- [Tools Reference](docs/tools-reference.md) — all 36 MCP tools with descriptions

## Feedback

Dendro is in early access. If something doesn't work, feels confusing, or you wish it did something different — I want to hear it.

- **Issues & ideas:** [GitHub Issues](https://github.com/RooneyTech/dendro-react/issues)
- **Email:** colin@rooneytech.com

---

*Built by [Colin Rooney](https://github.com/12mv2). Originally derived from [Reactive](https://github.com/oslabs-beta/reactive), built at OSLabs with Micah Ziegler and Susana Lam. Named after the Greek word for tree and the branching dendrites of neurons.*
