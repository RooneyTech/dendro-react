/**
 * Runtime State File — Cross-process bridge between extension and MCP server.
 *
 * The VS Code extension writes runtime state to ~/.dendro/runtime-state.json
 * on every tree-update (debounced 500ms). The MCP server reads this file
 * when handling runtime tools (get_runtime_status, get_live_tree, get_runtime_state).
 *
 * @module runtime-state-file
 */

import * as fs from 'fs';
import * as path from 'path';
import type { RuntimeTree, RuntimeStateSnapshot, SerializedRuntimeComponent } from './types';
import { getWorkspaceIpcDir, ensureDir } from './ipc-paths';

function getDendroDir(): string { return getWorkspaceIpcDir(); }
function getRuntimeStateFile(): string { return path.join(getDendroDir(), 'runtime-state.json'); }

/** Stale threshold: treat state older than 30s as disconnected */
const STALE_THRESHOLD_MS = 30_000;

let writeTimeout: ReturnType<typeof setTimeout> | null = null;

/**
 * Write runtime state to disk (debounced 500ms).
 * Called by the extension on every tree-update event.
 */
export function writeRuntimeState(
  tree: RuntimeTree,
  sourceMap: Map<string, string> = new Map()
): void {
  if (writeTimeout) clearTimeout(writeTimeout);
  writeTimeout = setTimeout(() => {
    doWrite(tree, sourceMap);
  }, 500);
}

/**
 * Clear runtime state (write disconnected status).
 * Called when the app disconnects or the extension deactivates.
 */
export function clearRuntimeState(): void {
  if (writeTimeout) clearTimeout(writeTimeout);

  ensureDendroDir();

  const snapshot: RuntimeStateSnapshot = {
    status: 'disconnected',
    timestamp: Date.now(),
    componentCount: 0,
    roots: [],
    elements: [],
    sourceMap: {},
  };

  try {
    fs.writeFileSync(getRuntimeStateFile(), JSON.stringify(snapshot), { encoding: 'utf-8', mode: 0o600 });
  } catch (err) {
    console.error('Dendro: Failed to clear runtime state:', err);
  }
}

/**
 * Read runtime state from disk.
 * Called by the MCP server for runtime tools.
 * Returns null if file doesn't exist or is unreadable.
 * Marks state as disconnected if older than STALE_THRESHOLD_MS.
 */
export function readRuntimeState(): RuntimeStateSnapshot | null {
  try {
    if (!fs.existsSync(getRuntimeStateFile())) return null;

    const content = fs.readFileSync(getRuntimeStateFile(), 'utf-8');
    const snapshot = JSON.parse(content) as RuntimeStateSnapshot;

    // Stale check
    if (Date.now() - snapshot.timestamp > STALE_THRESHOLD_MS) {
      return { ...snapshot, status: 'disconnected' };
    }

    return snapshot;
  } catch {
    return null;
  }
}

// --- Internal ---

function ensureDendroDir(): void {
  ensureDir(getDendroDir());
}

function doWrite(tree: RuntimeTree, sourceMap: Map<string, string>): void {
  ensureDendroDir();

  const elements: SerializedRuntimeComponent[] = [];
  for (const component of tree.elements.values()) {
    elements.push({
      id: component.id,
      displayName: component.displayName,
      type: component.type,
      key: component.key,
      parentId: component.parentId,
      children: [...component.children],
      depth: component.depth,
      sourceFilePath: sourceMap.get(component.displayName),
    });
  }

  const snapshot: RuntimeStateSnapshot = {
    status: 'connected',
    timestamp: Date.now(),
    componentCount: tree.elements.size,
    roots: [...tree.roots],
    elements,
    sourceMap: Object.fromEntries(sourceMap),
  };

  try {
    fs.writeFileSync(getRuntimeStateFile(), JSON.stringify(snapshot), { encoding: 'utf-8', mode: 0o600 });
  } catch (err) {
    console.error('Dendro: Failed to write runtime state:', err);
  }
}
