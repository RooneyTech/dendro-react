/*
INITIALIZATION FLOW:
1. Import required dependencies
2. Set up DOM container for React
3. Create message listener for VSCode extension communication
4. Handle component tree data and render visualization

COMPONENT HIERARCHY:
Root
├── AppHeader (Statistics & App Info)
└── Dendrogram (Tree Visualization)
*/

import React from "react";
import { createRoot } from "react-dom/client";
import AppHeader from "./AppHeader";
import Dendrogram from "./Dendrogram";
import DendriteLoader from "./DendriteLoader";
import TourPanel from "./TourPanel";

/*
ROOT CONTAINER SETUP
Purpose: Ensure we have a single, consistent mounting point for React
Process:
1. Try to find existing root element
2. If not found, create new one
3. Initialize React root once
*/
const container = document.getElementById("root") || document.createElement("div");
if (!container.id) {
  container.id = "root";
  document.body.appendChild(container);
}
const root = createRoot(container);

/*
ERROR BOUNDARY
Purpose: Contain render-phase crashes instead of letting React unmount the
whole tree, and report them to the extension for local telemetry. Recovers
automatically on the next render (new data message).
*/
class DendroErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    const api = typeof vscode !== 'undefined' ? vscode : null;
    if (api) {
      api.postMessage({
        type: 'webviewError',
        kind: 'react-render',
        message: String(error && error.message ? error.message : error),
        stack: (error && error.stack ? error.stack + '\n' : '') + (info && info.componentStack ? info.componentStack : ''),
        sessionId: window.dendroSessionId,
      });
    }
  }
  componentDidUpdate(prevProps) {
    if (this.state.error && prevProps.children !== this.props.children) {
      this.setState({ error: null });
    }
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 20, fontFamily: 'monospace', color: '#ff6b6b' }}>
          Dendro hit a rendering error: {String(this.state.error.message || this.state.error)}
          <div style={{ marginTop: 8, color: '#999' }}>It will recover on the next update, or reload the panel.</div>
        </div>
      );
    }
    return this.props.children;
  }
}

const renderRoot = (element) => root.render(<DendroErrorBoundary>{element}</DendroErrorBoundary>);

// Theme detection from VS Code
let currentDarkMode = window.dendroInitialTheme !== 'light';

// Tour state
let currentTourConfig = null;
let lastRenderData = null; // Cache last render data for tour re-renders

/*
STATS CALCULATION FUNCTION
Purpose: Analyze component tree to generate statistics
Input: Component tree data object
Output: Object containing component type counts
Process:
1. Initialize counters
2. Recursively traverse tree
3. Categorize each component
4. Return statistics object

Data Structure Expected:
{
  type: "functional" | "class" | other,
  children: Array<Component>,
  ...other properties
}
*/
const calculateComponentStats = (data) => {
  // Return default stats if no data
  if (!data) return {
    functionalCount: 0,
    classCount: 0,
    nullCount: 0,
    totalComponents: 0,
  };

  // Initialize counters
  let functionalCount = 0;
  let classCount = 0;
  let nullCount = 0;

  /*
  TREE TRAVERSAL FUNCTION
  Purpose: Recursive component counting
  Process:
  1. Check component type
  2. Increment appropriate counter
  3. Recursively process children
  */
  const traverseForStats = (node) => {
    if (node.type && typeof node.type === "string") {
      // Categorize component based on type
      if (node.type.toLowerCase().includes("function")) functionalCount++;
      else if (node.type.toLowerCase().includes("class")) classCount++;
      else nullCount++;
    }
    // Process children recursively
    if (node.children) {
      node.children.forEach(traverseForStats);
    }
  };

  traverseForStats(data);
  return {
    functionalCount,
    classCount,
    nullCount,
    totalComponents: functionalCount + classCount + nullCount,
  };
};

/*
VSCODE API
Purpose: Access the VS Code API that was already acquired in the HTML template
Note: acquireVsCodeApi can only be called once per webview, so we use the
global 'vscode' variable that was created in the HTML script tag
*/
const getVsCodeApi = () => {
  // Use the global vscode object created in extension.ts HTML template
  return typeof vscode !== 'undefined' ? vscode : null;
};

/*
VISUALIZATION COMMAND HANDLER
Purpose: Reference to current Dendrogram command handler
This is set by the Dendrogram component when it mounts
*/
let visualizationCommandHandler = null;

