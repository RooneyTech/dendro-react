/**
 * Shared File Scanner Utility
 *
 * Consolidates the 5 duplicate findComponentFiles / findAllComponentFiles
 * implementations. Provides a single parameterized function with sensible
 * defaults that match the most common usage.
 *
 * @module file-scanner
 */

import * as fs from 'fs';
import * as path from 'path';
import { EXTENSIONS } from '../../server/parser-oxc';

const DEFAULT_EXTENSIONS = new Set(EXTENSIONS);

export interface ScanOptions {
  /** Maximum directory depth to recurse (default: 5) */
  maxDepth?: number;
  /** File extensions to include (default: EXTENSIONS from parser-oxc) */
  extensions?: string[];
  /** Directory names to exclude (default: ['node_modules']) */
  excludeDirs?: string[];
}

/**
 * Recursively scan a directory for component files.
 *
 * Replaces:
 * - context-parser.ts findAllComponentFiles()
 * - screen-parser.ts findAllComponentFiles()
 * - complexity-parser.ts findComponentFiles()
 * - web-routing-parser.ts findComponentFilesInDir()
 * - mcp/tools.ts findComponentFiles()
 */
export function scanComponentFiles(dir: string, options?: ScanOptions): string[] {
  const files: string[] = [];
  const maxDepth = options?.maxDepth ?? 5;
  const exts = options?.extensions ? new Set(options.extensions) : DEFAULT_EXTENSIONS;
  const excludes = new Set(options?.excludeDirs ?? ['node_modules']);

  function scan(currentDir: string, depth: number): void {
    if (depth > maxDepth) return;

    try {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.name.startsWith('.') || excludes.has(entry.name)) {
          continue;
        }

        const fullPath = path.join(currentDir, entry.name);

        if (entry.isDirectory()) {
          scan(fullPath, depth + 1);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name);
          if (exts.has(ext)) {
            files.push(fullPath);
          }
        }
      }
    } catch {
      // Directory not readable — skip silently
    }
  }

  scan(dir, 0);
  return files;
}
