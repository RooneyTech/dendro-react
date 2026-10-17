#!/bin/bash
#
# Phase 1E Manual Verification — Build, install, test live runtime webview
#
# What this script automates:
#   1. Build (compile TS + webpack)
#   2. Package vsix
#   3. Install vsix into VS Code
#
# What you do after:
#   1. Cmd+Q VS Code (full restart required for extension reload)
#   2. Reopen VS Code
#   3. Open solsis-frontend workspace
#   4. Cmd+Shift+P → "Dendro: Show Live Runtime Tree"
#   5. In a separate terminal: cd solsis-frontend && npx expo start
#   6. Watch the D3 tree populate live
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SOLSIS_DIR="$HOME/Projects/_archive/collaborations/solsis/solsis-frontend"

cd "$PROJECT_DIR"

echo ""
echo "============================================"
echo "  Phase 1E — Build & Install"
echo "============================================"
echo ""

# Step 1: Build
echo "[1/3] Building (compile + webpack)..."
npm run build
echo "      Done."
echo ""

# Step 2: Package
echo "[2/3] Packaging vsix..."
npm run package 2>&1 | tail -3
VSIX_FILE=$(ls -t *.vsix 2>/dev/null | head -1)
if [ -z "$VSIX_FILE" ]; then
  echo "      ERROR: No .vsix file found after packaging."
  exit 1
fi
echo "      Created: $VSIX_FILE"
echo ""

# Step 3: Install
echo "[3/3] Installing extension..."
code --install-extension "$VSIX_FILE" --force 2>&1
echo "      Installed."
echo ""

echo "============================================"
echo "  Build & install complete."
echo "============================================"
echo ""
echo "  NOW DO THESE MANUAL STEPS:"
echo ""
echo "  1. Cmd+Q VS Code (full quit — extension won't reload otherwise)"
echo ""
echo "  2. Reopen VS Code and open the test workspace:"
echo "     code $SOLSIS_DIR"
echo ""
echo "  3. Cmd+Shift+P → 'Dendro: Show Live Runtime Tree'"
echo "     (this opens the runtime webview — you'll see a WAITING state)"
echo ""
echo "  4. In a separate terminal, start the Expo app:"
echo "     cd $SOLSIS_DIR && npx expo start"
echo ""
echo "  5. Open the app in a simulator or on device."
echo "     The D3 tree should populate live with a green LIVE badge."
echo ""
echo "  WHAT TO VERIFY:"
echo "  - Header shows 'dendro' with green LIVE badge"
echo "  - Stats pills show Functional / Class / Native percentages"
echo "  - D3 tree renders with component names (e.g., App, NavigationContainer)"
echo "  - Nodes show 'function', 'class', or 'host' type labels"
echo "  - Nodes show '• mapped' (if source-resolved) or '• live'"
echo "  - Click a mapped node → opens source file in editor"
echo "  - Click an unmapped node → triggers inspect (check sidebar)"
echo "  - Tree updates live when you navigate in the app"
echo "  - Disconnect the app → header switches to OFFLINE"
echo ""
echo "  To re-run just the automated tests:"
echo "  node scripts/test-phase1e-webview-runtime.js"
echo ""
