/**
 * Inspect Bridge — File-based request/response IPC for component inspection.
 *
 * The MCP server writes inspect requests to ~/.dendro/inspect-request.json.
 * The VS Code extension watches for new requests, calls inspectElement() on
 * the DevToolsConnector, and writes results to ~/.dendro/inspect-result.json.
 * The MCP server polls for the result with a timeout.
 *
 * @module inspect-bridge
 */

import * as fs from 'fs';
import * as path from 'path';
import { getWorkspaceIpcDir, ensureDir } from './ipc-paths';

function getDendroDir(): string { return getWorkspaceIpcDir(); }
function getInspectRequestFile(): string { return path.join(getDendroDir(), 'inspect-request.json'); }
function getInspectResultFile(): string { return path.join(getDendroDir(), 'inspect-result.json'); }

export interface InspectRequest {
  requestId: string;
  elementId: number;
  componentName: string;
  timestamp: number;
}

export interface InspectResult {
  requestId: string;
  elementId: number;
  componentName: string;
  props: Record<string, unknown>;
  state: Record<string, unknown> | null;
  hooks: Array<{ id: number; name: string; value: unknown; subHooks: unknown[] }> | null;
  context: Record<string, unknown> | null;
  timestamp: number;
  success: boolean;
  error?: string;
}

function ensureDendroDir(): void {
  ensureDir(getDendroDir());
}

/**
 * Write an inspect request (called by MCP server).
 */
export function writeInspectRequest(request: InspectRequest): void {
  ensureDendroDir();
  fs.writeFileSync(getInspectRequestFile(), JSON.stringify(request), { encoding: 'utf-8', mode: 0o600 });
}

/**
 * Read the current inspect request (called by extension).
 */
export function readInspectRequest(): InspectRequest | null {
  try {
    if (!fs.existsSync(getInspectRequestFile())) return null;
    const content = fs.readFileSync(getInspectRequestFile(), 'utf-8');
    return JSON.parse(content) as InspectRequest;
  } catch {
    return null;
  }
}

/**
 * Write an inspect result (called by extension after fulfilling request).
 */
export function writeInspectResult(result: InspectResult): void {
  ensureDendroDir();
  fs.writeFileSync(getInspectResultFile(), JSON.stringify(result), { encoding: 'utf-8', mode: 0o600 });
}

/**
 * Read the current inspect result (called by MCP server).
 */
export function readInspectResult(): InspectResult | null {
  try {
    if (!fs.existsSync(getInspectResultFile())) return null;
    const content = fs.readFileSync(getInspectResultFile(), 'utf-8');
    return JSON.parse(content) as InspectResult;
  } catch {
    return null;
  }
}

/**
 * Clear the inspect request file (called by extension after fulfilling).
 */
export function clearInspectRequest(): void {
  try {
    if (fs.existsSync(getInspectRequestFile())) {
      fs.unlinkSync(getInspectRequestFile());
    }
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Clear the inspect result file.
 */
export function clearInspectResult(): void {
  try {
    if (fs.existsSync(getInspectResultFile())) {
      fs.unlinkSync(getInspectResultFile());
    }
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Poll for an inspect result matching a specific requestId.
 * Polls every 100ms up to the timeout (default 6s).
 */
export async function pollInspectResult(
  requestId: string,
  timeoutMs: number = 6000
): Promise<InspectResult | null> {
  const startTime = Date.now();
  const pollInterval = 100;

  while (Date.now() - startTime < timeoutMs) {
    const result = readInspectResult();
    if (result && result.requestId === requestId) {
      return result;
    }
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  return null;
}

/**
 * Generate a unique request ID.
 */
export function generateRequestId(): string {
  return `inspect-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Override Bridge — File-based IPC for state modification
// ---------------------------------------------------------------------------

function getOverrideRequestFile(): string { return path.join(getDendroDir(), 'override-request.json'); }
function getOverrideResultFile(): string { return path.join(getDendroDir(), 'override-result.json'); }

export interface OverrideRequest {
  requestId: string;
  elementId: number;
  componentName: string;
  type: 'props' | 'state' | 'hooks' | 'context';
  path: string[];
  value: unknown;
  hookID?: number;
  timestamp: number;
}

export interface OverrideResult {
  requestId: string;
  elementId: number;
  componentName: string;
  type: 'props' | 'state' | 'hooks' | 'context';
  path: string[];
  value: unknown;
  timestamp: number;
  success: boolean;
  error?: string;
}

/**
 * Write an override request (called by MCP server).
 */
export function writeOverrideRequest(request: OverrideRequest): void {
  ensureDendroDir();
  fs.writeFileSync(getOverrideRequestFile(), JSON.stringify(request), { encoding: 'utf-8', mode: 0o600 });
}

/**
 * Read the current override request (called by extension).
 */
export function readOverrideRequest(): OverrideRequest | null {
  try {
    if (!fs.existsSync(getOverrideRequestFile())) return null;
    const content = fs.readFileSync(getOverrideRequestFile(), 'utf-8');
    return JSON.parse(content) as OverrideRequest;
  } catch {
    return null;
  }
}

/**
 * Write an override result (called by extension after fulfilling request).
 */
export function writeOverrideResult(result: OverrideResult): void {
  ensureDendroDir();
  fs.writeFileSync(getOverrideResultFile(), JSON.stringify(result), { encoding: 'utf-8', mode: 0o600 });
}

/**
 * Read the current override result (called by MCP server).
 */
export function readOverrideResult(): OverrideResult | null {
  try {
    if (!fs.existsSync(getOverrideResultFile())) return null;
    const content = fs.readFileSync(getOverrideResultFile(), 'utf-8');
    return JSON.parse(content) as OverrideResult;
  } catch {
    return null;
  }
}

/**
 * Clear the override request file.
 */
export function clearOverrideRequest(): void {
  try {
    if (fs.existsSync(getOverrideRequestFile())) {
      fs.unlinkSync(getOverrideRequestFile());
    }
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Clear the override result file.
 */
export function clearOverrideResult(): void {
  try {
    if (fs.existsSync(getOverrideResultFile())) {
      fs.unlinkSync(getOverrideResultFile());
    }
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Poll for an override result matching a specific requestId.
 */
export async function pollOverrideResult(
  requestId: string,
  timeoutMs: number = 6000
): Promise<OverrideResult | null> {
  const startTime = Date.now();
  const pollInterval = 100;

  while (Date.now() - startTime < timeoutMs) {
    const result = readOverrideResult();
    if (result && result.requestId === requestId) {
      return result;
    }
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }

  return null;
}

/**
 * Get file paths (for extension wiring and testing).
 */
export function getInspectPaths() {
  return {
    request: getInspectRequestFile(),
    result: getInspectResultFile(),
    overrideRequest: getOverrideRequestFile(),
    overrideResult: getOverrideResultFile(),
    dir: getDendroDir(),
  };
}
