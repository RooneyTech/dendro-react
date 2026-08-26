import * as vscode from 'vscode';
import { recordWebviewError } from '../mcp/telemetry';

/**
 * Webview Bridge - Communication layer between MCP tools and webview visualizer
 *
 * This module manages:
 * 1. Registry of active webview panels
 * 2. Message routing from MCP tools to webviews
 * 3. Session management for multiple visualizers
 */

// ============================================================================
// Types - Visualization Commands
// ============================================================================

export type HighlightColor = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple';
export type AnnotationPosition = 'top' | 'right' | 'bottom' | 'left';
export type AnnotationStyle = 'callout' | 'badge' | 'tooltip';
export type FlowType = 'prop' | 'state' | 'context' | 'event';
export type ClearType = 'highlights' | 'annotations' | 'flows' | 'all';

export interface HighlightCommand {
  type: 'highlight';
  payload: {
    nodes: string[];      // File paths or component names
    color: HighlightColor;
    label?: string;
    pulse?: boolean;
    duration?: number;    // Auto-clear after N seconds (0 = permanent)
  };
}

export interface ZoomCommand {
  type: 'zoom';
  payload: {
    target: string | string[];  // Node(s) to zoom to
    padding?: number;           // Padding around target (default: 50px)
    duration?: number;          // Animation duration in ms
  };
}

export interface AnnotateCommand {
  type: 'annotate';
  payload: {
    nodeId: string;
    text: string;
    position?: AnnotationPosition;
    style?: AnnotationStyle;
    color?: string;
  };
}

export interface TraceFlowCommand {
  type: 'traceFlow';
  payload: {
    nodes: string[];        // Ordered path of flow
    label?: string;
    color?: string;
    animated?: boolean;
    flowType?: FlowType;
  };
}

export interface ClearCommand {
  type: 'clear';
  payload: {
    clearType?: ClearType;
    ids?: string[];         // Specific IDs to clear
  };
}

export interface ExpandCommand {
  type: 'expand';
  payload: {
    nodeId: string;
    recursive?: boolean;
  };
}

export interface CollapseCommand {
  type: 'collapse';
  payload: {
    nodeId: string;
  };
}

export interface FitAllCommand {
  type: 'fitAll';
  payload: {
    duration?: number;    // Animation duration in ms (default: 1500)
    padding?: number;     // Padding around tree (default: 60)
  };
}

export interface StartTourCommand {
  type: 'startTour';
  payload: {
    tourConfig: {
      title: string;
      steps: Array<{
        title: string;
        description: string;
        commands: Array<{ type: string; payload?: Record<string, unknown> }>;
        autoAdvanceMs?: number;
      }>;
      autoPlay?: boolean;
      clearOnExit?: boolean;
    };
  };
}

export interface ReadyCommand {
  type: 'ready';
  payload: {
    sessionId: string;
  };
}

export type VisualizationCommand =
  | HighlightCommand
  | ZoomCommand
  | AnnotateCommand
  | TraceFlowCommand
  | ClearCommand
  | ExpandCommand
  | CollapseCommand
  | FitAllCommand
  | StartTourCommand;

// Response from webview after executing a command
export interface CommandResponse {
  success: boolean;
  commandType: string;
  data?: {
    highlightedCount?: number;
    requestedCount?: number;
    notFound?: string[];
    annotationId?: string;
    flowId?: string;
    note?: string;
  };
  error?: string;
}

// ============================================================================
// Webview Registry - Singleton to track active panels
// ============================================================================

export interface WebviewSession {
  panel: vscode.WebviewPanel;
  entryFile: string;
  ready: boolean;
  nodeMap?: Map<string, string>;  // Maps file paths/names to node IDs
}

class WebviewRegistry {
  private sessions: Map<string, WebviewSession> = new Map();
  private sessionCounter = 0;
  private pendingCommands: Map<string, VisualizationCommand[]> = new Map();
  private pendingBatches: Map<string, Array<{
    commands: Array<{ type: string; payload?: Record<string, unknown>; label?: string }>;
    waitForUser: boolean;
  }>> = new Map();

