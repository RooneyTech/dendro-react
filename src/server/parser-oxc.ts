/**
 * OXC-based React Component Parser
 *
 * High-performance replacement for Babel parser.
 * Maintains full API compatibility with parser.js.
 *
 * Performance: 40-50x faster than Babel
 * Caching: Optional 2-tier LRU cache for even better performance
 *
 * @module parser-oxc
 */

import {
  parseSync,
  ParseResult,
  EcmaScriptModule
} from 'oxc-parser';
import * as fs from 'fs';
import * as path from 'path';
import {
  ParseCache,
  CachedEntry,
  hashContent,
  PARSER_VERSION,
  mcpCache
} from '../core/cache';
import { walkASTSimple, type ESTreeNode } from '../core/utils/ast-walker';
import { loadPathAliases, resolveAliasedImport, type AliasMap } from '../core/utils/tsconfig-paths';

// Extended ESTree node types used by this parser

interface VariableDeclarator extends ESTreeNode {
  type: 'VariableDeclarator';
  id: {
    type: string;
    name?: string;
    elements?: Array<{ name?: string } | null>;
  };
  init?: {
    type: string;
    callee?: {
      type: string;
      name?: string;
      // For MemberExpression (e.g., React.useState)
      object?: { name?: string };
      property?: { name?: string };
    };
  };
}

interface VariableDeclaration extends ESTreeNode {
  type: 'VariableDeclaration';
  declarations: VariableDeclarator[];
}

interface FunctionDeclaration extends ESTreeNode {
  type: 'FunctionDeclaration';
  id?: { name: string };
}

interface ClassDeclaration extends ESTreeNode {
  type: 'ClassDeclaration';
  id?: { name: string };
}

// Return types
interface ReExport {
  source: string;
  names: string[] | '*';
}

interface ComponentTypeResult {
  type: 'functional' | 'class' | null;
  stateVariables: string[];
  memoized: boolean;
}

export interface ComponentNode {
  file: string;
  type: 'functional' | 'class' | null;
  state: string[];
  memoized: boolean;
  directive?: 'use client' | 'use server' | null;
  children: ComponentNode[];
}

// Supported file extensions for resolution
const EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js'];
const INDEX_FILES = EXTENSIONS.map(ext => `index${ext}`);

/**
 * Resolve an import path to an actual file path.
 * Handles:
 * - Direct file imports with extensions
 * - Imports without extensions (tries each extension)
 * - Directory imports with index files
 */
// Alias context for the current tree build. Set by buildComponentTree at its
// top-level call; module-level is safe because the MCP server is single-threaded
// and tree builds never interleave. Without alias resolution, `@/components/x`
// imports were invisible — trees stopped at the entry file on most modern repos.
let currentAliasMap: AliasMap | null = null;

/** Try a base path as file, with extensions, or as a directory with an index file. */
function resolveBasePath(basePath: string): string | null {
  // 1. Try exact path (has extension) — but only component-bearing extensions.
  // Style/asset/data imports (.scss, .css, .png, .svg, .json, …) resolve on
  // disk too, and without this guard they become tree nodes and inflate
  // component counts. (Issue #40)
  if (fs.existsSync(basePath) && fs.statSync(basePath).isFile()) {
    return EXTENSIONS.includes(path.extname(basePath)) ? basePath : null;
  }

  // 2. Try adding extensions
  for (const ext of EXTENSIONS) {
    const withExt = `${basePath}${ext}`;
    if (fs.existsSync(withExt) && fs.statSync(withExt).isFile()) {
      return withExt;
    }
  }

  // 3. Try as directory with index file
  if (fs.existsSync(basePath) && fs.statSync(basePath).isDirectory()) {
    for (const indexFile of INDEX_FILES) {
      const indexPath = path.join(basePath, indexFile);
      if (fs.existsSync(indexPath)) {
        return indexPath;
      }
    }
  }
  return null;
}

function resolveImportPath(importPath: string, fromDir: string, aliasMap?: AliasMap | null): string | null {
  // Aliased import (tsconfig paths): try each mapped target
  if (!importPath.startsWith('.') && !importPath.startsWith('/')) {
    for (const candidate of resolveAliasedImport(importPath, aliasMap !== undefined ? aliasMap : currentAliasMap)) {
      const resolved = resolveBasePath(candidate);
      if (resolved) return resolved;
    }
    return null;
  }

  return resolveBasePath(path.resolve(fromDir, importPath));
}

/**
 * Parse a file to AST using OXC parser.
 * 40-50x faster than Babel parser.
 */
