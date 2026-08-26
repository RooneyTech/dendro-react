/**
 * File System Watcher for Cache Invalidation
 *
 * Watches for changes to React/TypeScript files and invalidates
 * the corresponding cache entries to ensure fresh parse results.
 *
 * Features:
 * - Debounced change handling (prevents rapid invalidation)
 * - Supports .tsx, .ts, .jsx, .js files
 * - Handles file deletion
 * - Proper disposal on deactivation
 *
 * @module file-watcher
 */

import * as vscode from 'vscode';
import { ParseCache } from './cache';

// Debounce delay in milliseconds
const DEBOUNCE_DELAY = 100;

/**
 * File watcher that invalidates cache entries on file changes
 */
export class FileWatcher implements vscode.Disposable {
  private watcher: vscode.FileSystemWatcher;
  private cache: ParseCache;
  private debounceTimers: Map<string, NodeJS.Timeout>;
  private disposables: vscode.Disposable[] = [];

  constructor(cache: ParseCache) {
    this.cache = cache;
    this.debounceTimers = new Map();

    // Watch for React/TypeScript files
    this.watcher = vscode.workspace.createFileSystemWatcher(
      '**/*.{tsx,ts,jsx,js}',
      false, // Don't ignore create events
      false, // Don't ignore change events
      false  // Don't ignore delete events
    );

    this.setupHandlers();
  }

  /**
   * Set up event handlers for file system events
   */
  private setupHandlers(): void {
    // Handle file changes (debounced)
    this.disposables.push(
      this.watcher.onDidChange((uri) => {
        this.handleChangeDebounced(uri);
      })
    );

    // Handle file creation (debounced)
    this.disposables.push(
      this.watcher.onDidCreate((uri) => {
        this.handleChangeDebounced(uri);
      })
    );

    // Handle file deletion (immediate)
    this.disposables.push(
      this.watcher.onDidDelete((uri) => {
        this.handleDelete(uri);
      })
    );
  }

  /**
   * Handle file change with debouncing
   * Prevents rapid invalidation during auto-save or fast typing
   */
  private handleChangeDebounced(uri: vscode.Uri): void {
    const filePath = uri.fsPath;

    // Clear existing timer for this file
    const existingTimer = this.debounceTimers.get(filePath);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Set new debounced timer
    const timer = setTimeout(() => {
      this.debounceTimers.delete(filePath);
      this.cache.invalidate(filePath);
    }, DEBOUNCE_DELAY);

    this.debounceTimers.set(filePath, timer);
  }

  /**
   * Handle file deletion (immediate, no debounce)
   */
  private handleDelete(uri: vscode.Uri): void {
    const filePath = uri.fsPath;

    // Clear any pending debounce timer
    const existingTimer = this.debounceTimers.get(filePath);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.debounceTimers.delete(filePath);
    }

    // Immediately invalidate the deleted file
    this.cache.invalidate(filePath);
  }

  /**
   * Manually trigger invalidation for a file
   * Useful for programmatic cache clearing
   */
  invalidate(filePath: string): void {
    this.cache.invalidate(filePath);
  }

  /**
   * Clear all pending debounce timers
   */
  private clearAllTimers(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  /**
   * Dispose of the watcher and all resources
   */
  dispose(): void {
    this.clearAllTimers();
    this.watcher.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables = [];
  }
}

/**
 * Create a file watcher for the given cache
 * Returns a disposable that should be added to context.subscriptions
 */
export function createFileWatcher(cache: ParseCache): FileWatcher {
  return new FileWatcher(cache);
}