  /**
   * Register a new webview panel
   */
  registerPanel(panel: vscode.WebviewPanel, entryFile: string): string {
    const sessionId = `dendro-session-${++this.sessionCounter}`;

    this.sessions.set(sessionId, {
      panel,
      entryFile,
      ready: false
    });

    // Clean up when panel is disposed
    panel.onDidDispose(() => {
      this.sessions.delete(sessionId);
      this.pendingCommands.delete(sessionId);
      this.pendingBatches.delete(sessionId);
    });

    // Listen for ready signal from webview
    panel.webview.onDidReceiveMessage((message) => {
      if (message.type === 'visualizerReady') {
        const session = this.sessions.get(sessionId);
        if (session) {
          session.ready = true;
          // Execute any pending commands
          this.flushPendingCommands(sessionId);
        }
      } else if (message.type === 'commandResponse') {
        console.log('Dendro: Command response:', message);
      } else if (message.type === 'commandResult') {
        // Actual result from command queue execution (for diagnostics)
        const result = message.result;
        if (result?.notFound?.length > 0) {
          console.warn(`Dendro: ${message.commandType} — ${result.notFound.length} node(s) not found in tree:`, result.notFound);
        }
      } else if (message.type === 'webviewError') {
        console.error(`Dendro: webview ${sessionId} reported ${message.kind}:`, message.message, message.stack ?? '');
        recordWebviewError({
          kind: String(message.kind ?? 'error'),
          message: String(message.message ?? 'unknown'),
          stack: message.stack ? String(message.stack) : undefined,
          sessionId,
        });
      }
    });

    return sessionId;
  }

  /**
   * Get session by ID
   */
  getSession(sessionId: string): WebviewSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get all active sessions
   */
  getAllSessions(): Map<string, WebviewSession> {
    return this.sessions;
  }

  /**
   * Get the most recent session (convenience for single-webview use)
   */
  getActiveSession(): { sessionId: string; session: WebviewSession } | undefined {
    const entries = Array.from(this.sessions.entries());
    if (entries.length === 0) return undefined;

    // Return the most recently created session
    const [sessionId, session] = entries[entries.length - 1];
    return { sessionId, session };
  }

  /**
   * Find session by entry file
   */
  findSessionByFile(entryFile: string): { sessionId: string; session: WebviewSession } | undefined {
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.entryFile === entryFile) {
        return { sessionId, session };
      }
    }
    return undefined;
  }

  /**
   * Send a visualization command to a webview
   */
  sendCommand(sessionId: string | undefined, command: VisualizationCommand): boolean {
    // If no sessionId provided, use the active session
    let targetSession: WebviewSession | undefined;
    let targetSessionId = sessionId;

    if (!targetSessionId) {
      const active = this.getActiveSession();
      if (!active) {
        console.warn('Dendro: No active webview session');
        return false;
      }
      targetSessionId = active.sessionId;
      targetSession = active.session;
    } else {
      targetSession = this.sessions.get(targetSessionId);
    }

    if (!targetSession) {
      console.warn(`Dendro: Session not found: ${targetSessionId}`);
      return false;
    }

    // If webview isn't ready yet, queue the command
    if (!targetSession.ready) {
      if (!this.pendingCommands.has(targetSessionId)) {
        this.pendingCommands.set(targetSessionId, []);
      }
      this.pendingCommands.get(targetSessionId)!.push(command);
      console.log(`Dendro: Queued command for session ${targetSessionId}`);
      return true;
    }

    // Send command to webview
    targetSession.panel.webview.postMessage({
      type: 'visualizerCommand',
      command
    });

    return true;
  }

  /**
   * Send a batch of visualization commands to a webview with optional manual advance.
   * When waitForUser is true, the webview shows a "Next" button between each command.
   */
  sendBatch(
    sessionId: string | undefined,
    commands: Array<{ type: string; payload?: Record<string, unknown>; label?: string }>,
    waitForUser: boolean
  ): boolean {
    let targetSession: WebviewSession | undefined;
    let targetSessionId = sessionId;

    if (!targetSessionId) {
      const active = this.getActiveSession();
      if (!active) {
        console.warn('Dendro: No active webview session for batch');
        return false;
      }
      targetSessionId = active.sessionId;
      targetSession = active.session;
    } else {
      targetSession = this.sessions.get(targetSessionId);
    }

    if (!targetSession) {
      console.warn(`Dendro: Session not found for batch: ${targetSessionId}`);
      return false;
    }

    // If webview isn't ready yet, queue the entire batch (preserving waitForUser)
    if (!targetSession.ready) {
      if (!this.pendingBatches.has(targetSessionId)) {
        this.pendingBatches.set(targetSessionId, []);
      }
      this.pendingBatches.get(targetSessionId)!.push({ commands, waitForUser });
      console.log(`Dendro: Queued batch of ${commands.length} commands (waitForUser=${waitForUser}) for session ${targetSessionId}`);
      return true;
    }

    targetSession.panel.webview.postMessage({
      type: 'batchVisualizerCommands',
      commands: commands.map(cmd => ({ type: cmd.type, payload: cmd.payload || {}, label: cmd.label })),
      waitForUser
    });

    return true;
  }

  /**
   * Flush pending commands for a session
   */
  private flushPendingCommands(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Flush individual pending commands
    const pending = this.pendingCommands.get(sessionId);
    if (pending && pending.length > 0) {
      console.log(`Dendro: Flushing ${pending.length} pending commands for ${sessionId}`);
      for (const command of pending) {
        session.panel.webview.postMessage({
          type: 'visualizerCommand',
          command
        });
      }
      this.pendingCommands.delete(sessionId);
    }

    // Flush pending batches (preserves waitForUser and labels)
    const batches = this.pendingBatches.get(sessionId);
    if (batches && batches.length > 0) {
      console.log(`Dendro: Flushing ${batches.length} pending batch(es) for ${sessionId}`);
      for (const batch of batches) {
        session.panel.webview.postMessage({
          type: 'batchVisualizerCommands',
          commands: batch.commands.map(cmd => ({ type: cmd.type, payload: cmd.payload || {}, label: cmd.label })),
          waitForUser: batch.waitForUser
        });
      }
      this.pendingBatches.delete(sessionId);
    }
  }

  /**
   * Mark a session as ready (called when webview reports ready)
   */
  markReady(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.ready = true;
      this.flushPendingCommands(sessionId);
    }
  }

  /**
   * Check if any session is active
   */
  hasActiveSessions(): boolean {
    return this.sessions.size > 0;
  }

  /**
   * Get count of active sessions
   */
  getSessionCount(): number {
    return this.sessions.size;
  }
}