function parseFileToAST(filePath: string): ParseResult | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const code = fs.readFileSync(filePath, 'utf-8');
  const filename = path.basename(filePath);

  try {
    const result = parseSync(filename, code);

    // Check for parse errors
    if (result.errors && result.errors.length > 0) {
      // Log errors but still return result (partial parse may be useful)
      // console.warn(`Parse warnings for ${filePath}:`, result.errors);
    }

    return result;
  } catch (error) {
    // console.error(`Failed to parse ${filePath}:`, error);
    return null;
  }
}

// Active cache instance (can be swapped for extension cache)
let activeCache: ParseCache = mcpCache;

/**
 * Set the active cache instance.
 * Call this from the extension to use workspace-backed cache.
 */
function setCache(cache: ParseCache): void {
  activeCache = cache;
}

/**
 * Get the active cache instance.
 */
function getCache(): ParseCache {
  return activeCache;
}

/**
 * Parse a file with caching support.
 * Returns cached result if available and content unchanged.
 * Falls back to parseFileToAST if cache miss.
 */
function parseFileWithCache(filePath: string): ParseResult | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const content = fs.readFileSync(filePath, 'utf-8');

  // Check cache first
  const cached = activeCache.get(filePath, content);
  if (cached?.parseResult) {
    return cached.parseResult;
  }

  // Cache miss - parse the file
  const filename = path.basename(filePath);

  try {
    const result = parseSync(filename, content);

    // Store in cache
    const { type, stateVariables, memoized } = findComponentTypeAndState(result, filePath);
    const imports = findImportsInAST(result);
    const exports = findReExportsInAST(result);

    const entry: CachedEntry = {
      filePath,
      contentHash: hashContent(content),
      parserVersion: PARSER_VERSION,
      componentInfo: { type, stateVariables, memoized },
      imports: imports.map(source => ({
        source,
        isLocal: source.startsWith('.') || source.startsWith('/')
      })),
      exports,
      timestamp: Date.now(),
      parseResult: result,
    };

    activeCache.set(filePath, content, entry);

    return result;
  } catch (error) {
    return null;
  }
}

// walkAST replaced by walkASTSimple from utils/ast-walker
const walkAST = walkASTSimple;

/**
 * Traverse the AST and determine the component type (class or functional)
 * and find state variables (useState hooks).
 */
function findComponentTypeAndState(parseResult: ParseResult | null, filePath?: string): ComponentTypeResult {
  let type: 'functional' | 'class' | null = null;
  const stateVariables: string[] = [];
  let memoized = false;

  if (!parseResult?.program) {
    return { type, stateVariables, memoized };
  }

  // A plain .ts file cannot contain JSX (that requires .tsx), so its functions
  // are almost never components — utils/constants files were being counted as
  // 'functional' components on the strength of any arrow function. Only
  // classify a .ts file as a component when it actually calls createElement.
  // (Issue #40)
  if (filePath && path.extname(filePath) === '.ts') {
    let callsCreateElement = false;
    walkAST(parseResult.program, (node) => {
      if (node.type === 'CallExpression') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const callee = (node as any).callee;
        // Bare createElement (imported from 'react') or React.createElement —
        // NOT document.createElement, which is DOM code, not a component.
        if (
          (callee?.type === 'Identifier' && callee.name === 'createElement') ||
          (callee?.type === 'MemberExpression' &&
            callee.object?.name === 'React' &&
            callee.property?.name === 'createElement')
        ) {
          callsCreateElement = true;
        }
      }
    });
    if (!callsCreateElement) {
      return { type: null, stateVariables, memoized };
    }
  }

  walkAST(parseResult.program, (node) => {
    // Check for class component
    if (node.type === 'ClassDeclaration') {
      const classNode = node as ClassDeclaration;
      if (classNode.id?.name) {
        type = 'class';
      }
    }

    // Check for function declaration component
    if (node.type === 'FunctionDeclaration') {
      const funcNode = node as FunctionDeclaration;
      if (funcNode.id?.name) {
        type = 'functional';
      }
    }

    // Check for arrow function component (including memo-wrapped)
    if (node.type === 'VariableDeclaration') {
      const varDecl = node as VariableDeclaration;
      const declaration = varDecl.declarations[0];
      if (declaration?.init?.type === 'ArrowFunctionExpression') {
        if (declaration.id?.name) {
          type = 'functional';
        }
      }
      // Detect: const Foo = memo(() => ...) or React.memo(() => ...)
      if (declaration?.init?.type === 'CallExpression') {
        const callee = declaration.init.callee;
        const isDirectMemo = callee?.type === 'Identifier' && callee?.name === 'memo';
        const isMemberMemo = callee?.type === 'MemberExpression' &&
          callee?.object?.name === 'React' &&
          callee?.property?.name === 'memo';
        if (isDirectMemo || isMemberMemo) {
          memoized = true;
          type = type || 'functional';
        }
      }
    }

    // Check for default export: export default memo(Component)
    if (node.type === 'ExportDefaultDeclaration') {
      const decl = (node as any).declaration;
      if (decl?.type === 'CallExpression') {
        const callee = decl.callee;
        const isDirectMemo = callee?.type === 'Identifier' && callee?.name === 'memo';
        const isMemberMemo = callee?.type === 'MemberExpression' &&
          callee?.object?.name === 'React' &&
          callee?.property?.name === 'memo';
        if (isDirectMemo || isMemberMemo) {
          memoized = true;
        }
      }
    }

    // Check for useState hooks
    if (node.type === 'VariableDeclarator') {
      const declarator = node as VariableDeclarator;
      if (declarator.init?.type === 'CallExpression') {
        const callee = declarator.init.callee;
        // Check for direct useState() call
        const isDirectUseState = callee?.type === 'Identifier' && callee?.name === 'useState';
        // Check for React.useState() call
        const isMemberUseState = callee?.type === 'MemberExpression' &&
          callee?.object?.name === 'React' &&
          callee?.property?.name === 'useState';

        if (isDirectUseState || isMemberUseState) {
          // Get first element of destructured array [state, setState]
          if (declarator.id?.type === 'ArrayPattern' &&
              declarator.id.elements?.[0]?.name) {
            stateVariables.push(declarator.id.elements[0].name);
          }
        }
      }
    }
  });

  return { type, stateVariables, memoized };
}