// Export setter for Dendrogram to register its command handler
window.setVisualizationCommandHandler = (handler) => {
  visualizationCommandHandler = handler;
  // Expose for TourPanel to use directly
  window._dendroVisualizationCommandHandler = handler;
  console.log('Dendro: Visualization command handler registered');

  // Signal to extension that we're ready to receive commands
  const vscode = getVsCodeApi();
  if (vscode) {
    vscode.postMessage({
      type: 'visualizerReady',
      sessionId: window.dendroSessionId
    });
    console.log('Dendro: Sent visualizerReady signal');
  }
};

/*
RUNTIME MODE DETECTION
If window.dendroRuntimeMode is set (by the extension HTML template),
we start in runtime mode showing a waiting state until tree data arrives.
*/
if (window.dendroRuntimeMode) {
  renderRoot(
    <div className="h-screen w-screen">
      <AppHeader
        stats={{ functionalCount: 0, classCount: 0, nullCount: 0, totalComponents: 0 }}
        filePath="Waiting for runtime connection..."
        darkMode={currentDarkMode}
        isRuntime={true}
        runtimeStatus="waiting"
      />
      <DendriteLoader darkMode={currentDarkMode} />
    </div>
  );
}

/*
RUNTIME STATS CALCULATOR
Purpose: Calculate stats from runtime tree data (has different type names)
*/
const calculateRuntimeStats = (data) => {
  if (!data) return {
    functionalCount: 0,
    classCount: 0,
    hostCount: 0,
    otherCount: 0,
    totalComponents: 0,
  };

  let functionalCount = 0;
  let classCount = 0;
  let hostCount = 0;
  let otherCount = 0;

  const traverse = (node) => {
    if (node._runtimeType === 'function') functionalCount++;
    else if (node._runtimeType === 'class') classCount++;
    else if (node._runtimeType === 'host') hostCount++;
    else if (node.type) {
      if (node.type === 'functional') functionalCount++;
      else if (node.type === 'class') classCount++;
      else otherCount++;
    } else {
      otherCount++;
    }
    if (node.children) node.children.forEach(traverse);
  };

  traverse(data);
  return {
    functionalCount,
    classCount,
    hostCount,
    otherCount,
    nullCount: hostCount + otherCount,
    totalComponents: functionalCount + classCount + hostCount + otherCount,
  };
};

/*
TOUR RE-RENDER HELPER
Purpose: Re-render the current view with or without TourPanel overlay.
Called when tour starts or exits to add/remove the tour panel.
*/
function renderCurrentView() {
  if (!lastRenderData) return;

  const d = lastRenderData;
  if (d.type === 'static') {
    renderRoot(
      <div className="h-screen w-screen">
        <AppHeader
          key={d.appName}
          stats={d.stats}
          appName={d.appName}
          filePath={d.filePath}
          darkMode={currentDarkMode}
        />
        {d.astData && Object.keys(d.astData).length > 0 ? (
          <Dendrogram data={d.astData} sessionId={d.sessionId} />
        ) : (
          <DendriteLoader darkMode={currentDarkMode} />
        )}
        {currentTourConfig && (
          <TourPanel
            config={currentTourConfig}
            darkMode={currentDarkMode}
            onExit={() => {
              currentTourConfig = null;
              renderCurrentView();
            }}
          />
        )}
      </div>
    );
  } else if (d.type === 'runtime') {
    renderRoot(
      <div className="h-screen w-screen">
        <AppHeader
          stats={d.stats}
          filePath={d.filePath}
          darkMode={currentDarkMode}
          isRuntime={true}
          runtimeStatus="connected"
        />
        {d.treeData && Object.keys(d.treeData).length > 0 ? (
          <Dendrogram data={d.treeData} sessionId={d.sessionId} isRuntime={true} />
        ) : (
          <DendriteLoader darkMode={currentDarkMode} />
        )}
        {currentTourConfig && (
          <TourPanel
            config={currentTourConfig}
            darkMode={currentDarkMode}
            onExit={() => {
              currentTourConfig = null;
              renderCurrentView();
            }}
          />
        )}
      </div>
    );
  }
}

