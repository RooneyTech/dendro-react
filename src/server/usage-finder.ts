/**
 * Lightweight component usage finder for CodeLens
 *
 * Extracted from tools.ts to avoid pulling in ts-morph dependency.
 * Uses only the OXC parser which is already bundled.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  parseFileWithCache,
  findImportsInAST,
  resolveImportPath,
  EXTENSIONS
} from './parser-oxc';

interface UsageResult {
  file: string;
  absolutePath: string;
}

/**
 * Find all component files in a directory recursively
 */
function findComponentFiles(dir: string, files: string[] = []): string[] {
  if (!fs.existsSync(dir)) return files;

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      // Skip node_modules and hidden directories
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
        continue;
      }
      findComponentFiles(fullPath, files);
    } else if (entry.isFile()) {
      // Check if it's a component file
      const ext = path.extname(entry.name);
      if (EXTENSIONS.includes(ext)) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

/**
 * Check if an import path resolves to the target component
 */
function importResolvesToTarget(
  importPath: string,
  importingFile: string,
  targetPath: string
): boolean {
  // Only check local imports
  if (!importPath.startsWith('.') && !importPath.startsWith('/')) {
    return false;
  }

  const importingDir = path.dirname(importingFile);
  const resolvedPath = resolveImportPath(importPath, importingDir);

  if (!resolvedPath) return false;

  // Normalize paths for comparison
  const normalizedResolved = path.normalize(resolvedPath);
  const normalizedTarget = path.normalize(targetPath);

  return normalizedResolved === normalizedTarget;
}

/**
 * Find all components that import/use a given component
 */
export function findComponentUsages(
  componentPath: string,
  searchDir?: string
): UsageResult[] {
  const absolutePath = path.isAbsolute(componentPath)
    ? componentPath
    : path.resolve(componentPath);

  if (!fs.existsSync(absolutePath)) {
    return [];
  }

  const baseDir = searchDir || path.dirname(absolutePath);
  const allFiles = findComponentFiles(baseDir);
  const usages: UsageResult[] = [];

  for (const filePath of allFiles) {
    // Skip the target file itself
    if (path.normalize(filePath) === path.normalize(absolutePath)) {
      continue;
    }

    try {
      const parseResult = parseFileWithCache(filePath);
      if (!parseResult) continue;

      const imports = findImportsInAST(parseResult);

      for (const importPath of imports) {
        if (importResolvesToTarget(importPath, filePath, absolutePath)) {
          usages.push({
            file: path.basename(filePath),
            absolutePath: filePath
          });
          break; // Only count each file once
        }
      }
    } catch {
      // Skip files that fail to parse
      continue;
    }
  }

  // Sort alphabetically
  usages.sort((a, b) => a.file.localeCompare(b.file));

  return usages;
}