/**
 * Parse the imports to identify child components.
 * Uses OXC's pre-computed staticImports for maximum performance.
 *
 * Note: This is MUCH faster than AST traversal because OXC
 * provides import metadata as part of the parse result.
 */
function findImportsInAST(parseResult: ParseResult | null): string[] {
  const imports: string[] = [];

  if (!parseResult) {
    return imports;
  }

  const module = parseResult.module as EcmaScriptModule;
  if (!module?.staticImports) {
    return imports;
  }

  for (const staticImport of module.staticImports) {
    const importPath = staticImport.moduleRequest.value;

    // Keep local imports: relative/absolute, plus tsconfig-alias imports
    // (@/components/x). Bare npm packages are skipped — an alias prefix match
    // is what distinguishes `@/lib/x` from `@radix-ui/react-dialog`.
    const isRelative = importPath.startsWith('.') || importPath.startsWith('/');
    const isAliased = !isRelative && resolveAliasedImport(importPath, currentAliasMap).length > 0;
    if (!isRelative && !isAliased) {
      continue;
    }

    imports.push(importPath);
  }

  return imports;
}

/**
 * All static imports, unfiltered — for consumers that do their own resolution
 * (get_used_by matches against tsconfig aliases itself).
 */
function findAllImportsInAST(parseResult: ParseResult | null): string[] {
  const module = parseResult?.module as EcmaScriptModule | undefined;
  return module?.staticImports?.map(si => si.moduleRequest.value) ?? [];
}

/**
 * Parse re-exports from a barrel/index file.
 * Uses OXC's pre-computed staticExports for maximum performance.
 *
 * Handles:
 * - Named re-exports: export { X } from './X'
 * - Default re-exports: export { default as X } from './X'
 * - Wildcard re-exports: export * from './X'
 */
function findReExportsInAST(parseResult: ParseResult | null): ReExport[] {
  const reExports: ReExport[] = [];

  if (!parseResult) {
    return reExports;
  }

  const module = parseResult.module as EcmaScriptModule;
  if (!module?.staticExports) {
    return reExports;
  }

  for (const staticExport of module.staticExports) {
    for (const entry of staticExport.entries) {
      // Only process re-exports (has moduleRequest)
      if (!entry.moduleRequest) {
        continue;
      }

      const source = entry.moduleRequest.value;

      // Check for wildcard re-export (export * from './X')
      // ExportImportNameKind.AllButDefault = 'AllButDefault'
      if (entry.importName.kind === 'AllButDefault') {
        reExports.push({ source, names: '*' });
      }
      // Check for named re-export (export { X } from './X')
      else if (entry.exportName.kind === 'Name' && entry.exportName.name) {
        // Group by source
        const existing = reExports.find(r => r.source === source && r.names !== '*');
        if (existing && Array.isArray(existing.names)) {
          existing.names.push(entry.exportName.name);
        } else {
          reExports.push({ source, names: [entry.exportName.name] });
        }
      }
      // Check for default re-export (export { default as X } from './X')
      // ExportExportNameKind.Default = 'Default' (for export default)
      // or importName.name === 'default' (for re-exporting default import)
      else if (entry.exportName.kind === 'Default' ||
               entry.importName.name === 'default') {
        const name = entry.localName.name || entry.exportName.name || 'default';
        const existing = reExports.find(r => r.source === source && r.names !== '*');
        if (existing && Array.isArray(existing.names)) {
          existing.names.push(name);
        } else {
          reExports.push({ source, names: [name] });
        }
      }
    }
  }

  return reExports;
}