// Singleton instance
export const webviewRegistry = new WebviewRegistry();

// ============================================================================
// MCP Bridge Functions - Called by MCP tools
// ============================================================================

export interface VisualizeHighlightResult {
  success: boolean;
  sessionId?: string;
  requestedCount?: number;
  note?: string;
  error?: string;
}

export interface VisualizeZoomResult {
  success: boolean;
  sessionId?: string;
  error?: string;
}

export interface VisualizeAnnotateResult {
  success: boolean;
  sessionId?: string;
  annotationId?: string;
  error?: string;
}

export interface VisualizeTraceFlowResult {
  success: boolean;
  sessionId?: string;
  flowId?: string;
  error?: string;
}

export interface VisualizeClearResult {
  success: boolean;
  sessionId?: string;
  error?: string;
}

export interface VisualizeExpandResult {
  success: boolean;
  sessionId?: string;
  error?: string;
}

export interface VisualizeCollapseResult {
  success: boolean;
  sessionId?: string;
  error?: string;
}

/**
 * Send highlight command to webview
 */
export function visualizeHighlight(
  nodes: string[],
  color: HighlightColor,
  options?: {
    sessionId?: string;
    label?: string;
    pulse?: boolean;
    duration?: number;
  }
): VisualizeHighlightResult {
  const command: HighlightCommand = {
    type: 'highlight',
    payload: {
      nodes,
      color,
      label: options?.label,
      pulse: options?.pulse ?? true,
      duration: options?.duration ?? 0
    }
  };

  const success = webviewRegistry.sendCommand(options?.sessionId, command);

  if (!success) {
    return {
      success: false,
      error: 'No active visualizer session. Open the Dendro visualizer first.'
    };
  }

  const active = webviewRegistry.getActiveSession();
  return {
    success: true,
    sessionId: options?.sessionId || active?.sessionId,
    requestedCount: nodes.length,
    note: 'Highlight command sent. If nodes are not in the visualized tree, they will be silently skipped. Use node names from get_component_tree results for reliable highlighting.'
  };
}

/**
 * Send zoom command to webview
 */
export function visualizeZoom(
  target: string | string[],
  options?: {
    sessionId?: string;
    padding?: number;
    duration?: number;
  }
): VisualizeZoomResult {
  const command: ZoomCommand = {
    type: 'zoom',
    payload: {
      target,
      padding: options?.padding ?? 50,
      duration: options?.duration ?? 750
    }
  };

  const success = webviewRegistry.sendCommand(options?.sessionId, command);

  if (!success) {
    return {
      success: false,
      error: 'No active visualizer session. Open the Dendro visualizer first.'
    };
  }

  const active = webviewRegistry.getActiveSession();
  return {
    success: true,
    sessionId: options?.sessionId || active?.sessionId
  };
}

/**
 * Send annotate command to webview
 */
