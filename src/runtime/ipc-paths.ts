/**
 * IPC Paths — Centralized directory resolution for file-based IPC.
 *
 * Per-workspace IPC files live under ~/.dendro/workspaces/{hash}/ to prevent
 * cross-talk when multiple VS Code windows use Dendro simultaneously.
 * Global files (license, telemetry) stay at ~/.dendro/.
 *
 * The workspace hash is a truncated SHA-256 of the workspace folder path,
 * passed via DENDRO_WORKSPACE_HASH env var (set by extension or MCP startup).
 * Falls back to the flat ~/.dendro/ directory when no hash is set (single-workspace).
 *
 * @module ipc-paths
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const DENDRO_ROOT = path.join(os.homedir(), '.dendro');

/**
 * Compute a stable, short hash from a workspace folder path.
 * Returns first 12 hex chars of SHA-256.
 */
export function computeWorkspaceHash(workspacePath: string): string {
  return crypto.createHash('sha256').update(workspacePath).digest('hex').slice(0, 12);
}

/**
 * Get the IPC directory for per-workspace files.
 *
 * Priority:
 * 1. DENDRO_IPC_DIR env var (test override — takes full precedence)
 * 2. DENDRO_WORKSPACE_HASH env var → ~/.dendro/workspaces/{hash}/
 * 3. Fallback → ~/.dendro/ (backwards compat for single workspace)
 */
export function getWorkspaceIpcDir(): string {
  // Test override — absolute path, bypasses everything
  const testDir = process.env.DENDRO_IPC_DIR;
  if (testDir) return testDir;

  // Workspace-namespaced directory
  const hash = process.env.DENDRO_WORKSPACE_HASH;
  if (hash) return path.join(DENDRO_ROOT, 'workspaces', hash);

  // Fallback for single-workspace or unset
  return DENDRO_ROOT;
}

/**
 * Get the global IPC directory (license, telemetry — shared across workspaces).
 * Always ~/.dendro/ regardless of workspace hash.
 */
export function getGlobalIpcDir(): string {
  const testDir = process.env.DENDRO_IPC_DIR;
  if (testDir) return testDir;
  return DENDRO_ROOT;
}

/**
 * Ensure a directory exists (recursive mkdir with 0o700 permissions).
 */
export function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}