/**
 * Check if a resolved path is an index/barrel file.
 */
function isIndexFile(filePath: string): boolean {
  const basename = path.basename(filePath);
  return INDEX_FILES.some(idx => basename === idx);
}

/**
 * Resolve imports from a barrel file, following re-exports to find actual component files.
 */
function resolveBarrelExports(indexFilePath: string, visited: Set<string> = new Set()): string[] {
  if (visited.has(indexFilePath)) {
    return [];
  }
  visited.add(indexFilePath);

  const parseResult = parseFileToAST(indexFilePath);
  if (!parseResult) return [];

  const reExports = findReExportsInAST(parseResult);
  const resolvedPaths: string[] = [];
  const indexDir = path.dirname(indexFilePath);

  for (const { source } of reExports) {
    // Only follow local re-exports
    if (!source.startsWith('.') && !source.startsWith('/')) {
      continue;
    }

    const resolvedPath = resolveImportPath(source, indexDir);
    if (resolvedPath) {
      // Check if this is another index file (nested barrel)
      if (isIndexFile(resolvedPath)) {
        // Recursively resolve nested barrel exports
        const nestedPaths = resolveBarrelExports(resolvedPath, visited);
        resolvedPaths.push(...nestedPaths);
      } else {
        resolvedPaths.push(resolvedPath);
      }
    }
  }

  return resolvedPaths;
}

/**
 * Build a component tree from the file system and source code.
 * Main entry point for component tree analysis.
 */
function buildComponentTree(
  filePath: string,
  baseDir: string,
  visited: Set<string> = new Set()
): ComponentNode | null {
  const absoluteFilePath = path.resolve(baseDir, filePath);

  // Top-level call: load tsconfig path aliases for this project so aliased
  // imports resolve as tree edges (nested recursive calls reuse the context).
  if (visited.size === 0) {
    currentAliasMap = loadPathAliases(baseDir);
  }

  // Prevent circular dependencies causing stack overflow
  if (visited.has(absoluteFilePath)) {
    return null;
  }
  visited.add(absoluteFilePath);

  if (!fs.existsSync(absoluteFilePath)) {
    return null;
  }

  const parseResult = parseFileToAST(absoluteFilePath);
  const { type, stateVariables, memoized } = findComponentTypeAndState(parseResult, absoluteFilePath);

  // Use OXC's pre-computed imports (faster than AST traversal)
  const imports = findImportsInAST(parseResult);

  const children: ComponentNode[] = [];
  const fileDir = path.dirname(absoluteFilePath);

  for (const importPath of imports) {
    const resolvedPath = resolveImportPath(importPath, fileDir);

    if (!resolvedPath) {
      continue;
    }

    // Check if this is a barrel/index file
    if (isIndexFile(resolvedPath)) {
      // Get all re-exported component files from the barrel
      const barrelExports = resolveBarrelExports(resolvedPath, new Set(visited));

      for (const exportedPath of barrelExports) {
        const child = buildComponentTree(exportedPath, baseDir, visited);
        if (child) {
          children.push(child);
        }
      }
    } else {
      // Regular import - process directly
      const child = buildComponentTree(resolvedPath, baseDir, visited);
      if (child) {
        children.push(child);
      }
    }
  }

  return {
    file: path.basename(filePath),
    type: type,
    state: stateVariables,
    memoized: memoized,
    children: children
  };
}

// Export all functions with same interface as parser.js
export {
  buildComponentTree,
  parseFileToAST,
  parseFileWithCache,
  findComponentTypeAndState,
  findImportsInAST,
  findAllImportsInAST,
  resolveImportPath,
  resolveBarrelExports,
  isIndexFile,
  findReExportsInAST,
  setCache,
  getCache,
  EXTENSIONS,
  INDEX_FILES
};

// Also export types
export type {
  ComponentTypeResult,
  ReExport
};