export function visualizeAnnotate(
  nodeId: string,
  text: string,
  options?: {
    sessionId?: string;
    position?: AnnotationPosition;
    style?: AnnotationStyle;
    color?: string;
  }
): VisualizeAnnotateResult {
  const command: AnnotateCommand = {
    type: 'annotate',
    payload: {
      nodeId,
      text,
      position: options?.position ?? 'right',
      style: options?.style ?? 'callout',
      color: options?.color
    }
  };

  const success = webviewRegistry.sendCommand(options?.sessionId, command);

  if (!success) {
    return {
      success: false,
      error: 'No active visualizer session. Open the Dendro visualizer first.'
    };
  }

  const active = webviewRegistry.getActiveSession();
  return {
    success: true,
    sessionId: options?.sessionId || active?.sessionId,
    annotationId: `annotation-${Date.now()}`  // Actual ID would come from webview
  };
}

/**
 * Send trace flow command to webview
 */
export function visualizeTraceFlow(
  nodes: string[],
  options?: {
    sessionId?: string;
    label?: string;
    color?: string;
    animated?: boolean;
    flowType?: FlowType;
  }
): VisualizeTraceFlowResult {
  const command: TraceFlowCommand = {
    type: 'traceFlow',
    payload: {
      nodes,
      label: options?.label,
      color: options?.color ?? '#ff4444',
      animated: options?.animated ?? true,
      flowType: options?.flowType ?? 'prop'
    }
  };

  const success = webviewRegistry.sendCommand(options?.sessionId, command);

  if (!success) {
    return {
      success: false,
      error: 'No active visualizer session. Open the Dendro visualizer first.'
    };
  }

  const active = webviewRegistry.getActiveSession();
  return {
    success: true,
    sessionId: options?.sessionId || active?.sessionId,
    flowId: `flow-${Date.now()}`  // Actual ID would come from webview
  };
}

/**
 * Send clear command to webview
 */
export function visualizeClear(
  clearType?: ClearType,
  options?: {
    sessionId?: string;
    ids?: string[];
  }
): VisualizeClearResult {
  const command: ClearCommand = {
    type: 'clear',
    payload: {
      clearType: clearType ?? 'all',
      ids: options?.ids
    }
  };

  const success = webviewRegistry.sendCommand(options?.sessionId, command);

  if (!success) {
    return {
      success: false,
      error: 'No active visualizer session. Open the Dendro visualizer first.'
    };
  }

  const active = webviewRegistry.getActiveSession();
  return {
    success: true,
    sessionId: options?.sessionId || active?.sessionId
  };
}

/**
 * Send expand command to webview
 */
export function visualizeExpand(
  nodeId: string,
  options?: {
    sessionId?: string;
    recursive?: boolean;
  }
): VisualizeExpandResult {
  const command: ExpandCommand = {
    type: 'expand',
    payload: {
      nodeId,
      recursive: options?.recursive ?? false
    }
  };

  const success = webviewRegistry.sendCommand(options?.sessionId, command);

  if (!success) {
    return {
      success: false,
      error: 'No active visualizer session. Open the Dendro visualizer first.'
    };
  }

  const active = webviewRegistry.getActiveSession();
  return {
    success: true,
    sessionId: options?.sessionId || active?.sessionId
  };
}

/**
 * Send collapse command to webview
 */
export function visualizeCollapse(
  nodeId: string,
  options?: {
    sessionId?: string;
  }
): VisualizeCollapseResult {
  const command: CollapseCommand = {
    type: 'collapse',
    payload: {
      nodeId
    }
  };

  const success = webviewRegistry.sendCommand(options?.sessionId, command);

  if (!success) {
    return {
      success: false,
      error: 'No active visualizer session. Open the Dendro visualizer first.'
    };
  }

  const active = webviewRegistry.getActiveSession();
  return {
    success: true,
    sessionId: options?.sessionId || active?.sessionId
  };
}

// ============================================================================
// Fit All
// ============================================================================

export interface VisualizeFitAllResult {
  success: boolean;
  sessionId?: string;
  error?: string;
}

/**
 * Send fit-all command to webview — zooms viewport to fit entire tree
 */
export function visualizeFitAll(
  options?: {
    sessionId?: string;
    duration?: number;
    padding?: number;
  }
): VisualizeFitAllResult {
  const command: FitAllCommand = {
    type: 'fitAll',
    payload: {
      duration: options?.duration ?? 1500,
      padding: options?.padding ?? 60
    }
  };

  const success = webviewRegistry.sendCommand(options?.sessionId, command);

  if (!success) {
    return {
      success: false,
      error: 'No active visualizer session. Open the Dendro visualizer first.'
    };
  }

  const active = webviewRegistry.getActiveSession();
  return {
    success: true,
    sessionId: options?.sessionId || active?.sessionId
  };
}
