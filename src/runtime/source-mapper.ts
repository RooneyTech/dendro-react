/**
 * Source Mapper — Maps runtime component display names to source files.
 *
 * Scans the workspace for React component files and builds a name→path index.
 * Used to make runtime tree items clickable (open source on click).
 *
 * @module source-mapper
 */

import * as path from 'path';
import * as fs from 'fs';

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.expo', '.next',
  '__tests__', '__mocks__', 'coverage', '.dendro',
]);

const COMPONENT_EXTENSIONS = ['.tsx', '.jsx', '.ts', '.js'];

export class SourceMapper {
  private componentIndex: Map<string, string> = new Map();
  private caseInsensitiveIndex: Map<string, string> = new Map();
  private indexed = false;

  /**
   * Build index of component names to file paths by scanning workspace.
   * Call once on connection, then use mapToSource() for lookups.
   */
  buildIndex(workspaceRoot: string): void {
    this.componentIndex.clear();
    this.caseInsensitiveIndex.clear();
    this.scanDirectory(workspaceRoot);
    this.indexed = true;
  }

  /**
   * Map a runtime display name to a source file path.
   * Three-tier lookup: exact → case-insensitive → null.
   */
  mapToSource(displayName: string): string | null {
    if (!this.indexed || !displayName) return null;

    // Tier 1: Exact match
    const exact = this.componentIndex.get(displayName);
    if (exact) return exact;

    // Tier 2: Case-insensitive match
    const lower = this.caseInsensitiveIndex.get(displayName.toLowerCase());
    if (lower) return lower;

    return null;
  }

  /**
   * Get the full source map (displayName → filePath) for serialization.
   */
  getSourceMap(): Map<string, string> {
    return new Map(this.componentIndex);
  }

  /**
   * Number of indexed components.
   */
  get size(): number {
    return this.componentIndex.size;
  }

  private scanDirectory(dir: string): void {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;

        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          this.scanDirectory(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name);
          if (!COMPONENT_EXTENSIONS.includes(ext)) continue;

          const baseName = entry.name.replace(/\.(tsx|jsx|ts|js)$/, '');

          // Skip index/config/test files
          if (baseName === 'index' || baseName.endsWith('.test') || baseName.endsWith('.spec')) continue;

          // PascalCase names are likely React components
          if (/^[A-Z]/.test(baseName)) {
            // Only store first occurrence (closer to workspace root wins)
            if (!this.componentIndex.has(baseName)) {
              this.componentIndex.set(baseName, fullPath);
              this.caseInsensitiveIndex.set(baseName.toLowerCase(), fullPath);
            }
          }
        }
      }
    } catch {
      // Directory not readable, skip
    }
  }
}
