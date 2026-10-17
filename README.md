# Dendro

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/RooneyTech.dendro-react?label=VS%20Code%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=RooneyTech.dendro-react)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/RooneyTech.dendro-react)](https://marketplace.visualstudio.com/items?itemName=RooneyTech.dendro-react)

**Your agent is editing code it's never read.**

It just scanned forty files to answer "what breaks if I change this?"
It could have asked one fucking question.

Dendro is one model of your React or React Native codebase, rendered twice:
semantics your agent can query, and a map you can both point at.

## For your agent — the semantics

MCP tools that answer React questions in React terms: the component's contract
before an edit (props, state, contexts, blast radius), rerender risk with the
why, effect hygiene (cleanup risks, setter-only effects, fetch races
that `exhaustive-deps` can't see), navigation graphs (Next.js, React Navigation,
Remix, Expo Router), live runtime state from a running app — and whole-repo
orientation in one ~300-token call.

Symbol servers tell your agent where the symbol is.
Dendro tells it what rerenders, and why.

## For you — the visualizer

Your app's constellation: a live dendrogram in VS Code, descended from
[Reactive](https://github.com/oslabs-beta/reactive). Your agent drives it —
highlights what it's talking about, annotates, traces a prop, walks you through
the architecture step by step while you click Next/Back. You watch the same map
the agent reasons over.

## Getting Started

1. Install **Dendro React** — run `ext install RooneyTech.dendro-react` in VS Code, or install from the [Marketplace](https://marketplace.visualstudio.com/items?itemName=RooneyTech.dendro-react)
2. Open your React or React Native project in Claude Code
3. Paste this:

> Set up Dendro React for this project. The extension is already installed in VS Code. Do these steps in order:
>
> 1. Find the MCP server path: `ls ~/.vscode/extensions/rooneytech.dendro-react-*/dist/mcp-server.js`. If several versions are installed, choose the newest one.
> 2. Find the absolute node path: `which node` (Node 22.12+ or Node 20.19+ in the 20.x line).
> 3. Merge a `dendro-react` server into `.mcp.json` using the absolute node path as `"command"`, the selected server path as the first arg, and `DENDRO_WORKSPACE_ROOT` set to this project's absolute path. Preserve other servers.
> 4. Restart the MCP client, then call `get_usage_guide` and report its running version. If the tools are unavailable, stop and explain what setup remains.
> 5. Get the contract of one component I am about to edit. Read its source and one reported importer; check props, state, and used-by claims. Explain one concrete change impact and any mismatch before proposing an edit.

Your first useful result is a source-checked answer to “what depends on the
component I'm changing?” The finish line is an accurate explanation of one
change impact, with file references and scope limits.

For [standalone analysis, Cursor/Windsurf setup, or troubleshooting](docs/setup-guide.md),
use the setup guide. The VS Code extension is needed for the shared map;
static analysis can run through the npm MCP server alone.

## Things to Try

Say **"Dendro"** in your prompts — like "Use Dendro to show me how this app is structured." It'll use the visualizer and deeper analysis instead of just reading files.

- **Watch:** "Open the Dendro visualizer and walk me through the app"
- **Ask:** "Use Dendro to check how healthy this codebase is"
- **Before an edit:** "Get the component contract for CheckoutForm first"
- **"Where does state live? Use Dendro to trace the data flow"**
- **"Show me how navigation works in this app with Dendro"**
- **"Use Dendro to explain this repo's architecture like I've never seen it"**

## What It Does

- **Component contracts** — props, state, contexts, blast radius, complexity in one call, before your agent edits
- **Health audits** — A-F grade plus line-anchored review signals (cleanup risks, possible fetch races, informational setter-only effects)
- **Complexity scoring** — every component graded, refactoring candidates named
- **Navigation mapping** — React Navigation, Next.js, React Router, Remix, Expo Router
- **Context & data flow** — providers, consumers, prop drilling detection
- **Visual canvas** — the agent highlights, annotates, and traces flows in a live dendrogram
- **Runtime inspection** — connect to a running app for live state, props, and hooks (optional)

## Check findings before changing code

Static analysis suggests places to inspect. A health grade is a heuristic,
not a correctness or performance verdict. The tree follows static imports;
lazy imports and other entry points can be absent. Reported re-render risks
need context about memoization and runtime behavior.

Read the flagged source before applying a fix. In particular, an effect can
return cleanup implicitly or through an optional chain; v0.9.0 can incorrectly
flag these as leaks. Check the running server version rather than assuming a
changelog entry means a fix is installed. Visualizer commands being queued
does not confirm that the requested nodes appeared on screen.

## Free & local

Every tool is free — exports, snapshots, verified projection, live introspection,
and batch analysis included. No account, no license key, and no code leaves your
machine. The one exception is `submit_feedback`, which sends a debrief to the
maker only when you explicitly say yes.

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
- [Tools Reference](docs/tools-reference.md) — every MCP tool with descriptions

## Feedback

Dendro is in early access. If something doesn't work, feels confusing, or you wish it did something different — I want to hear it.

- **Issues & ideas:** [GitHub Issues](https://github.com/RooneyTech/dendro-feedback/issues)
- **Email:** colin@rooneytech.com
- Or just tell your agent to use `submit_feedback` — it knows what to do.

---

*Built by [Colin Rooney](https://github.com/12mv2). Originally derived from [Reactive](https://github.com/oslabs-beta/reactive), built at OSLabs with Micah Ziegler and Susana Lam. Named after the Greek word for tree and the branching dendrites of neurons.*