/*
MESSAGE HANDLER
Purpose: Communication bridge with VSCode extension
Process:
1. Listen for 'astData' messages (static mode)
2. Listen for 'runtimeTreeData' messages (runtime mode)
3. Listen for 'runtimeStatus' messages (connection status updates)
4. Handle visualization commands from AI
5. Handle theme changes from VS Code
*/
window.addEventListener("message", (event) => {
  // Handle static tree data messages
  if (event.data.type === "astData") {
    const astData = event.data.payload.treeData || {};
    const filePath = event.data.payload.filePath || "Unknown Component Path";
    const sessionId = event.data.payload.sessionId || window.dendroSessionId;
    const appName = event.data.appName || "";

    const stats = calculateComponentStats(astData);

    // Cache render data for tour re-renders
    lastRenderData = { type: 'static', astData, filePath, sessionId, appName, stats };

    renderRoot(
      <div className="h-screen w-screen">
        <AppHeader
          key={appName}
          stats={stats}
          appName={appName}
          filePath={filePath}
          darkMode={currentDarkMode}
        />

        {astData && Object.keys(astData).length > 0 ? (
          <Dendrogram data={astData} sessionId={sessionId} />
        ) : (
          <DendriteLoader darkMode={currentDarkMode} />
        )}

        {currentTourConfig && (
          <TourPanel
            config={currentTourConfig}
            darkMode={currentDarkMode}
            onExit={() => {
              currentTourConfig = null;
              renderCurrentView();
            }}
          />
        )}
      </div>
    );
  }

  // Handle runtime tree data messages
  if (event.data.type === "runtimeTreeData") {
    const treeData = event.data.payload.treeData || {};
    const componentCount = event.data.payload.componentCount || 0;
    const sessionId = event.data.payload.sessionId || window.dendroSessionId;

    const stats = calculateRuntimeStats(treeData);
    const filePath = `Live Runtime \u2022 ${componentCount} components`;

    // Cache render data for tour re-renders
    lastRenderData = { type: 'runtime', treeData, filePath, sessionId, stats };

    renderRoot(
      <div className="h-screen w-screen">
        <AppHeader
          stats={stats}
          filePath={filePath}
          darkMode={currentDarkMode}
          isRuntime={true}
          runtimeStatus="connected"
        />

        {treeData && Object.keys(treeData).length > 0 ? (
          <Dendrogram data={treeData} sessionId={sessionId} isRuntime={true} />
        ) : (
          <DendriteLoader darkMode={currentDarkMode} />
        )}

        {currentTourConfig && (
          <TourPanel
            config={currentTourConfig}
            darkMode={currentDarkMode}
            onExit={() => {
              currentTourConfig = null;
              renderCurrentView();
            }}
          />
        )}
      </div>
    );
  }

  // Handle runtime status updates (disconnect/reconnect)
  if (event.data.type === "runtimeStatus") {
    const status = event.data.payload.status;

    if (status === 'disconnected' || status === 'listening') {
      renderRoot(
        <div className="h-screen w-screen">
          <AppHeader
            stats={{ functionalCount: 0, classCount: 0, nullCount: 0, totalComponents: 0 }}
            filePath={status === 'listening' ? 'Waiting for app to connect...' : 'Disconnected'}
            darkMode={currentDarkMode}
            isRuntime={true}
            runtimeStatus={status}
          />
          <DendriteLoader darkMode={currentDarkMode} />
        </div>
      );
    }
  }

  // Handle batch visualization commands (manual advance / waitForUser)
  if (event.data.type === "batchVisualizerCommands") {
    const { commands, waitForUser } = event.data;
    console.log(`Dendro: Received batch of ${commands.length} commands, waitForUser=${waitForUser}`);
    if (window.dendroHandleBatchCommands) {
      window.dendroHandleBatchCommands(commands, waitForUser);
    } else {
      console.warn('Dendro: No batch command handler registered yet');
    }
    return;
  }

  // Handle visualization commands from AI
  if (event.data.type === "visualizerCommand") {
    const command = event.data.command;
    console.log('Dendro: Received visualization command:', command.type);

    // Intercept tour start commands
    if (command.type === 'startTour') {
      console.log('Dendro: Starting tour:', command.payload?.tourConfig?.title);
      currentTourConfig = command.payload?.tourConfig;
      renderCurrentView();

      const vscode = getVsCodeApi();
      if (vscode) {
        vscode.postMessage({
          type: 'commandResponse',
          commandType: 'startTour',
          response: { success: true }
        });
      }
      return;
    }

    if (visualizationCommandHandler) {
      const result = visualizationCommandHandler(command);

      const vscode = getVsCodeApi();
      if (vscode) {
        vscode.postMessage({
          type: 'commandResponse',
          commandType: command.type,
          response: result
        });
      }
    } else {
      console.warn('Dendro: No command handler registered yet');
    }
  }

  // Handle VS Code theme changes
  if (event.data.type === "themeChanged") {
    currentDarkMode = event.data.darkMode;
    // Dendrogram handles its own re-render via internal useEffect listener.
    // AppHeader will pick up the new value on the next data-triggered render.
  }

  // Handle projector mode changes (Dendrogram picks this up via its own listener)
  if (event.data.type === "projectorModeChanged") {
    window.dendroProjectorMode = event.data.projectorMode;
  }
});

