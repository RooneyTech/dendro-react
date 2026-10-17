/**
 * Visualizer Bridge — File-based IPC for visualizer readiness signaling.
 *
 * The MCP server writes a "pending" status before firing the open_visualizer URI.
 * The VS Code extension writes "ready" when the webview posts visualizerReady.
 * The MCP server polls for the ready signal with a timeout.
 *
 * @module visualizer-bridge
 */

import * as fs from 'fs';
import * as path from 'path';
import { getWorkspaceIpcDir, ensureDir } from './ipc-paths';

function getDendroDir(): string { return getWorkspaceIpcDir(); }
function getVisualizerStatusFile(): string { return path.join(getDendroDir(), 'visualizer-status.json'); }

export interface VisualizerStatus {
  sessionId: string;
  entryFile: string;
  status: 'pending' | 'ready';
  timestamp: number;
}

/** Exported paths for testing */
export function getVisualizerPaths() {
  return {
    statusFile: getVisualizerStatusFile(),
    dendroDir: getDendroDir(),
  };
}

function ensureDendroDir(): void {
  ensureDir(getDendroDir());
}

let pendingCounter = 0;

/**
 * Write a pending status (called by MCP server before firing URI).
 * Returns the generated session ID.
 */
export function writeVisualizerPending(entryFile: string): string {
  ensureDendroDir();
  const sessionId = `viz-${Date.now()}-${++pendingCounter}`;
  const status: VisualizerStatus = {
    sessionId,
    entryFile,
    status: 'pending',
    timestamp: Date.now(),
  };
  fs.writeFileSync(getVisualizerStatusFile(), JSON.stringify(status), { encoding: 'utf-8', mode: 0o600 });
  return sessionId;
}

/**
 * Write a ready status (called by extension when webview reports ready).
 */
export function writeVisualizerReady(sessionId: string, entryFile: string): void {
  ensureDendroDir();
  const status: VisualizerStatus = {
    sessionId,
    entryFile,
    status: 'ready',
    timestamp: Date.now(),
  };
  fs.writeFileSync(getVisualizerStatusFile(), JSON.stringify(status), { encoding: 'utf-8', mode: 0o600 });
}

/**
 * Read the current visualizer status.
 */
export function readVisualizerStatus(): VisualizerStatus | null {
  try {
    if (!fs.existsSync(getVisualizerStatusFile())) return null;
    const content = fs.readFileSync(getVisualizerStatusFile(), 'utf-8');
    return JSON.parse(content) as VisualizerStatus;
  } catch {
    return null;
  }
}

/**
 * Poll for visualizer ready signal.
 * Returns the status when ready, or null on timeout.
 */
export function pollVisualizerReady(
  timeoutMs: number = 5000,
  intervalMs: number = 200
): Promise<VisualizerStatus | null> {
  return new Promise((resolve) => {
    const start = Date.now();

    const check = () => {
      const status = readVisualizerStatus();
      if (status && status.status === 'ready') {
        resolve(status);
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        resolve(null);
        return;
      }
      setTimeout(check, intervalMs);
    };

    check();
  });
}

/**
 * Clear the visualizer status file.
 */
export function clearVisualizerStatus(): void {
  try {
    if (fs.existsSync(getVisualizerStatusFile())) {
      fs.unlinkSync(getVisualizerStatusFile());
    }
  } catch {
    // Ignore errors on cleanup
  }
}
