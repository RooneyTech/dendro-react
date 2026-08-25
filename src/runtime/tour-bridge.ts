/**
 * Tour Bridge — File-based IPC for passing tour configs from MCP to webview.
 *
 * Tour configs can be large (5KB+), exceeding URI length limits.
 * The MCP server writes the config to a temp file, fires a lightweight URI,
 * and the extension reads + clears the file.
 *
 * @module tour-bridge
 */

import * as fs from 'fs';
import * as path from 'path';
import { getWorkspaceIpcDir, ensureDir } from './ipc-paths';

function getDendroDir(): string { return getWorkspaceIpcDir(); }
function getTourConfigFile(): string { return path.join(getDendroDir(), 'tour-config.json'); }

/** Exported paths for testing */
export function getTourPaths() {
  return {
    configFile: getTourConfigFile(),
    dendroDir: getDendroDir(),
  };
}

function ensureDendroDir(): void {
  ensureDir(getDendroDir());
}

/**
 * Write tour config to temp file (called by MCP tool before firing URI).
 */
export function writeTourConfig(config: unknown): void {
  ensureDendroDir();
  fs.writeFileSync(getTourConfigFile(), JSON.stringify(config), { encoding: 'utf-8', mode: 0o600 });
}

/**
 * Read tour config from temp file (called by extension URI handler).
 */
export function readTourConfig(): unknown | null {
  try {
    if (!fs.existsSync(getTourConfigFile())) return null;
    const content = fs.readFileSync(getTourConfigFile(), 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Clear the tour config file (called after reading).
 */
export function clearTourConfig(): void {
  try {
    if (fs.existsSync(getTourConfigFile())) {
      fs.unlinkSync(getTourConfigFile());
    }
  } catch {
    // Ignore errors on cleanup
  }
}
