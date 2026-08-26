/**
 * Dendro Pro — Proprietary
 * Copyright (c) 2025 Rooney Industries LLC. All rights reserved.
 * Unauthorized copying, modification, or distribution is prohibited.
 */

import * as fs from 'fs';
import * as path from 'path';
import { exportJson, ExportJsonResult } from '../exporters/json-exporter';
import { assertPathInWorkspace } from '../path-boundary';

type AnalysisType = 'tree' | 'navigation' | 'context' | 'complexity' | 'screens';

export interface SnapshotMetadata {
  id: string;
  label: string;
  timestamp: string;
  entryFile: string;
  analysesIncluded: string[];
  totalComponents: number;
  fileName: string;
}

export interface SnapshotManifest {
  snapshots: SnapshotMetadata[];
}

export interface SaveSnapshotResult {
  id: string;
  label: string;
  timestamp: string;
  path: string;
  analysesIncluded: string[];
  stats: { totalComponents: number };
  error?: string;
}

export interface ListSnapshotsResult {
  snapshots: SnapshotMetadata[];
  count: number;
  error?: string;
}

function getSnapshotsDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.dendro', 'snapshots');
}

function getManifestPath(workspaceRoot: string): string {
  return path.join(getSnapshotsDir(workspaceRoot), 'manifest.json');
}

function ensureSnapshotsDir(workspaceRoot: string): void {
  const dir = getSnapshotsDir(workspaceRoot);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readManifest(workspaceRoot: string): SnapshotManifest {
  const manifestPath = getManifestPath(workspaceRoot);
  try {
    if (fs.existsSync(manifestPath)) {
      const content = fs.readFileSync(manifestPath, 'utf-8');
      return JSON.parse(content) as SnapshotManifest;
    }
  } catch {
    // Corrupted manifest — start fresh
  }
  return { snapshots: [] };
}

function writeManifest(workspaceRoot: string, manifest: SnapshotManifest): void {
  const manifestPath = getManifestPath(workspaceRoot);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
}

/**
 * Save an analysis snapshot to disk.
 */
export function saveSnapshot(
  entryFile: string,
  workspaceRoot: string,
  label?: string,
  analyses?: AnalysisType[]
): SaveSnapshotResult {
  try {
    assertPathInWorkspace(workspaceRoot, 'workspaceRoot');
    ensureSnapshotsDir(workspaceRoot);

    const id = generateId();
    const timestamp = new Date().toISOString();
    const snapshotLabel = label || path.basename(entryFile, path.extname(entryFile));
    const safeName = snapshotLabel.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
    const fileName = `${safeName}-${Date.now()}.json`;

    // Run analysis
    const result = exportJson(entryFile, { analyses: analyses || ['tree', 'complexity', 'context'] });

    // Write snapshot file
    const snapshotData = {
      id,
      label: snapshotLabel,
      timestamp,
      entryFile,
      result,
    };

    const snapshotPath = path.join(getSnapshotsDir(workspaceRoot), fileName);
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshotData, null, 2), 'utf-8');

    // Update manifest
    const manifest = readManifest(workspaceRoot);
    const metadata: SnapshotMetadata = {
      id,
      label: snapshotLabel,
      timestamp,
      entryFile,
      analysesIncluded: result.metadata.analysesIncluded,
      totalComponents: result.stats.totalComponents,
      fileName,
    };
    manifest.snapshots.push(metadata);
    writeManifest(workspaceRoot, manifest);

    return {
      id,
      label: snapshotLabel,
      timestamp,
      path: snapshotPath,
      analysesIncluded: result.metadata.analysesIncluded,
      stats: { totalComponents: result.stats.totalComponents },
      error: result.error,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      id: '',
      label: label || '',
      timestamp: new Date().toISOString(),
      path: '',
      analysesIncluded: [],
      stats: { totalComponents: 0 },
      error: msg,
    };
  }
}

/**
 * List all saved snapshots.
 */
export function listSnapshots(workspaceRoot: string): ListSnapshotsResult {
  try {
    assertPathInWorkspace(workspaceRoot, 'workspaceRoot');
    const manifest = readManifest(workspaceRoot);

    // Validate that snapshot files still exist
    const validSnapshots = manifest.snapshots.filter(s => {
      const snapshotPath = path.join(getSnapshotsDir(workspaceRoot), s.fileName);
      return fs.existsSync(snapshotPath);
    });

    // Update manifest if any were removed externally
    if (validSnapshots.length !== manifest.snapshots.length) {
      writeManifest(workspaceRoot, { snapshots: validSnapshots });
    }

    return {
      snapshots: validSnapshots,
      count: validSnapshots.length,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { snapshots: [], count: 0, error: msg };
  }
}

/**
 * Load a specific snapshot by ID. Internal helper for compare.
 */
export function loadSnapshot(
  workspaceRoot: string,
  snapshotId: string
): { metadata: SnapshotMetadata; result: ExportJsonResult } | null {
  const manifest = readManifest(workspaceRoot);
  const entry = manifest.snapshots.find(s => s.id === snapshotId);
  if (!entry) return null;

  const snapshotPath = path.join(getSnapshotsDir(workspaceRoot), entry.fileName);
  if (!fs.existsSync(snapshotPath)) return null;

  try {
    const content = fs.readFileSync(snapshotPath, 'utf-8');
    const data = JSON.parse(content);
    return { metadata: entry, result: data.result as ExportJsonResult };
  } catch {
    return null;
  }
}
