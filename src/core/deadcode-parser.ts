/**
 * Dead Code Parser — unused-file detection ("deslop").
 *
 * Builds the static import graph over the scanned tree (tsconfig aliases
 * included) and reports source files nothing imports. Fired on every showcase
 * repo during research — dead files are the highest-demo-value hygiene signal
 * an audit can produce, and agents can act on them safely.
 *
 * Precision over recall: framework entry conventions, tests, stories, config,
 * and declaration files are never reported, and dynamic `import()` /
 * `require()` string literals count as references. Residual false-positive
 * sources (files referenced only from OUTSIDE the scanned root, string-built
 * dynamic imports) are named in the report note rather than silently risked.
 *
 * @module deadcode-parser
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseFileToAST, findAllImportsInAST, findReExportsInAST, resolveImportPath } from '../server/parser-oxc';
import { scanComponentFiles } from './utils/file-scanner';
import { loadPathAliases } from './utils/tsconfig-paths';
import { listComponentsInFile } from './complexity-parser';

export interface DeadFile {
  file: string;
  absolutePath: string;
  /** Components declared in the file (helps judge blast radius of deleting). */
  components: string[];
  sizeBytes: number;
}

export interface DeadCodeReport {
  unusedFiles: DeadFile[];
  summary: { totalFilesScanned: number; unusedCount: number; unusedBytes: number };
  note: string;
  warnings: string[];
}

// Never report these as unused — they're reached by convention, not imports.
const ENTRY_BASENAMES = new Set([
  'index', 'main', 'app', '_app', '_document', '_error', '_layout',
  'page', 'layout', 'route', 'loading', 'error', 'not-found', 'template', 'default',
  'middleware', 'instrumentation', 'global-error',
]);
const ENTRY_DIR_HINT = /(^|\/)(app|pages|routes)(\/|$)/;
const NON_CODE_FILE = /(\.d\.ts$)|(\.(test|spec|stories)\.)|(__tests__|__mocks__|\.storybook)\//;
const CONFIG_FILE = /\.(config|setup)\.[jt]sx?$/;

const DYNAMIC_IMPORT_RE = /(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

export function parseDeadCode(rootPath: string): DeadCodeReport {
  const absoluteRoot = path.resolve(rootPath);
  const warnings: string[] = [];

  if (!fs.existsSync(absoluteRoot) || !fs.statSync(absoluteRoot).isDirectory()) {
    return {
      unusedFiles: [],
      summary: { totalFilesScanned: 0, unusedCount: 0, unusedBytes: 0 },
      note: 'Path not found or not a directory.',
      warnings: [`Path not found or not a directory: ${absoluteRoot}`],
    };
  }

  const files = scanComponentFiles(absoluteRoot, { maxDepth: 8 });
  const fileSet = new Set(files);
  const aliasMap = loadPathAliases(absoluteRoot);
  const referenced = new Set<string>();
  let parseFailures = 0;

  for (const file of files) {
    const fromDir = path.dirname(file);
    const ast = parseFileToAST(file);
    if (!ast) { parseFailures++; continue; }

    const refs: string[] = [...findAllImportsInAST(ast)];
    // Re-exports (barrels) reference their sources too
    try {
      for (const re of findReExportsInAST(ast)) refs.push(re.source);
    } catch { /* non-module files */ }
    // Dynamic import()/require() with string literals — lazy routes etc.
    const source = fs.readFileSync(file, 'utf-8');
    for (const m of source.matchAll(DYNAMIC_IMPORT_RE)) refs.push(m[1]);

    for (const ref of refs) {
      const resolved = resolveImportPath(ref, fromDir, aliasMap);
      if (resolved && fileSet.has(resolved)) referenced.add(resolved);
    }
  }

  const unusedFiles: DeadFile[] = [];
  for (const file of files) {
    if (referenced.has(file)) continue;
    const rel = path.relative(absoluteRoot, file);
    const base = path.parse(file).name;
    if (ENTRY_BASENAMES.has(base)) continue;
    if (ENTRY_DIR_HINT.test(rel)) continue;
    if (NON_CODE_FILE.test(rel) || CONFIG_FILE.test(rel)) continue;

    unusedFiles.push({
      file: rel,
      absolutePath: file,
      components: listComponentsInFile(file),
      sizeBytes: fs.statSync(file).size,
    });
  }

  if (parseFailures > 0) {
    warnings.push(`${parseFailures} file(s) failed to parse — their imports could not be counted, so files they reference may be falsely reported as unused.`);
  }

  unusedFiles.sort((a, b) => b.sizeBytes - a.sizeBytes);

  return {
    unusedFiles,
    summary: {
      totalFilesScanned: files.length,
      unusedCount: unusedFiles.length,
      unusedBytes: unusedFiles.reduce((s, f) => s + f.sizeBytes, 0),
    },
    note: 'Unused = nothing under the scanned root statically imports, re-exports, or dynamically imports (string-literal) the file, excluding framework entry conventions, tests, stories, and config. Verify before deleting: files referenced only from outside this root, via string-built dynamic imports, or by non-JS tooling will appear here.',
    warnings,
  };
}
