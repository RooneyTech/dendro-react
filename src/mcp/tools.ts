import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { assertPathInWorkspace, getWorkspaceRoot } from './path-boundary';
import {
  writeVisualizerPending,
  pollVisualizerReady,
  clearVisualizerStatus,
} from '../runtime/visualizer-bridge';
import {
  buildComponentTree,
  parseFileToAST,
  findAllImportsInAST,
  findComponentTypeAndState,
  findImportsInAST,
  resolveImportPath,
  resolveBarrelExports,
  isIndexFile,
  ComponentNode,
} from '../server/parser-oxc';
import { scanComponentFiles } from '../core/utils/file-scanner';
import {
  tracePropFlow,
  getPropsSignature,
  PropFlowResult,
  PropFlowNode,
  FlowBoundary
} from '../core/prop-flow';
import {
  analyzeHookDependencies,
  HookAnalysisResult,
  HookDependencyInfo,
  DependencyInfo
} from '../core/hook-deps';
import {
  parseNavigationStructure,
  formatNavigationTree,
  NavigationStructure,
  NavigatorInfo,
  ScreenInfo,
  NavigationNode,
  NavigatorType
} from '../core/navigation-parser';
import { parseWebRoutingStructure, detectWebFramework } from '../core/web-routing-parser';
import { detectFileDirective } from '../core/utils/directives';
import { loadPathAliases, resolveAliasedImport, AliasMap } from '../core/utils/tsconfig-paths';
import { parseEffectHygiene, EffectFinding } from '../core/effect-hygiene-parser';
import { parseDeadCode, DeadFile } from '../core/deadcode-parser';
import { getBuildInfo } from './build-info';
import { getUsageStats } from './telemetry';
import { getWorkspaceIpcDir } from '../runtime/ipc-paths';
import {
  parseContextMap,
  formatContextMap,
  ContextDefinition,
  ProviderUsage,
  ContextConsumer,
  CustomContextHook,
  ContextHierarchyNode
} from '../core/context-parser';
import {
  parseScreenComponents,
  formatScreenComponents,
  ScreenDefinition,
  ComponentUsage,
  ScreenComponentMap
} from '../core/screen-parser';
import {
  parseComplexityReport,
  analyzeFileComplexityAll,
  listComponentsInFile,
  ComponentComplexity,
  ComplexityMetrics,
  ComplexityReportSummary
} from '../core/complexity-parser';
import {
  parseRerenderRiskReport,
  analyzeFileRerenderRisks,
  RerenderRisk,
  RerenderRiskSummary,
  FileRerenderRisks,
  RerenderRiskReport,
  RiskType,
  RiskSeverity
} from '../core/rerender-risk-parser';

// Types
// ComponentNode imported from parser-oxc.ts

interface TreeStats {
  totalComponents: number;
  functionalCount: number;
  classCount: number;
  maxDepth: number;
}

interface ComponentMatch {
  file: string;
  type: 'functional' | 'class' | null;
  state: string[];
  directive?: 'use client' | 'use server' | null;
  path: string[];
  depth: number;
}

interface ComponentByType {
  file: string;
  absolutePath: string;
  state: string[];
  depth: number;
}

interface CircularDep {
  cycle: string[];
  fullPath: string[];
  description: string;
  recommendation: string;
}

interface ImportGraph {
  [filePath: string]: string[];
}

export interface GetComponentTreeResult {
  tree: ComponentNode | null;
  stats: TreeStats;
  error?: string;
}

export interface GetComponentDetailsResult {
  file: string;
  absolutePath: string;
  type: 'functional' | 'class' | null;
  state: string[];
  directive?: 'use client' | 'use server' | null;
  imports: { source: string; isLocal: boolean }[];
  directChildren: string[];
  error?: string;
}

export interface FindComponentByNameResult {
  matches: ComponentMatch[];
  totalSearched: number;
  note?: string;
  error?: string;
}

export interface FindComponentsByTypeResult {
  components: ComponentByType[];
  totalSearched: number;
  note?: string;
  error?: string;
}

export interface DetectCircularDepsResult {
  hasCircularDeps: boolean;
  circularDependencies: CircularDep[];
  formattedOutput: string;
  totalFilesScanned: number;
  /** Scan boundaries — a clean result only covers what was actually scanned. */
  scanScope?: { root: string; maxDepth: number; excluded: string[] };
  note?: string;
  error?: string;
}

interface UsedByMatch {
  file: string;
  absolutePath: string;
  type: 'functional' | 'class' | null;
  directive: 'use client' | 'use server' | null;
  importStatement: string;
}

export interface GetUsedByResult {
  component: string;
  usedBy: UsedByMatch[];
  totalFilesScanned: number;
  /** Where the scan actually looked — an empty usedBy is only meaningful relative to this. */
  searchScope?: { root: string; maxDepth: number };
  note?: string;
  error?: string;
}

// Helper to detect RSC directive at start of file.
// Comment-tolerant: a license header or @ts-nocheck above the directive must
// not hide it (the old startsWith check misclassified those files as server).
function detectDirective(filePath: string): 'use client' | 'use server' | null {
  try {
    return detectFileDirective(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

// Helper to calculate tree stats
function calculateStats(tree: ComponentNode | null, depth = 0): TreeStats {
  if (!tree) {
    return { totalComponents: 0, functionalCount: 0, classCount: 0, maxDepth: 0 };
  }

  let stats: TreeStats = {
    totalComponents: 1,
    functionalCount: tree.type === 'functional' ? 1 : 0,
    classCount: tree.type === 'class' ? 1 : 0,
    maxDepth: depth
  };

  for (const child of tree.children || []) {
    const childStats = calculateStats(child, depth + 1);
    stats.totalComponents += childStats.totalComponents;
    stats.functionalCount += childStats.functionalCount;
    stats.classCount += childStats.classCount;
    stats.maxDepth = Math.max(stats.maxDepth, childStats.maxDepth);
  }

  return stats;
}

// Helper to limit tree depth
function limitTreeDepth(tree: ComponentNode | null, maxDepth: number, currentDepth = 0): ComponentNode | null {
  if (!tree) return null;
  if (currentDepth >= maxDepth) {
    return { ...tree, children: [] };
  }
  return {
    ...tree,
    children: (tree.children || [])
      .map(child => limitTreeDepth(child, maxDepth, currentDepth + 1))
      .filter((c): c is ComponentNode => c !== null)
  };
}

// Helper to add directive to tree nodes
function addDirectivesToTree(tree: ComponentNode | null, baseDir: string, visitedPaths: Map<string, string> = new Map()): ComponentNode | null {
  if (!tree) return null;

  // Resolve the absolute path for this node
  const absolutePath = visitedPaths.get(tree.file) || path.resolve(baseDir, tree.file);
  const directive = detectDirective(absolutePath);

  return {
    ...tree,
    directive,
    children: (tree.children || []).map(child => {
      // For children, try to resolve their path relative to current file's directory
      const childPath = path.resolve(path.dirname(absolutePath), child.file);
      visitedPaths.set(child.file, childPath);
      return addDirectivesToTree(child, baseDir, visitedPaths);
    }).filter((c): c is ComponentNode => c !== null)
  };
}

// Helper to search tree for components by name
function searchTree(tree: ComponentNode | null, name: string, exactMatch: boolean, treePath: string[] = [], depth = 0): ComponentMatch[] {
  if (!tree) return [];

  const matches: ComponentMatch[] = [];
  const fileName = tree.file.replace(/\.(jsx?|tsx?)$/, '');
  const searchName = name.toLowerCase();
  const fileNameLower = fileName.toLowerCase();

  const isMatch = exactMatch
    ? fileNameLower === searchName
    : fileNameLower.includes(searchName);

  if (isMatch) {
    matches.push({
      file: tree.file,
      type: tree.type,
      state: tree.state,
      directive: tree.directive,
      path: [...treePath, tree.file],
      depth
    });
  }

  for (const child of tree.children || []) {
    matches.push(...searchTree(child, name, exactMatch, [...treePath, tree.file], depth + 1));
  }

  return matches;
}

// Count total nodes in tree
function countNodes(tree: ComponentNode | null): number {
  if (!tree) return 0;
  return 1 + (tree.children || []).reduce((sum, child) => sum + countNodes(child), 0);
}

// Helper to find components by type in tree
function findByType(tree: ComponentNode | null, targetType: 'functional' | 'class', baseDir: string, depth = 0): ComponentByType[] {
  if (!tree) return [];

  const matches: ComponentByType[] = [];

  if (tree.type === targetType) {
    matches.push({
      file: tree.file,
      absolutePath: path.resolve(baseDir, tree.file),
      state: tree.state,
      depth
    });
  }

  for (const child of tree.children || []) {
    matches.push(...findByType(child, targetType, baseDir, depth + 1));
  }

  return matches;
}

// Helper to generate recommendation for breaking a cycle
function generateCycleRecommendation(cyclePath: string[]): string {
  if (cyclePath.length < 2) return 'Unable to generate recommendation.';

  const fileNames = cyclePath.map(p => path.basename(p));

  // Check for barrel export patterns (index.ts in the path)
  const barrelIndex = cyclePath.findIndex(p => isIndexFile(p));
  if (barrelIndex !== -1) {
    const barrelDir = path.basename(path.dirname(cyclePath[barrelIndex]));
    return `Break the cycle by moving shared types/interfaces to a separate file (e.g., ${barrelDir}/types.ts) that doesn't import from the barrel (${barrelDir}/index.ts).`;
  }

  // Check if it's a simple A <-> B cycle
  if (cyclePath.length === 3 && fileNames[0] === fileNames[2]) {
    const fileA = fileNames[0].replace(/\.(tsx?|jsx?)$/, '');
    const fileB = fileNames[1].replace(/\.(tsx?|jsx?)$/, '');
    return `Extract shared logic into a new file that both ${fileA} and ${fileB} can import.`;
  }

  // General recommendation
  const firstFile = fileNames[0].replace(/\.(tsx?|jsx?)$/, '');
  const lastFile = fileNames[fileNames.length - 2].replace(/\.(tsx?|jsx?)$/, '');
  return `Consider extracting shared dependencies between ${firstFile} and ${lastFile} into a separate module.`;
}

// Build import graph from a single file (DFS)
function buildImportGraphFromFile(
  filePath: string,
  graph: ImportGraph,
  visited: Set<string>
): void {
  if (visited.has(filePath) || !fs.existsSync(filePath)) return;

  const ast = parseFileToAST(filePath);
  if (!ast) return;

  visited.add(filePath);
  graph[filePath] = [];

  const imports = findImportsInAST(ast);
  const fileDir = path.dirname(filePath);

  for (const importPath of imports) {
    if (!importPath.startsWith('.') && !importPath.startsWith('/')) continue;

    const resolvedPath = resolveImportPath(importPath, fileDir);
    if (!resolvedPath) continue;

    if (isIndexFile(resolvedPath)) {
      // Handle barrel exports
      const barrelExports = resolveBarrelExports(resolvedPath, new Set());
      for (const exportedPath of barrelExports) {
        if (!graph[filePath].includes(exportedPath)) {
          graph[filePath].push(exportedPath);
        }
        buildImportGraphFromFile(exportedPath, graph, visited);
      }
      // Also add the barrel file itself
      if (!graph[filePath].includes(resolvedPath)) {
        graph[filePath].push(resolvedPath);
      }
      buildImportGraphFromFile(resolvedPath, graph, visited);
    } else {
      if (!graph[filePath].includes(resolvedPath)) {
        graph[filePath].push(resolvedPath);
      }
      buildImportGraphFromFile(resolvedPath, graph, visited);
    }
  }
}

// Build import graph from a directory
// When preserveBarrels is true, edges go through barrel files instead of directly to exports
function buildImportGraphFromDirectory(dirPath: string, preserveBarrels = true): ImportGraph {
  const graph: ImportGraph = {};
  const allFiles = scanComponentFiles(dirPath);

  for (const filePath of allFiles) {
    if (!graph[filePath]) {
      graph[filePath] = [];
    }

    const ast = parseFileToAST(filePath);
    if (!ast) continue;

    const imports = findImportsInAST(ast);
    const fileDir = path.dirname(filePath);

    for (const importPath of imports) {
      if (!importPath.startsWith('.') && !importPath.startsWith('/')) continue;

      const resolvedPath = resolveImportPath(importPath, fileDir);
      if (!resolvedPath) continue;

      if (isIndexFile(resolvedPath) && preserveBarrels) {
        // Add edge to the barrel file
        if (!graph[filePath].includes(resolvedPath)) {
          graph[filePath].push(resolvedPath);
        }

        // Ensure barrel file is in graph and points to its exports
        if (!graph[resolvedPath]) {
          graph[resolvedPath] = [];
        }
        const barrelExports = resolveBarrelExports(resolvedPath, new Set());
        for (const exportedPath of barrelExports) {
          if (!graph[resolvedPath].includes(exportedPath)) {
            graph[resolvedPath].push(exportedPath);
          }
        }
      } else if (isIndexFile(resolvedPath)) {
        // Direct mode - skip barrel, go straight to exports
        const barrelExports = resolveBarrelExports(resolvedPath, new Set());
        for (const exportedPath of barrelExports) {
          if (!graph[filePath].includes(exportedPath)) {
            graph[filePath].push(exportedPath);
          }
        }
      } else {
        if (!graph[filePath].includes(resolvedPath)) {
          graph[filePath].push(resolvedPath);
        }
      }
    }
  }

  return graph;
}

// Find all cycles in an import graph using DFS
function findCyclesInGraph(graph: ImportGraph): string[][] {
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const recursionStack = new Set<string>();
  const path: string[] = [];

  function dfs(node: string): void {
    visited.add(node);
    recursionStack.add(node);
    path.push(node);

    const neighbors = graph[node] || [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        dfs(neighbor);
      } else if (recursionStack.has(neighbor)) {
        // Found a cycle - extract it from the path
        const cycleStartIndex = path.indexOf(neighbor);
        if (cycleStartIndex !== -1) {
          const cycle = [...path.slice(cycleStartIndex), neighbor];
          cycles.push(cycle);
        }
      }
    }

    path.pop();
    recursionStack.delete(node);
  }

  for (const node of Object.keys(graph)) {
    if (!visited.has(node)) {
      dfs(node);
    }
  }

  return cycles;
}

// Format cycles into readable output
function formatCircularDepsOutput(circularDeps: CircularDep[]): string {
  if (circularDeps.length === 0) {
    return 'No circular dependencies detected.';
  }

  const lines: string[] = [];
  lines.push(`Circular Dependencies Detected: ${circularDeps.length}`);
  lines.push('');

  for (let i = 0; i < circularDeps.length; i++) {
    const dep = circularDeps[i];
    lines.push(`${i + 1}. ${dep.cycle[0]} ↔ ${dep.cycle[dep.cycle.length - 2]}`);
    lines.push('   Path:');

    for (let j = 0; j < dep.fullPath.length; j++) {
      const file = dep.fullPath[j];
      const isLast = j === dep.fullPath.length - 1;
      const prefix = isLast ? '   └── ' : '   ├── ';
      const suffix = isLast ? ' (cycle)' : '';
      lines.push(`${prefix}${path.basename(file)}${suffix}`);
    }

    lines.push('');
    lines.push(`   Recommendation: ${dep.recommendation}`);
    lines.push('');
  }

  return lines.join('\n');
}

// Helper to detect circular dependencies (updated to return full paths)
function detectCircularImports(
  filePath: string,
  baseDir: string,
  chain: string[] = [],
  visited: Set<string> = new Set(),
  circularDeps: CircularDep[] = []
): { circularDeps: CircularDep[]; filesScanned: number } {
  const absoluteFilePath = path.resolve(baseDir, filePath);

  // Check if we've hit a circular dependency
  const chainIndex = chain.indexOf(absoluteFilePath);
  if (chainIndex !== -1) {
    const cyclePath = chain.slice(chainIndex).concat(absoluteFilePath);
    const cycleFiles = cyclePath.map(p => path.basename(p));
    circularDeps.push({
      cycle: cycleFiles,
      fullPath: cyclePath,
      description: cycleFiles.join(' → '),
      recommendation: generateCycleRecommendation(cyclePath)
    });
    return { circularDeps, filesScanned: 0 };
  }

  // Skip if already fully processed
  if (visited.has(absoluteFilePath)) {
    return { circularDeps, filesScanned: 0 };
  }

  if (!fs.existsSync(absoluteFilePath)) {
    return { circularDeps, filesScanned: 0 };
  }

  const ast = parseFileToAST(absoluteFilePath);
  if (!ast) {
    return { circularDeps, filesScanned: 0 };
  }

  visited.add(absoluteFilePath);
  const newChain = [...chain, absoluteFilePath];
  let filesScanned = 1;

  const imports = findImportsInAST(ast);
  const fileDir = path.dirname(absoluteFilePath);

  for (const importPath of imports) {
    if (!importPath.startsWith('.') && !importPath.startsWith('/')) continue;

    const resolvedPath = resolveImportPath(importPath, fileDir);

    if (resolvedPath) {
      // Check if this is a barrel/index file
      if (isIndexFile(resolvedPath)) {
        // Get all re-exported files from the barrel
        const barrelExports = resolveBarrelExports(resolvedPath, new Set(visited));
        for (const exportedPath of barrelExports) {
          const result = detectCircularImports(exportedPath, baseDir, newChain, visited, circularDeps);
          filesScanned += result.filesScanned;
        }
      } else {
        const result = detectCircularImports(resolvedPath, baseDir, newChain, visited, circularDeps);
        filesScanned += result.filesScanned;
      }
    }
  }

  return { circularDeps, filesScanned };
}

/**
 * Tool: get_component_tree
 * Parse a React application and return the full component tree structure
 */
export function getComponentTree(entryFile: string, maxDepth?: number): GetComponentTreeResult {
  try {
    const absoluteEntryFile = assertPathInWorkspace(entryFile, 'entryFile');
    const baseDir = path.dirname(absoluteEntryFile);
    let tree = buildComponentTree(absoluteEntryFile, baseDir);

    // Add RSC directive detection to all nodes
    if (tree) {
      const visitedPaths = new Map<string, string>();
      visitedPaths.set(tree.file, absoluteEntryFile);
      tree = addDirectivesToTree(tree, baseDir, visitedPaths);
    }

    if (maxDepth !== undefined && tree) {
      tree = limitTreeDepth(tree, maxDepth);
    }

    const stats = calculateStats(tree);
    return { tree, stats };
  } catch (err) {
    return {
      tree: null,
      stats: { totalComponents: 0, functionalCount: 0, classCount: 0, maxDepth: 0 },
      error: `Parse error: ${err instanceof Error ? err.message : String(err)}`
    };
  }
}

/**
 * Tool: get_component_details
 * Get detailed information about a specific component file
 */
export function getComponentDetails(filePath: string): GetComponentDetailsResult {
  try {
    const absoluteFilePath = assertPathInWorkspace(filePath, 'filePath');
    const ast = parseFileToAST(absoluteFilePath);
    if (!ast) {
      return {
        file: path.basename(absoluteFilePath),
        absolutePath: absoluteFilePath,
        type: null,
        state: [],
        imports: [],
        directChildren: [],
        error: `Failed to parse file: ${absoluteFilePath}`
      };
    }

    const { type, stateVariables } = findComponentTypeAndState(ast);
    const importPaths = findImportsInAST(ast);
    const directive = detectDirective(absoluteFilePath);

    // Categorize imports
    const imports = importPaths.map((source: string) => ({
      source,
      isLocal: source.startsWith('.') || source.startsWith('/')
    }));

    // Find which local imports resolve to actual component files
    const directChildren: string[] = [];
    const fileDir = path.dirname(absoluteFilePath);

    for (const imp of importPaths) {
      if (!imp.startsWith('.') && !imp.startsWith('/')) continue;

      const resolvedPath = resolveImportPath(imp, fileDir);
      if (resolvedPath) {
        // Check if this is a barrel/index file
        if (isIndexFile(resolvedPath)) {
          // Get all re-exported files from the barrel
          const barrelExports = resolveBarrelExports(resolvedPath, new Set());
          for (const exportedPath of barrelExports) {
            directChildren.push(path.basename(exportedPath));
          }
        } else {
          directChildren.push(path.basename(resolvedPath));
        }
      }
    }

    return {
      file: path.basename(absoluteFilePath),
      absolutePath: absoluteFilePath,
      type,
      state: stateVariables,
      directive,
      imports,
      directChildren
    };
  } catch (err) {
    return {
      file: path.basename(filePath),
      absolutePath: path.resolve(filePath),
      type: null,
      state: [],
      imports: [],
      directChildren: [],
      error: `Error: ${err instanceof Error ? err.message : String(err)}`
    };
  }
}

/**
 * Tool: find_component_by_name
 * Search for components by name within a component tree
 */
export function findComponentByName(entryFile: string, componentName: string, exactMatch = false): FindComponentByNameResult {
  try {
    const absoluteEntryFile = assertPathInWorkspace(entryFile, 'entryFile');
    const baseDir = path.dirname(absoluteEntryFile);
    let tree = buildComponentTree(absoluteEntryFile, baseDir);

    if (!tree) {
      return {
        matches: [],
        totalSearched: 0,
        error: `Failed to build component tree from: ${absoluteEntryFile}`
      };
    }

    // Add directives to tree before searching
    const visitedPaths = new Map<string, string>();
    visitedPaths.set(tree.file, absoluteEntryFile);
    tree = addDirectivesToTree(tree, baseDir, visitedPaths);

    const matches = searchTree(tree, componentName, exactMatch);
    const totalSearched = countNodes(tree);

    return {
      matches,
      totalSearched,
      note: matches.length === 0
        ? `No match for "${componentName}" among ${totalSearched} components reachable from ${path.basename(absoluteEntryFile)}. Two blind spots make an empty result inconclusive: (1) matching is by FILE basename — a component exported from index.tsx or named differently from its file cannot match; (2) only the entry file's static import graph is searched — components loaded via lazy()/dynamic import or referenced only in route configs are invisible here. Grep the identifier to disambiguate.`
        : undefined,
    };
  } catch (err) {
    return {
      matches: [],
      totalSearched: 0,
      error: `Error: ${err instanceof Error ? err.message : String(err)}`
    };
  }
}

/**
 * Tool: find_components_by_type
 * Find all components of a specific type (functional or class)
 */
export function findComponentsByType(entryFile: string, componentType: 'functional' | 'class'): FindComponentsByTypeResult {
  try {
    const absoluteEntryFile = assertPathInWorkspace(entryFile, 'entryFile');
    const baseDir = path.dirname(absoluteEntryFile);
    const tree = buildComponentTree(absoluteEntryFile, baseDir);

    if (!tree) {
      return {
        components: [],
        totalSearched: 0,
        error: `Failed to build component tree from: ${absoluteEntryFile}`
      };
    }

    const components = findByType(tree, componentType, baseDir);
    const totalSearched = countNodes(tree);

    return {
      components,
      totalSearched,
      note: components.length === 0
        ? `No ${componentType} components among the ${totalSearched} reachable from ${path.basename(absoluteEntryFile)}'s static import graph. Components behind lazy()/dynamic imports or other entry points were not searched.`
        : undefined,
    };
  } catch (err) {
    return {
      components: [],
      totalSearched: 0,
      error: `Error: ${err instanceof Error ? err.message : String(err)}`
    };
  }
}

/**
 * Tool: detect_circular_deps
 * Detect circular dependencies in a React codebase
 * Supports both single file entry and directory scanning
 */
export function detectCircularDeps(rootPath: string): DetectCircularDepsResult {
  try {
    const absolutePath = assertPathInWorkspace(rootPath, 'rootPath');
    const stats = fs.statSync(absolutePath);
    let circularDeps: CircularDep[] = [];
    let filesScanned = 0;

    if (stats.isDirectory()) {
      // Directory mode: scan all files and build import graph
      const graph = buildImportGraphFromDirectory(absolutePath);
      filesScanned = Object.keys(graph).length;

      const cycles = findCyclesInGraph(graph);

      // Convert cycles to CircularDep objects
      for (const cyclePath of cycles) {
        const cycleFiles = cyclePath.map(p => path.basename(p));
        circularDeps.push({
          cycle: cycleFiles,
          fullPath: cyclePath,
          description: cycleFiles.join(' → '),
          recommendation: generateCycleRecommendation(cyclePath)
        });
      }
    } else {
      // Single file mode: use DFS from entry point
      const baseDir = path.dirname(absolutePath);
      const result = detectCircularImports(absolutePath, baseDir);
      circularDeps = result.circularDeps;
      filesScanned = result.filesScanned;
    }

    // Deduplicate circular dependencies (same cycle can be detected from multiple entry points)
    // Use rotation-normalization: find the lexicographically smallest rotation of each cycle
    // This correctly deduplicates A→B→C→A detected from different starting points,
    // while preserving distinct cycles through the same nodes in different directions
    const uniqueCycles = new Map<string, CircularDep>();
    for (const dep of circularDeps) {
      const nodes = dep.cycle.slice(0, -1); // Remove trailing duplicate (A→B→C→A becomes [A,B,C])
      let minRotation = nodes.join('|');
      for (let i = 1; i < nodes.length; i++) {
        const rotated = [...nodes.slice(i), ...nodes.slice(0, i)].join('|');
        if (rotated < minRotation) {
          minRotation = rotated;
        }
      }
      if (!uniqueCycles.has(minRotation)) {
        uniqueCycles.set(minRotation, dep);
      }
    }

    const uniqueDeps = Array.from(uniqueCycles.values());
    const formattedOutput = formatCircularDepsOutput(uniqueDeps);

    return {
      hasCircularDeps: uniqueDeps.length > 0,
      circularDependencies: uniqueDeps,
      formattedOutput,
      totalFilesScanned: filesScanned,
      scanScope: { root: absolutePath, maxDepth: 5, excluded: ['node_modules'] },
      note: uniqueDeps.length === 0
        ? `No cycles among the ${filesScanned} files scanned under ${absolutePath} (depth ≤ 5, node_modules excluded). Files deeper than the cap or outside this root were not part of the graph — a clean result covers only the scanned scope.`
        : undefined,
    };
  } catch (err) {
    return {
      hasCircularDeps: false,
      circularDependencies: [],
      formattedOutput: '',
      totalFilesScanned: 0,
      error: `Error: ${err instanceof Error ? err.message : String(err)}`
    };
  }
}

// findComponentFiles replaced by scanComponentFiles from core/utils/file-scanner

// Helper to check if an import resolves to a target file
function importResolvesToTarget(
  importPath: string,
  fromFile: string,
  targetFile: string,
  aliasMap?: AliasMap | null
): boolean {
  const extensions = ['', '.jsx', '.tsx', '.js', '.ts'];
  const fromDir = path.dirname(fromFile);

  // Candidate base paths: relative/absolute imports resolve from the importing
  // file; aliased imports (@/components/x) resolve via tsconfig paths — without
  // this, every alias-importing file was silently missed.
  const bases: string[] = [];
  if (importPath.startsWith('.') || importPath.startsWith('/')) {
    bases.push(path.resolve(fromDir, importPath));
  } else {
    bases.push(...resolveAliasedImport(importPath, aliasMap ?? null));
  }

  for (const base of bases) {
    for (const ext of extensions) {
      if (`${base}${ext}` === targetFile) return true;
      // Also check /index variants
      if (path.join(base, `index${ext}`) === targetFile) return true;
    }
  }

  return false;
}

/**
 * Tool: get_used_by
 * Find all components that import/use a specific component
 */
export function getUsedBy(componentPath: string, searchDir?: string): GetUsedByResult {
  try {
    const targetPath = assertPathInWorkspace(componentPath, 'componentPath');
    // Default to the WORKSPACE ROOT, not the component's parent directory.
    // The old default silently scanned only sibling files, so `usedBy: []`
    // usually meant "I looked in one folder", not "nothing imports this".
    const baseDir = searchDir
      ? assertPathInWorkspace(searchDir, 'searchDir')
      : (getWorkspaceRoot() ?? path.dirname(targetPath));

    const SCAN_DEPTH = 8;
    // Find all component files in the search directory
    const allFiles = scanComponentFiles(baseDir, { maxDepth: SCAN_DEPTH });
    // tsconfig path aliases — resolved from the TARGET's directory so the
    // nearest project config governs (monorepo-friendly).
    const aliasMap = loadPathAliases(path.dirname(targetPath));
    const usedBy: UsedByMatch[] = [];

    for (const filePath of allFiles) {
      // Skip the target file itself
      if (filePath === targetPath) {
        continue;
      }

      try {
        const ast = parseFileToAST(filePath);
        if (!ast) continue;

        // Unfiltered imports — aliased ones are matched via tsconfig paths
        const imports = findAllImportsInAST(ast);

        // Check if any import resolves to our target
        for (const importPath of imports) {
          if (importResolvesToTarget(importPath, filePath, targetPath, aliasMap)) {
            const { type } = findComponentTypeAndState(ast);
            const directive = detectDirective(filePath);

            usedBy.push({
              file: path.basename(filePath),
              absolutePath: filePath,
              type,
              directive,
              importStatement: importPath
            });
            break; // Only add each file once
          }
        }
      } catch {
        // Skip files that can't be parsed
      }
    }

    // Sort by file name
    usedBy.sort((a, b) => a.file.localeCompare(b.file));

    const searchScope = { root: baseDir, maxDepth: SCAN_DEPTH };
    return {
      component: path.basename(componentPath),
      usedBy,
      totalFilesScanned: allFiles.length,
      searchScope,
      note: usedBy.length === 0
        ? `No importers found among ${allFiles.length} files under ${baseDir} (depth ≤ ${SCAN_DEPTH}, node_modules excluded). If that root covers the whole project, this component is genuinely unimported; files deeper than the depth cap or outside this root were not checked.`
        : undefined,
    };
  } catch (err) {
    return {
      component: path.basename(componentPath),
      usedBy: [],
      totalFilesScanned: 0,
      error: `Error: ${err instanceof Error ? err.message : String(err)}`
    };
  }
}

// Re-export types from prop-flow for consumers
export type { PropFlowNode, FlowBoundary };

export interface GetPropFlowResult {
  sourceProp: string;
  sourceComponent: string;
  sourceFile: string;
  flow: PropFlowNode[];
  boundaries: FlowBoundary[];
  totalComponentsTraced: number;
  note?: string;
  error?: string;
}

/**
 * Tool: get_prop_flow
 * Trace how a prop flows through the component tree
 */
export function getPropFlow(sourceFile: string, propName: string, maxDepth?: number): GetPropFlowResult {
  try {
    const absoluteSourceFile = assertPathInWorkspace(sourceFile, 'sourceFile');
    const result = tracePropFlow(absoluteSourceFile, propName, { maxDepth });

    return {
      sourceProp: result.sourceProp,
      sourceComponent: result.sourceComponent,
      sourceFile: result.sourceFile,
      flow: result.flow,
      boundaries: result.boundaries,
      totalComponentsTraced: result.totalComponentsTraced,
      note: !result.error && result.flow.length === 0
        ? `Empty flow for "${propName}" from ${result.sourceComponent || path.basename(absoluteSourceFile)}. This means one of: the component has no prop named "${propName}" (check spelling/its props type), the prop exists but is never forwarded to children, or forwarding happens through a pattern this tracer can't follow (spread props, render props, context). An empty flow does NOT prove the prop is unused.`
        : undefined,
      error: result.error
    };
  } catch (err) {
    return {
      sourceProp: propName,
      sourceComponent: '',
      sourceFile: path.resolve(sourceFile),
      flow: [],
      boundaries: [],
      totalComponentsTraced: 0,
      error: `Error: ${err instanceof Error ? err.message : String(err)}`
    };
  }
}

// Re-export types from hook-deps for consumers
export type { HookDependencyInfo, DependencyInfo };

export interface GetHookDepsResult {
  file: string;
  component: string | null;
  hooks: HookDependencyInfo[];
  totalHooks: number;
  issueCount: number;
  stateVariables: string[];
  propDestructures: string[];
  contextUsages: string[];
  refVariables: string[];
  note?: string;
  error?: string;
}

/**
 * Tool: get_hook_deps
 * Analyze hook dependencies in a React component file
 */
export function getHookDeps(filePath: string): GetHookDepsResult {
  try {
    const absoluteFilePath = assertPathInWorkspace(filePath, 'filePath');
    const result = analyzeHookDependencies(absoluteFilePath);

    return {
      file: result.file,
      component: result.component,
      hooks: result.hooks,
      totalHooks: result.totalHooks,
      issueCount: result.issueCount,
      stateVariables: result.stateVariables,
      propDestructures: result.propDestructures,
      contextUsages: result.contextUsages,
      refVariables: result.refVariables,
      note: !result.error && result.totalHooks === 0
        ? (result.component
            ? `${result.component} uses no dependency-tracked hooks (useEffect/useMemo/useCallback/useLayoutEffect/useInsertionEffect/useImperativeHandle). Hooks like useState/useRef have no dependency arrays and are reported in the stateVariables/refVariables fields instead.`
            : `No component detected in ${result.file} — this looks like a non-component module, so hook-dependency analysis has nothing to inspect. If a component IS defined here, its declaration pattern may not be recognized (PascalCase function/arrow declarations are).`)
        : undefined,
      error: result.error
    };
  } catch (err) {
    return {
      file: path.basename(filePath),
      component: null,
      hooks: [],
      totalHooks: 0,
      issueCount: 0,
      stateVariables: [],
      propDestructures: [],
      contextUsages: [],
      refVariables: [],
      error: `Error: ${err instanceof Error ? err.message : String(err)}`
    };
  }
}

// Re-export types from navigation-parser for consumers
export type { NavigatorInfo, ScreenInfo, NavigationNode, NavigatorType };

// Re-export types from context-parser for consumers
export type { ContextDefinition, ProviderUsage, ContextConsumer, CustomContextHook, ContextHierarchyNode };

// Re-export types from screen-parser for consumers
export type { ScreenDefinition, ComponentUsage, ScreenComponentMap };

// Re-export types from complexity-parser for consumers
export type { ComponentComplexity, ComplexityMetrics, ComplexityReportSummary };

// Re-export types from rerender-risk-parser for consumers
export type { RerenderRisk, RerenderRiskSummary, FileRerenderRisks, RiskType, RiskSeverity };

export interface GetNavigationStructureResult {
  navigators: NavigatorInfo[];
  screens: ScreenInfo[];
  tree: NavigationNode | null;
  formattedTree: string;
  totalNavigators: number;
  totalScreens: number;
  warnings: string[];
  error?: string;
}

/**
 * Tool: get_navigation_structure
 * Parse and visualize routing/navigation structure in React codebases.
 * Auto-detects: React Navigation (RN), Next.js App Router, React Router v6/v7, Remix.
 */
export function getNavigationStructure(rootPath: string): GetNavigationStructureResult {
  try {
    const absolutePath = assertPathInWorkspace(rootPath, 'rootPath');

    // Step 1: Try React Navigation (existing RN parser)
    const structure = parseNavigationStructure(absolutePath);

    // Step 2: If RN found nothing, try web routing parsers
    if (!structure.root && structure.allNavigators.length === 0) {
      const detectedFramework = detectWebFramework(absolutePath);
      const webStructure = parseWebRoutingStructure(absolutePath);
      if (webStructure && webStructure.root) {
        const formattedTree = formatNavigationTree(webStructure);
        return {
          navigators: webStructure.allNavigators,
          screens: webStructure.allScreens,
          tree: webStructure.root,
          formattedTree,
          totalNavigators: webStructure.allNavigators.length,
          totalScreens: webStructure.allScreens.length,
          warnings: webStructure.warnings
        };
      }

      // Neither parser produced a tree. Name what was actually tried and
      // found — a Next.js project must not be told it's "missing React
      // Navigation" (that misdirects an agent at the wrong framework).
      const attempted = detectedFramework
        ? `Detected framework '${detectedFramework}' but could not extract a route tree from it${webStructure?.warnings?.length ? ` (${webStructure.warnings[0]})` : ''}.`
        : 'No routing framework detected. Tried: React Navigation (createXNavigator), Expo Router (app/_layout.*), Next.js App Router (app/layout.* or app/page.*), Next.js Pages Router (pages/ + next dependency), Remix (app/routes/), React Router (react-router dependency or imports).';
      structure.warnings = [
        attempted,
        ...structure.warnings.filter(w => w !== 'No React Navigation navigators found'),
      ];
    }

    // Step 3: Return RN result (or empty if nothing found)
    const formattedTree = formatNavigationTree(structure);

    return {
      navigators: structure.allNavigators,
      screens: structure.allScreens,
      tree: structure.root,
      formattedTree,
      totalNavigators: structure.allNavigators.length,
      totalScreens: structure.allScreens.length,
      warnings: structure.warnings
    };
  } catch (err) {
    return {
      navigators: [],
      screens: [],
      tree: null,
      formattedTree: '',
      totalNavigators: 0,
      totalScreens: 0,
      warnings: [],
      error: `Error: ${err instanceof Error ? err.message : String(err)}`
    };
  }
}

export interface GetContextMapResult {
  contexts: ContextDefinition[];
  providers: ProviderUsage[];
  consumers: ContextConsumer[];
  customHooks: CustomContextHook[];
  hierarchy: ContextHierarchyNode[];
  formattedTree: string;
  totalContexts: number;
  totalConsumers: number;
  note?: string;
  warnings: string[];
  error?: string;
}

/**
 * Tool: get_context_map
 * Map React Context providers to their consumers
 */
export function getContextMap(rootPath: string): GetContextMapResult {
  try {
    const absolutePath = assertPathInWorkspace(rootPath, 'rootPath');
    const result = parseContextMap(absolutePath);
    const formattedTree = formatContextMap(result);

    return {
      contexts: result.contexts,
      providers: result.providers,
      consumers: result.consumers,
      customHooks: result.customHooks,
      hierarchy: result.hierarchy,
      formattedTree,
      totalContexts: result.contexts.length,
      totalConsumers: result.consumers.length,
      note: result.contexts.length === 0
        ? `No createContext() calls found under ${absolutePath} (scan depth ≤ 5, node_modules excluded). Either this codebase genuinely doesn't use the Context API, or its contexts live outside this root / deeper than the scan cap — pass the project's source root to be sure. State libraries (Zustand, Redux, Jotai) are NOT detected by this tool.`
        : undefined,
      warnings: result.warnings
    };
  } catch (err) {
    return {
      contexts: [],
      providers: [],
      consumers: [],
      customHooks: [],
      hierarchy: [],
      formattedTree: '',
      totalContexts: 0,
      totalConsumers: 0,
      warnings: [],
      error: `Error: ${err instanceof Error ? err.message : String(err)}`
    };
  }
}

export interface GetScreenComponentsResult {
  screens: ScreenComponentMap[];
  formattedTree: string;
  totalScreens: number;
  warnings: string[];
  error?: string;
}

/**
 * Tool: get_screen_components
 * Map which screens use which components
 */
export function getScreenComponents(rootPath: string, screenName?: string, maxDepth?: number): GetScreenComponentsResult {
  try {
    const absolutePath = assertPathInWorkspace(rootPath, 'rootPath');
    const effectiveMaxDepth = maxDepth !== undefined ? Math.min(Math.max(maxDepth, 1), 12) : undefined;
    const result = parseScreenComponents(absolutePath, screenName, effectiveMaxDepth);
    const formattedTree = formatScreenComponents(result);

    // Empty result guidance: "screens" is a React Native / navigation-config
    // concept. On web apps (Next.js, Vite SPAs) the heuristics match nothing —
    // say so and point at the tools that DO model those archetypes, instead of
    // a bare "No screens found" the agent has to decode. (Issue #36)
    const warnings = [...result.warnings];
    if (result.totalScreens === 0 && !screenName) {
      const fs = require('fs') as typeof import('fs');
      const path = require('path') as typeof import('path');
      const looksNext =
        fs.existsSync(path.join(absolutePath, 'next.config.js')) ||
        fs.existsSync(path.join(absolutePath, 'next.config.mjs')) ||
        fs.existsSync(path.join(absolutePath, 'app')) && fs.existsSync(path.join(absolutePath, 'app', 'layout.tsx'));
      warnings.push(
        looksNext
          ? 'This looks like a Next.js app — it has pages, not "screens". Screen detection covers React Navigation config, screens/ folders, and *Screen-suffixed components only. Use get_navigation_structure for the route map and get_component_tree on a page.tsx for its component usage.'
          : 'Screen detection looked for React Navigation config, a screens/ folder, and *Screen-suffixed components — none matched, so this codebase may have no screen concept (common for web apps). Use get_navigation_structure for routing or get_component_tree for component structure instead.'
      );
    }

    return {
      screens: result.screens,
      formattedTree,
      totalScreens: result.totalScreens,
      warnings
    };
  } catch (err) {
    return {
      screens: [],
      formattedTree: '',
      totalScreens: 0,
      warnings: [],
      error: `Error: ${err instanceof Error ? err.message : String(err)}`
    };
  }
}

export interface GetComplexityReportResult {
  components: ComponentComplexity[];
  summary: ComplexityReportSummary;
  formattedReport: string;
  warnings: string[];
  error?: string;
}

/**
 * Tool: get_complexity_report
 * Calculate and visualize component complexity metrics
 * Identifies potential refactoring candidates based on complexity scores
 */
export function getComplexityReport(rootPath: string, threshold?: number): GetComplexityReportResult {
  try {
    const absolutePath = assertPathInWorkspace(rootPath, 'rootPath');
    const result = parseComplexityReport(absolutePath, threshold);

    return {
      components: result.components,
      summary: result.summary,
      formattedReport: result.formattedReport,
      warnings: result.warnings
    };
  } catch (err) {
    return {
      components: [],
      summary: { high: 0, medium: 0, low: 0, average: 0, totalComponents: 0 },
      formattedReport: '',
      warnings: [],
      error: `Error: ${err instanceof Error ? err.message : String(err)}`
    };
  }
}

export interface GetRerenderRisksResult {
  files: FileRerenderRisks[];
  summary: RerenderRiskSummary;
  formattedReport: string;
  warnings: string[];
  error?: string;
}

/**
 * Tool: get_rerender_risks
 * Detect React re-render anti-patterns: inline objects/arrays/functions,
 * missing useCallback/useMemo. Returns risks by file with severity and suggestions.
 */
export function getRerenderRisks(rootPath: string, minSeverity?: RiskSeverity): GetRerenderRisksResult {
  try {
    const absolutePath = assertPathInWorkspace(rootPath, 'rootPath');
    const result = parseRerenderRiskReport(absolutePath, minSeverity);

    return {
      files: result.files,
      summary: result.summary,
      formattedReport: result.formattedReport,
      warnings: result.warnings,
    };
  } catch (err) {
    return {
      files: [],
      summary: {
        totalFiles: 0,
        totalRisks: 0,
        byType: { 'inline-object': 0, 'inline-array': 0, 'inline-function': 0, 'missing-useCallback': 0, 'missing-useMemo': 0 },
        bySeverity: { low: 0, medium: 0, high: 0 },
        topOffenders: [],
      },
      formattedReport: '',
      warnings: [],
      error: `Error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ============================================================================
// AI-Controlled Visualization Tools
// ============================================================================

// These tools communicate with the VS Code extension via URI handler.
// The MCP server runs as a separate process, so we use URI scheme to bridge:
// vscode://dendro-mcp.dendro-mcp/<command>?<params>

// Types for visualization results
export type HighlightColor = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple';
export type AnnotationPosition = 'top' | 'right' | 'bottom' | 'left';
export type AnnotationStyle = 'callout' | 'badge' | 'tooltip';
export type FlowType = 'prop' | 'state' | 'context' | 'event';
export type ClearType = 'highlights' | 'annotations' | 'flows' | 'all';

export interface VisualizeHighlightResult {
  success: boolean;
  sessionId?: string;
  requestedCount?: number;
  note?: string;
  error?: string;
}

export interface VisualizeZoomResult {
  success: boolean;
  sessionId?: string;
  note?: string;
  error?: string;
}

export interface VisualizeAnnotateResult {
  success: boolean;
  sessionId?: string;
  annotationId?: string;
  note?: string;
  error?: string;
}

export interface VisualizeTraceFlowResult {
  success: boolean;
  sessionId?: string;
  flowId?: string;
  note?: string;
  error?: string;
}

export interface VisualizeClearResult {
  success: boolean;
  sessionId?: string;
  note?: string;
  error?: string;
}

export interface VisualizeExpandResult {
  success: boolean;
  sessionId?: string;
  note?: string;
  error?: string;
}

export interface VisualizeCollapseResult {
  success: boolean;
  sessionId?: string;
  note?: string;
  error?: string;
}

// Fallback URI base — used only when the extension handshake file is absent
// (extension not activated yet, or MCP server running standalone).
const DENDRO_URI_BASE_FALLBACK = 'vscode://rooneytech.dendro-react';

// Every visualize_* command is dispatched fire-and-forget over a vscode:// URI.
// success:true means "the URI was sent", NOT "it rendered" — that distinction
// has hidden real failures (extension not running, wrong window focused,
// stale extension ID). The note keeps agents from over-trusting the result.
const VIZ_DISPATCH_NOTE =
  'Command dispatched to the VS Code extension fire-and-forget: success means it was SENT, not that it rendered. If nothing changed on screen, check that VS Code is running with the Dendro visualizer open, and note that vscode:// URIs land in the MOST RECENTLY FOCUSED VS Code window.';

interface ExtensionInfo { extensionId?: string; uriScheme?: string; version?: string }

let cachedExtensionInfo: { value: ExtensionInfo | null; readAt: number } | null = null;

/** Read the extension's handshake file (written on activation) — cached for 30s. */
export function readExtensionInfo(): ExtensionInfo | null {
  const now = Date.now();
  if (cachedExtensionInfo && now - cachedExtensionInfo.readAt < 30_000) return cachedExtensionInfo.value;
  let value: ExtensionInfo | null = null;
  try {
    const infoPath = path.join(getWorkspaceIpcDir(), 'extension-info.json');
    value = JSON.parse(fs.readFileSync(infoPath, 'utf-8')) as ExtensionInfo;
  } catch {
    value = null;
  }
  cachedExtensionInfo = { value, readAt: now };
  return value;
}

/**
 * URI base for the VS Code extension. Derived from the installed extension's
 * REAL identity via the handshake file — a hardcoded ID silently no-ops every
 * vscode:// call if the publisher/name ever drifts (it has before).
 */
function DENDRO_URI_BASE_GET(): string {
  const info = readExtensionInfo();
  if (info?.extensionId) return `${info.uriScheme || 'vscode'}://${info.extensionId}`;
  return DENDRO_URI_BASE_FALLBACK;
}
// Keep the existing `${DENDRO_URI_BASE}` call sites working via a getter.
const DENDRO_URI_BASE = { toString: DENDRO_URI_BASE_GET } as { toString(): string };

/**
 * Helper to open a VS Code URI (bridges MCP process to extension process)
 * Returns a promise that resolves when the URI is opened
 */
function openVSCodeUri(uri: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Use execFile (no shell) to prevent command injection
    const platform = process.platform;
    let cmd: string;
    let args: string[];

    if (platform === 'darwin') {
      cmd = 'open';
      args = [uri];
    } else if (platform === 'win32') {
      cmd = 'cmd';
      args = ['/c', 'start', '', uri];
    } else {
      cmd = 'xdg-open';
      args = [uri];
    }

    execFile(cmd, args, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

/**
 * Tool: open_visualizer
 * Open the Dendro neural visualizer webview in VS Code for a given entry file.
 * Must be called before using other visualization tools (highlight, zoom, annotate, etc.)
 */
export interface OpenVisualizerResult {
  success: boolean;
  ready: boolean;
  message: string;
  entryFile: string;
  sessionId?: string;
  treeNodeCount?: number;
  warning?: string;
}

/**
 * A 1-2 node tree almost always means the entry file is a thin wrapper or a
 * framework layout (e.g. a Next.js root layout imports no pages) — the
 * visualizer renders, but highlights/zooms against it silently miss. Count
 * the parsed tree so agents learn this from the response, not from a blank
 * walkthrough. (Issue #37)
 */
function measureEntryTree(entryFile: string): { count: number; warning?: string } {
  try {
    const tree = buildComponentTree(entryFile, path.dirname(entryFile));
    let count = 0;
    const walk = (n: { children?: unknown[] } | null): void => {
      if (!n) return;
      count++;
      for (const c of (n.children ?? []) as { children?: unknown[] }[]) walk(c);
    };
    walk(tree as { children?: unknown[] } | null);
    if (count <= 2) {
      return {
        count,
        warning: `The parsed tree from this entry file has only ${count} node${count === 1 ? '' : 's'} — the entry is likely a wrapper or framework layout that does not import the real component graph (Next.js layouts never import pages). Visualization commands against missing components will silently no-op. Pick a higher-fan-out entry (a page/screen component), or run get_component_tree on candidates first.`,
      };
    }
    return { count };
  } catch {
    return { count: 0 };
  }
}

export async function openVisualizer(entryFile: string): Promise<OpenVisualizerResult> {
  // Validate path boundary before sending to VS Code
  assertPathInWorkspace(entryFile, 'entryFile');

  // Clear stale status and write pending
  clearVisualizerStatus();
  writeVisualizerPending(entryFile);

  // Fire the URI to open the visualizer
  const uri = `${DENDRO_URI_BASE}/visualize?file=${encodeURIComponent(entryFile)}`;
  try {
    await openVSCodeUri(uri);
  } catch (err) {
    console.error('Dendro: Failed to open visualizer:', err);
    return {
      success: false,
      ready: false,
      message: `Failed to open VS Code URI: ${err}`,
      entryFile,
    };
  }

  // Poll for ready signal from the extension (5s timeout, 200ms interval)
  const readyStatus = await pollVisualizerReady(5000, 200);

  const treeInfo = measureEntryTree(entryFile);

  if (readyStatus) {
    return {
      success: true,
      ready: true,
      message: `Dendro visualizer is ready for ${path.basename(entryFile)}. You can now send visualization commands.`,
      entryFile,
      sessionId: readyStatus.sessionId,
      ...(treeInfo.count > 0 ? { treeNodeCount: treeInfo.count } : {}),
      ...(treeInfo.warning ? { warning: treeInfo.warning } : {}),
    };
  }

  // Timeout — still return success since extension queue will catch commands
  return {
    success: true,
    ready: false,
    message: `Dendro visualizer opened for ${path.basename(entryFile)} but ready confirmation not received within 5s. Commands will be queued by the extension.`,
    entryFile,
    ...(treeInfo.count > 0 ? { treeNodeCount: treeInfo.count } : {}),
    ...(treeInfo.warning ? { warning: treeInfo.warning } : {}),
  };
}

/**
 * Tool: visualize_highlight
 * Highlight specific nodes in the visualizer with color and optional label
 *
 * Use cases:
 * - Highlight circular dependency cycle in red
 * - Highlight components that will re-render in yellow
 * - Highlight entry point in green
 */
export function visualizeHighlight(
  nodes: string[],
  color: HighlightColor,
  options?: {
    sessionId?: string;
    label?: string;
    pulse?: boolean;
    duration?: number;
    entryFile?: string;
  }
): VisualizeHighlightResult {
  const params = new URLSearchParams();
  params.set('nodes', nodes.join(','));
  params.set('color', color);
  if (options?.label) params.set('label', options.label);
  if (options?.pulse !== undefined) params.set('pulse', String(options.pulse));
  if (options?.duration !== undefined) params.set('duration', String(options.duration));
  if (options?.sessionId) params.set('sessionId', options.sessionId);
  if (options?.entryFile) params.set('entryFile', options.entryFile);

  const uri = `${DENDRO_URI_BASE}/highlight?${params.toString()}`;

  // Fire and forget - URI handler in extension will process
  openVSCodeUri(uri).catch((err) => {
    console.error('Dendro: Failed to open URI:', err);
  });

  return {
    success: true,
    requestedCount: nodes.length,
    note: `${VIZ_DISPATCH_NOTE} Nodes not present in the visualized tree are silently skipped — use node names from get_component_tree results.`
  };
}

/**
 * Tool: visualize_zoom
 * Zoom and pan the visualizer to focus on specific node(s)
 *
 * Use cases:
 * - Zoom to circular dependency after highlighting
 * - Zoom to specific component user asked about
 * - Zoom out to show full tree
 */
export function visualizeZoom(
  target: string | string[],
  options?: {
    sessionId?: string;
    padding?: number;
    duration?: number;
    entryFile?: string;
  }
): VisualizeZoomResult {
  const params = new URLSearchParams();
  params.set('target', Array.isArray(target) ? target.join(',') : target);
  if (options?.padding !== undefined) params.set('padding', String(options.padding));
  if (options?.duration !== undefined) params.set('duration', String(options.duration));
  if (options?.sessionId) params.set('sessionId', options.sessionId);
  if (options?.entryFile) params.set('entryFile', options.entryFile);

  const uri = `${DENDRO_URI_BASE}/zoom?${params.toString()}`;

  openVSCodeUri(uri).catch((err) => {
    console.error('Dendro: Failed to open URI:', err);
  });

  return {
    success: true,
    note: VIZ_DISPATCH_NOTE,
  };
}

/**
 * Tool: visualize_annotate
 * Add text annotations/callouts to nodes in the visualizer
 *
 * Use cases:
 * - "This barrel export creates the cycle"
 * - "State defined here"
 * - "Props flow from here"
 */
export function visualizeAnnotate(
  nodeId: string,
  text: string,
  options?: {
    sessionId?: string;
    position?: AnnotationPosition;
    style?: AnnotationStyle;
    color?: string;
    entryFile?: string;
  }
): VisualizeAnnotateResult {
  const params = new URLSearchParams();
  params.set('nodeId', nodeId);
  params.set('text', text);
  if (options?.position) params.set('position', options.position);
  if (options?.style) params.set('style', options.style);
  if (options?.color) params.set('color', options.color);
  if (options?.sessionId) params.set('sessionId', options.sessionId);
  if (options?.entryFile) params.set('entryFile', options.entryFile);

  const uri = `${DENDRO_URI_BASE}/annotate?${params.toString()}`;

  openVSCodeUri(uri).catch((err) => {
    console.error('Dendro: Failed to open URI:', err);
  });

  return {
    success: true,
    note: VIZ_DISPATCH_NOTE,
    annotationId: `annotation-${Date.now()}`
  };
}

/**
 * Tool: visualize_trace_flow
 * Draw animated flow lines between nodes showing data/prop flow
 *
 * Use cases:
 * - Show how a prop flows from parent to grandchild
 * - Show circular import path
 * - Show context provider to consumer flow
 */
export function visualizeTraceFlow(
  nodes: string[],
  options?: {
    sessionId?: string;
    label?: string;
    color?: string;
    animated?: boolean;
    flowType?: FlowType;
    entryFile?: string;
  }
): VisualizeTraceFlowResult {
  const params = new URLSearchParams();
  params.set('nodes', nodes.join(','));
  if (options?.label) params.set('label', options.label);
  if (options?.color) params.set('color', options.color);
  if (options?.animated !== undefined) params.set('animated', String(options.animated));
  if (options?.flowType) params.set('flowType', options.flowType);
  if (options?.sessionId) params.set('sessionId', options.sessionId);
  if (options?.entryFile) params.set('entryFile', options.entryFile);

  const uri = `${DENDRO_URI_BASE}/trace-flow?${params.toString()}`;

  openVSCodeUri(uri).catch((err) => {
    console.error('Dendro: Failed to open URI:', err);
  });

  return {
    success: true,
    note: VIZ_DISPATCH_NOTE,
    flowId: `flow-${Date.now()}`
  };
}

/**
 * Tool: visualize_clear
 * Clear highlights, annotations, or flows from the visualizer
 */
export function visualizeClear(
  clearType?: ClearType,
  options?: {
    sessionId?: string;
    ids?: string[];
  }
): VisualizeClearResult {
  const params = new URLSearchParams();
  params.set('type', clearType || 'all');
  if (options?.ids) params.set('ids', options.ids.join(','));
  if (options?.sessionId) params.set('sessionId', options.sessionId);

  const uri = `${DENDRO_URI_BASE}/clear?${params.toString()}`;

  openVSCodeUri(uri).catch((err) => {
    console.error('Dendro: Failed to open URI:', err);
  });

  return {
    success: true,
    note: VIZ_DISPATCH_NOTE,
  };
}

/**
 * Tool: visualize_expand
 * Expand a collapsed node in the visualizer
 */
export function visualizeExpand(
  nodeId: string,
  options?: {
    sessionId?: string;
    recursive?: boolean;
  }
): VisualizeExpandResult {
  const params = new URLSearchParams();
  params.set('nodeId', nodeId);
  if (options?.recursive) params.set('recursive', 'true');
  if (options?.sessionId) params.set('sessionId', options.sessionId);

  const uri = `${DENDRO_URI_BASE}/expand?${params.toString()}`;

  openVSCodeUri(uri).catch((err) => {
    console.error('Dendro: Failed to open URI:', err);
  });

  return {
    success: true,
    note: VIZ_DISPATCH_NOTE,
  };
}

/**
 * Tool: visualize_collapse
 * Collapse an expanded node in the visualizer
 */
export function visualizeCollapse(
  nodeId: string,
  options?: {
    sessionId?: string;
  }
): VisualizeCollapseResult {
  const params = new URLSearchParams();
  params.set('nodeId', nodeId);
  if (options?.sessionId) params.set('sessionId', options.sessionId);

  const uri = `${DENDRO_URI_BASE}/collapse?${params.toString()}`;

  openVSCodeUri(uri).catch((err) => {
    console.error('Dendro: Failed to open URI:', err);
  });

  return {
    success: true,
    note: VIZ_DISPATCH_NOTE,
  };
}

/**
 * Tool: visualize_fit_all
 * Zoom the viewport to fit the entire component tree.
 * Natural first call after open_visualizer.
 */
export interface VisualizeFitAllResult {
  success: boolean;
  sessionId?: string;
  note?: string;
  error?: string;
}

export function visualizeFitAll(
  options?: {
    sessionId?: string;
    duration?: number;
    padding?: number;
    entryFile?: string;
  }
): VisualizeFitAllResult {
  const params = new URLSearchParams();
  if (options?.duration !== undefined) params.set('duration', String(options.duration));
  if (options?.padding !== undefined) params.set('padding', String(options.padding));
  if (options?.sessionId) params.set('sessionId', options.sessionId);
  if (options?.entryFile) params.set('entryFile', options.entryFile);

  const uri = `${DENDRO_URI_BASE}/fit-all?${params.toString()}`;

  openVSCodeUri(uri).catch((err) => {
    console.error('Dendro: Failed to open URI:', err);
  });

  return {
    success: true,
    note: VIZ_DISPATCH_NOTE,
  };
}

/**
 * Tool: visualize_batch
 * Execute multiple visualization commands in sequence with proper timing.
 * Eliminates animation races from parallel tool calls.
 */
export interface VisualizeBatchResult {
  success: boolean;
  commandCount: number;
  message: string;
  error?: string;
}

export function visualizeBatch(
  commands: Array<{ type: string; payload?: Record<string, unknown>; label?: string }>,
  options?: {
    sessionId?: string;
    delay?: number;
    entryFile?: string;
    waitForUser?: boolean;
  }
): VisualizeBatchResult {
  if (!commands || commands.length === 0) {
    return {
      success: false,
      commandCount: 0,
      message: 'No commands provided',
      error: 'commands array is empty'
    };
  }

  const params = new URLSearchParams();
  params.set('commands', JSON.stringify(commands));
  if (options?.delay !== undefined) params.set('delay', String(options.delay));
  if (options?.waitForUser) params.set('waitForUser', 'true');
  if (options?.sessionId) params.set('sessionId', options.sessionId);
  if (options?.entryFile) params.set('entryFile', options.entryFile);

  const uri = `${DENDRO_URI_BASE}/batch?${params.toString()}`;

  openVSCodeUri(uri).catch((err) => {
    console.error('Dendro: Failed to open URI:', err);
  });

  const mode = options?.waitForUser ? 'manual advance (Next button)' : 'sequential execution';
  return {
    success: true,
    commandCount: commands.length,
    message: `Queued ${commands.length} commands for ${mode}`
  };
}

/**
 * Tool: start_tour
 * Start an interactive guided tour of the component tree visualization.
 * The LLM builds tour configs dynamically from analysis results.
 */
export interface StartTourResult {
  success: boolean;
  stepCount: number;
  message: string;
  note?: string;
  error?: string;
}

export function startTour(
  entryFile: string,
  tourConfig: {
    title: string;
    steps: Array<{
      title: string;
      description: string;
      commands: Array<{ type: string; payload?: Record<string, unknown> }>;
      autoAdvanceMs?: number;
    }>;
    autoPlay?: boolean;
    clearOnExit?: boolean;
  }
): StartTourResult {
  if (!tourConfig || !tourConfig.steps || tourConfig.steps.length === 0) {
    return {
      success: false,
      stepCount: 0,
      message: 'No tour steps provided',
      error: 'tour.steps array is empty'
    };
  }

  // Validate path boundary before sending to VS Code
  assertPathInWorkspace(entryFile, 'entryFile');

  // Write tour config to temp file (avoids URI length limits)
  const { writeTourConfig } = require('../runtime/tour-bridge');
  writeTourConfig(tourConfig);

  // Fire URI to signal extension
  const params = new URLSearchParams();
  params.set('entryFile', entryFile);

  const uri = `${DENDRO_URI_BASE}/start-tour?${params.toString()}`;

  openVSCodeUri(uri).catch((err: Error) => {
    console.error('Dendro: Failed to open tour URI:', err);
  });

  return {
    success: true,
    note: VIZ_DISPATCH_NOTE,
    stepCount: tourConfig.steps.length,
    message: `Started tour "${tourConfig.title}" with ${tourConfig.steps.length} steps`
  };
}

/**
 * Returns a structured usage guide for agents encountering Dendro for the first time.
 * Static data — no computation, no parameters.
 */

/**
 * Tool: submit_feedback
 * Sends an agent-written feedback debrief to the Dendro feedback service —
 * the ONLY tool that transmits anything off-machine, which is why consent is
 * a hard precondition enforced both in the tool description and here.
 *
 * What leaves the machine: exactly the fields passed in, plus server version,
 * platform, and per-tool call/error COUNTS (tool names only — no error text,
 * no file paths, no code).
 */
const FEEDBACK_ENDPOINT =
  process.env.DENDRO_FEEDBACK_URL || 'https://dendro-feedback.captaincolinr.workers.dev/v1/feedback';

export interface SubmitFeedbackResult {
  success: boolean;
  message: string;
  error?: string;
}

export async function submitFeedback(input: {
  userConsented: boolean;
  summary: string;
  fumbles?: string[];
  hooks?: string[];
  wouldReuseUnprompted?: boolean;
  contact?: string;
}): Promise<SubmitFeedbackResult> {
  if (input.userConsented !== true) {
    return {
      success: false,
      message: '',
      error:
        'Not sent: userConsented must be true, and only after the user has explicitly agreed in this conversation to submit feedback. Ask them first.',
    };
  }
  if (!input.summary || input.summary.trim().length < 10) {
    return { success: false, message: '', error: 'Not sent: summary must be at least 10 characters.' };
  }

  // Per-tool call/error counts only — deliberately no lastError strings
  // (they can embed local file paths).
  const stats = getUsageStats();
  const toolCounts: Record<string, { calls: number; errors: number }> = {};
  for (const [name, t] of Object.entries(stats.tools || {})) {
    toolCounts[name] = { calls: t.count || 0, errors: t.errorCount || 0 };
  }

  const payload = {
    summary: input.summary.slice(0, 2000),
    fumbles: (input.fumbles || []).slice(0, 20).map((s) => String(s).slice(0, 500)),
    hooks: (input.hooks || []).slice(0, 20).map((s) => String(s).slice(0, 500)),
    wouldReuseUnprompted: input.wouldReuseUnprompted,
    contact: input.contact ? String(input.contact).slice(0, 200) : undefined,
    serverVersion: getBuildInfo().version,
    platform: process.platform,
    toolCounts,
  };

  try {
    const res = await fetch(FEEDBACK_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string };
    if (!res.ok) {
      return { success: false, message: '', error: `Feedback service returned ${res.status}: ${body.error || 'unknown'}` };
    }
    return { success: true, message: body.message || 'Feedback received — thank you.' };
  } catch (err) {
    return {
      success: false,
      message: '',
      error: `Could not reach the feedback service (offline?): ${err instanceof Error ? err.message : String(err)}. Feedback was NOT sent; the user can also file it at https://github.com/RooneyTech/dendro-feedback.`,
    };
  }
}

export function getUsageGuide() {
  return {
    // Identifies WHICH build is answering. If buildTime predates a recompile
    // you just made, this server is stale — restart the MCP client to load
    // the new code (recompiles never hot-swap into a running session).
    build: (() => {
      const b = getBuildInfo();
      const ext = readExtensionInfo();
      return {
        ...b,
        extension: ext
          ? {
              id: ext.extensionId,
              version: ext.version,
              versionSkew: !!ext.version && ext.version !== b.version,
              ...(!!ext.version && ext.version !== b.version
                ? {
                    versionSkewNote:
                      'The MCP server and VS Code extension are different versions. Analysis tools are unaffected; visualizer and runtime tools may behave per the older side. Safe to proceed — mention it to the user only if a viz/runtime tool misbehaves; updating the extension and restarting the MCP client resolves it.',
                  }
                : {}),
            }
          : null,
      };
    })(),

    overview: 'Dendro is an MCP server + VS Code extension that gives AI agents deep visibility into React and React Native codebases through 36 tools for static analysis, interactive visualization, runtime inspection, verified state flow projection, and persona-driven workflow analysis.',

    quick_start: 'RECOMMENDED: Start with composite tools for the best experience. Call analyze_codebase for a full codebase overview in one call, or quick_audit for a fast health check. For visualization, call visualize_analysis to open the visualizer with auto-highlighting. These composite tools wrap 4-5 granular tools each. For finer control, use the individual tools below.',

    categories: {
      feedback: {
        description: 'submit_feedback — send an honest debrief (fumbles + hooks) to the maker. ONLY with the user\'s explicit consent; the one tool that sends data off-machine (no code, no paths). Offer it warmly when tools errored this session or the user expresses an opinion about Dendro — feedback directly shapes what gets fixed.',
      },
      composite: {
        description: 'RECOMMENDED — High-level tools that combine multiple analyses into a single call. Start here for the best agent experience.',
        tools: [
          { name: 'get_context_pack', purpose: 'Whole-repo orientation as one dense self-describing text block (~200-400 tokens) — dir rollups, hot files, import edges, entry points. Call FIRST in a new repo.' },
          { name: 'get_component_contract', purpose: 'Everything needed BEFORE editing a component in one call — props, state, contexts, blast radius, complexity, risks. Resolves by component NAME workspace-wide.' },
          { name: 'get_modified_components', purpose: 'What changed vs a git ref (HEAD or base:"main"), as components. Pair with get_component_contract for the review/test loop.' },
          { name: 'analyze_codebase', purpose: 'Full codebase analysis in one call — tree + complexity + context + circular deps. Start here.' },
          { name: 'quick_audit', purpose: 'Fast health check — top 5 complex components, circular deps, prop drilling, health grade A-F' },
          { name: 'visualize_analysis', purpose: 'Open visualizer + auto-highlight analysis results. One call instead of 5+ viz commands.' }
        ]
      },
      analysis: {
        description: 'Granular static analysis of React/React Native codebases. Use when you need finer control than composite tools. Works anywhere — no VS Code required.',
        tools: [
          { name: 'get_component_tree', purpose: 'Full component hierarchy from a root file' },
          { name: 'get_component_details', purpose: 'Detailed info about a single component file' },
          { name: 'get_component_contract', purpose: 'Resolve a component by NAME and get its full pre-edit contract' },
          { name: 'detect_circular_deps', purpose: 'Find circular import dependencies' },
          { name: 'get_used_by', purpose: 'Reverse dependency graph — who imports this component?' },
          { name: 'get_prop_flow', purpose: 'Trace how a prop flows through the component tree' },
          { name: 'get_hook_deps', purpose: 'Analyze hook dependency arrays (useEffect, useMemo, etc.)' },
          { name: 'get_navigation_structure', purpose: 'Parse routing structure — React Navigation (RN), Next.js App Router, React Router, Remix' },
          { name: 'get_context_map', purpose: 'Map Context providers to their consumers' },
          { name: 'get_screen_components', purpose: 'Map screens to the components they use' },
          { name: 'get_complexity_report', purpose: 'Complexity scores (1-10) for refactoring candidates' },
          { name: 'get_rerender_risks', purpose: 'Detect re-render anti-patterns: inline objects/functions, missing useCallback/useMemo' }
        ]
      },
      visualization: {
        description: 'Interactive D3 neural visualization in VS Code. Requires the Dendro VS Code extension.',
        tools: [
          { name: 'open_visualizer', purpose: 'Open the webview — MUST call before other viz tools' },
          { name: 'visualize_batch', purpose: 'ALL visual operations go through here as command steps: highlight, zoom, annotate, traceFlow, clear, expand, collapse, fitAll. Use waitForUser: true with a label per step — eliminates animation races.' }
          // start_tour shelved — see .dev/bugs/TOUR-BUG-REPORT.md
        ]
      },
      runtime: {
        description: 'Live connection to a running React Native app via React DevTools protocol on port 8097. User must run "Dendro: Connect to Running App" (Cmd+Shift+P) first — autoStartRuntime defaults to false to avoid port conflicts with Expo/Metro which also use 8097. If EADDRINUSE occurs, quit Expo DevTools first or set dendro.runtimePort to a different port.',
        tools: [
          { name: 'get_runtime_status', purpose: 'Check connection status — call before other runtime tools. Returns setup instructions and troubleshooting if disconnected.' },
          { name: 'get_live_tree', purpose: 'Get the live component tree as currently rendered' },
          { name: 'get_runtime_state', purpose: 'Find a component in the live tree with its details' }
        ]
      },
      export: {
        description: 'Export analysis results in various formats. Pro feature.',
        tools: [
          { name: 'export_analysis', purpose: 'Export as mermaid, json, svg, or markdown (persona-aware reports) via the format parameter' }
        ]
      },
      pro_analysis: {
        description: 'Advanced analysis and snapshot tracking. Pro feature.',
        tools: [
          { name: 'batch_analysis', purpose: 'Run multiple analyses across multiple entry files' },
          { name: 'manage_snapshots', purpose: 'Save/list/compare analysis snapshots via the action parameter — save before a refactor, compare vs "current" after' }
        ]
      },
      verified_projection: {
        description: 'Generate and verify state flow hypotheses with auto-generated Jest tests. Pro feature.',
        tools: [
          { name: 'verify_state_flows', purpose: 'Full Verified Projection pipeline in one call (hypotheses → Jest tests → run → annotate); stopAfter to inspect intermediates' }
        ]
      },
      triggered_projection: {
        description: 'Observe runtime changes and project downstream data flow effects. Pro feature.',
        tools: [
          { name: 'trigger_projection', purpose: 'Capture runtime snapshot, diff against previous, project and animate downstream effects' }
        ]
      },
      live_introspection: {
        description: 'Deep inspect and modify running components at runtime. Pro feature.',
        tools: [
          { name: 'inspect_live_component', purpose: 'Deep inspect a component\'s props, state, hooks, context' },

          { name: 'find_state_owner', purpose: 'Find which component owns a given state variable' },
          { name: 'modify_runtime_state', purpose: 'Modify props/state/hooks/context at runtime' },

          { name: 'trace_live_prop', purpose: 'Trace live prop changes through the component tree' },
          { name: 'get_live_navigation', purpose: 'Get live navigation state (mounted vs defined screens)' }
        ]
      },
      workflow_tools: {
        description: 'Persona-driven analysis workflows. Each tool returns step-by-step instructions — follow them in order, do not parallelize.',
        tools: [
          { name: 'run_workflow', purpose: 'Persona playbooks via the persona parameter: audit (developers), sprint_check (eng managers), ceo_briefing (non-technical), investor_scorecard (due diligence), dev_onboarding (new team members)' }
        ]
      }
    },

    workflows: [
      {
        name: 'Understand a codebase (recommended)',
        description: 'Get a comprehensive overview of a React codebase structure. One call.',
        steps: [
          'analyze_codebase — pass the root App file (e.g., App.tsx) to get tree + complexity + context + circular deps in one call'
        ],
        alternative: 'For granular control, call get_component_tree, get_complexity_report, get_context_map, and detect_circular_deps individually.'
      },
      {
        name: 'Quick health check (recommended)',
        description: 'Fast assessment of codebase health with actionable findings.',
        steps: [
          'quick_audit — pass the src directory to get top issues, health grade, and specific recommendations'
        ]
      },
      {
        name: 'Visualize analysis (recommended)',
        description: 'Open visualization with auto-highlighted analysis results. One call.',
        steps: [
          'visualize_analysis — pass entry file and optional focus ("complexity", "deps", "context", or "all")'
        ],
        alternative: 'For granular control, call open_visualizer first, then one visualize_batch call whose commands array holds exactly the steps you need.'
      },
      {
        name: 'Understand a codebase (granular)',
        description: 'Step-by-step codebase overview using individual tools.',
        steps: [
          'get_component_tree — pass the root App file (e.g., App.tsx) to get the full hierarchy',
          'get_complexity_report — identify components that may need refactoring (score > 6)',
          'get_context_map — understand how state flows via Context providers/consumers',
          'get_navigation_structure — map out the routing/navigation hierarchy (React Navigation, Next.js, React Router, Remix)'
        ]
      },
      {
        name: 'Visualize a component tree (granular)',
        description: 'Step-by-step visualization with individual tool calls.',
        steps: [
          'open_visualizer — pass the entry file to open the webview (MUST call first)',
          'visualize_batch — one call: highlight steps (green=entry, blue=interest, red=problem), a zoom step, then annotate steps'
        ]
      },
      {
        name: 'Find and visualize circular dependencies',
        description: 'Detect import cycles and show them visually.',
        steps: [
          'detect_circular_deps — pass the src directory to find all cycles',
          'open_visualizer — open visualization for the entry file',
          'visualize_batch — one call: highlight cycle participants (red, pulse: true), annotate each node with its role, traceFlow along the circular path'
        ]
      },
      {
        name: 'Trace data flow',
        description: 'Understand how data moves through the component tree.',
        steps: [
          'get_prop_flow — trace a specific prop from a source component through its children',
          'get_context_map — map Context providers to consumers for broadcast state',
          'open_visualizer — open visualization',
          'visualize_batch — traceFlow steps (flowType: "prop" for props, "context" for context, "state" for hooks)'
        ]
      },
      {
        name: 'Complexity audit',
        description: 'Find overly complex components and highlight them for refactoring.',
        steps: [
          'get_complexity_report — get scores for all components (threshold: 5 for moderate, 7 for high)',
          'open_visualizer — open visualization for the entry file',
          'visualize_batch — highlight high-complexity nodes (red/orange) and annotate scores, one call'
        ]
      },
      {
        name: 'Performance audit',
        description: 'Find re-render anti-patterns and highlight risky components.',
        steps: [
          'get_rerender_risks — scan for inline objects/functions, missing useCallback/useMemo',
          'open_visualizer — open visualization for the entry file',
          'visualize_batch — highlight risky components (orange) and annotate risk counts, one call'
        ],
        alternative: 'Use visualize_analysis with focus: "performance" for a one-call version.'
      },
      {
        name: 'Impact analysis',
        description: 'Understand the blast radius before changing a component.',
        steps: [
          'get_used_by — find all components that import the target component',
          'get_prop_flow — trace how the component\'s props are consumed downstream',
          'get_component_details — inspect the component itself for state, hooks, imports'
        ]
      },
      {
        name: 'Runtime inspection',
        description: 'Connect to a running React Native app and inspect live state.',
        steps: [
          'get_runtime_status — verify the app is connected (if not, follow the connection instructions)',
          'get_live_tree — get the live component tree as currently rendered',
          'inspect_live_component — deep inspect a specific component\'s props, state, hooks',
          'modify_runtime_state — modify a live state value to test behavior'
        ]
      },
      {
        name: 'Batch visualization (prevents animation races)',
        description: 'Send multiple viz commands in one call with proper sequencing.',
        steps: [
          'open_visualizer — open the webview first',
          'visualize_batch — pass an array of commands: [{type: "clear"}, {type: "highlight", payload: {nodes: [...], color: "red"}}, {type: "fitAll"}, {type: "annotate", payload: {nodeId: "...", text: "..."}}]'
        ],
        alternative: 'There are no per-step viz tools — visualize_batch is the only path; include a {type: "clear"} step to reset between sequences.'
      },
      // Guided tour workflow shelved — see .dev/bugs/TOUR-BUG-REPORT.md (D3/React DOM conflict)
      // Re-enable when Bug 3 (removeChild) is resolved.
    ],

    sequencing_rules: [
      'ALWAYS call open_visualizer (or pass an entryFile param) before visualize_batch — and call it ONCE; repeat calls create new panels.',
      'ALL visualization goes through visualize_batch — one call, an array of commands with a label each; waitForUser: true gives the user Back/Next/Skip pacing.',
      'ALWAYS call get_runtime_status before using get_live_tree, get_runtime_state, or any live introspection tools. If the app is not connected, the status response includes connection instructions.',
      'For visualization workflows: open_visualizer ONCE, then a single visualize_batch whose command steps typically run fitAll → highlight → zoom → annotate → traceFlow.',
      'Start a fresh sequence with a {type: "clear"} command at the head of the next visualize_batch to remove previous highlights and annotations.',
      'Analysis tools (get_component_tree, get_complexity_report, etc.) can be called in parallel — they are independent and stateless.'
    ],

    parameter_tips: {
      colors: {
        red: 'Problems, errors, circular dependencies, high complexity, failed verifications',
        orange: 'Warnings, moderate complexity, components needing attention',
        yellow: 'Informational highlights, search results',
        green: 'Entry points, healthy components, verified flows',
        blue: 'Components of interest, selected items, prop flow paths',
        purple: 'Context flow paths, mixed verification results'
      },
      highlight_options: {
        pulse: 'Set pulse: true to draw attention with animation. Use sparingly — best for 1-3 critical nodes.',
        duration: 'Set duration in ms for temporary highlights (0 = permanent). Default is permanent.',
        label: 'Add a label string to display text below highlighted nodes.'
      },
      flow_types: {
        prop: 'Solid line — direct prop passing between parent and child',
        context: 'Dashed line — Context provider broadcasting to consumers',
        state: 'Dotted line — hook-based state relationships',
        event: 'Event callbacks and handlers'
      },
      complexity_thresholds: {
        low: '1-3: Simple components, no refactoring needed',
        moderate: '4-6: Some complexity, review if modifying',
        high: '7-10: Refactoring candidates, consider splitting'
      },
      entry_file: 'The entry file should be the root component (usually App.tsx, App.jsx, or src/App.tsx). For monorepos, use the specific app\'s entry point.'
    },

    common_mistakes: [
      { mistake: 'Calling visualization tools without opening the visualizer first', fix: 'Always call open_visualizer before any visualize_* tools, or pass the entryFile parameter to auto-open.' },
      { mistake: 'Passing a directory path to get_component_tree instead of a file path', fix: 'get_component_tree requires an absolute path to a specific file (e.g., /path/to/App.tsx), not a directory.' },
      { mistake: 'Batching multiple viz tool calls in parallel', fix: 'Visualization commands must be sequential. Each command modifies the webview state that the next command depends on.' },
      { mistake: 'Using runtime/live introspection tools without checking connection status', fix: 'Call get_runtime_status first. If disconnected, guide the user through connection setup.' },
      { mistake: 'Using relative paths instead of absolute paths', fix: 'All file/directory parameters require absolute paths (e.g., /Users/name/project/src/App.tsx).' },
      { mistake: 'Forgetting to call visualize_clear between different visualization sequences', fix: 'Call visualize_clear before starting a new visualization to avoid overlapping highlights and annotations.' }
    ]
  };
}

// ============================================================================
// Composite Agent Tools (TICKET-042)
// ============================================================================
// These tools wrap multiple granular tools into single-call workflows.
// They reduce the 44-tool decision surface for agents and testers.

export interface AnalyzeCodebaseResult {
  tree: GetComponentTreeResult;
  complexity: GetComplexityReportResult;
  context: GetContextMapResult;
  circularDeps: DetectCircularDepsResult;
  summary: {
    totalComponents: number;
    maxDepth: number;
    complexityAverage: number;
    highComplexityCount: number;
    totalContexts: number;
    totalConsumers: number;
    hasCircularDeps: boolean;
    circularDepCount: number;
  };
  errors: string[];
}

/**
 * Composite Tool: analyze_codebase
 * Single entry point for "understand this codebase." Runs:
 * - get_component_tree → full hierarchy
 * - get_complexity_report → refactoring candidates
 * - get_context_map → state management overview
 * - detect_circular_deps → import health
 *
 * Returns a combined report with a summary section. One call instead of four.
 * Handles partial failures gracefully — if one sub-tool fails, the rest still return.
 */
export function analyzeCodebase(entryFile: string, rootPath?: string): AnalyzeCodebaseResult {
  const errors: string[] = [];
  // Validate paths before delegating to sub-tools
  const validatedEntry = assertPathInWorkspace(entryFile, 'entryFile');
  const resolvedRootPath = rootPath
    ? assertPathInWorkspace(rootPath, 'rootPath')
    : path.dirname(validatedEntry);

  // Run all four analyses — each handles its own errors
  const tree = getComponentTree(entryFile);
  if (tree.error) errors.push(`tree: ${tree.error}`);

  const complexity = getComplexityReport(resolvedRootPath);
  if (complexity.error) errors.push(`complexity: ${complexity.error}`);

  const context = getContextMap(resolvedRootPath);
  if (context.error) errors.push(`context: ${context.error}`);

  const circularDeps = detectCircularDeps(resolvedRootPath);
  if (circularDeps.error) errors.push(`circularDeps: ${circularDeps.error}`);

  return {
    tree,
    complexity,
    context,
    circularDeps,
    summary: {
      totalComponents: tree.stats.totalComponents,
      maxDepth: tree.stats.maxDepth,
      complexityAverage: complexity.summary.average,
      highComplexityCount: complexity.summary.high,
      totalContexts: context.totalContexts,
      totalConsumers: context.totalConsumers,
      hasCircularDeps: circularDeps.hasCircularDeps,
      circularDepCount: circularDeps.circularDependencies.length,
    },
    errors,
  };
}

export interface QuickAuditResult {
  topComplexComponents: Array<{
    file: string;
    componentName: string | null;
    score: number;
    rating: string;
    propsCount: number;
    stateCount: number;
    effectCount: number;
  }>;
  circularDeps: {
    found: boolean;
    count: number;
    cycles: CircularDep[];
  };
  propDrillingCandidates: Array<{
    file: string;
    componentName: string | null;
    propsCount: number;
  }>;
  heavyContextProviders: Array<{
    contextName: string;
    consumerCount: number;
    providerFile?: string;
  }>;
  rerenderRisks: {
    totalRisks: number;
    highSeverityCount: number;
    topFiles: Array<{ file: string; riskCount: number }>;
  };
  healthSummary: {
    grade: 'A' | 'B' | 'C' | 'D' | 'F';
    score: number;
    totalComponents: number;
    issues: string[];
  };
  /** Effect bug families (informational — does not affect the grade). */
  effectHygiene?: {
    findings: EffectFinding[];
    byRule: Record<string, number>;
    note?: string;
  };
  /** Files nothing imports (static + string-literal dynamic imports, aliases included). */
  deadCode?: {
    unusedFiles: DeadFile[];
    unusedCount: number;
    note: string;
  };
  /** Known-issues baseline (dependency-cruiser style): gate on NEW findings only. */
  baseline?: {
    mode: 'compared' | 'updated' | 'none';
    baselinePath: string;
    knownSuppressed: number;
    newIssues: string[];
    note: string;
  };
  errors: string[];
}

/**
 * Composite Tool: quick_audit
 * Targeted health check for a React codebase. Returns:
 * - Top 5 most complex components
 * - Any circular dependencies
 * - Components with 5+ props (prop drilling candidates)
 * - Context providers with 10+ consumers
 * - Overall health grade (A-F)
 *
 * Designed for "give me a quick health check" requests.
 */
export function quickAudit(rootPath: string, baselineMode: 'compare' | 'update' | 'off' = 'compare'): QuickAuditResult {
  const errors: string[] = [];

  // Complexity analysis
  const complexity = getComplexityReport(rootPath);
  if (complexity.error) errors.push(`complexity: ${complexity.error}`);

  const topComplexComponents = complexity.components
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(c => ({
      file: c.file,
      componentName: c.componentName,
      score: c.score,
      rating: c.rating,
      propsCount: c.metrics.propsCount,
      stateCount: c.metrics.stateCount,
      effectCount: c.metrics.effectCount,
    }));

  // Circular dependencies
  const circularDepsResult = detectCircularDeps(rootPath);
  if (circularDepsResult.error) errors.push(`circularDeps: ${circularDepsResult.error}`);

  // Prop drilling candidates (5+ props)
  const propDrillingCandidates = complexity.components
    .filter(c => c.metrics.propsCount >= 5)
    .sort((a, b) => b.metrics.propsCount - a.metrics.propsCount)
    .map(c => ({
      file: c.file,
      componentName: c.componentName,
      propsCount: c.metrics.propsCount,
    }));

  // Context analysis for heavy providers
  const contextResult = getContextMap(rootPath);
  if (contextResult.error) errors.push(`context: ${contextResult.error}`);

  const heavyContextProviders: QuickAuditResult['heavyContextProviders'] = [];
  for (const ctx of contextResult.contexts) {
    const customHook = contextResult.customHooks.find(h => h.contextName === ctx.name);
    const consumers = contextResult.consumers.filter(
      c => c.contextName === ctx.name || (customHook && c.hookName === customHook.hookName)
    );
    if (consumers.length >= 10) {
      const provider = contextResult.providers.find(p => p.contextName === ctx.name);
      heavyContextProviders.push({
        contextName: ctx.name,
        consumerCount: consumers.length,
        providerFile: provider?.filePath,
      });
    }
  }

  // Re-render risk analysis
  const risksResult = getRerenderRisks(rootPath);
  if (risksResult.error) errors.push(`rerenderRisks: ${risksResult.error}`);

  const rerenderRisks = {
    totalRisks: risksResult.summary.totalRisks,
    highSeverityCount: risksResult.summary.bySeverity.high,
    topFiles: risksResult.summary.topOffenders.map(o => ({ file: o.file, riskCount: o.riskCount })),
  };

  // Calculate health grade using density-based thresholds + weighted scoring.
  // See TICKET-052 for calibration data across 6 reference codebases.
  const totalComponents = complexity.summary.totalComponents || 1;
  const issues: string[] = [];
  let score = 0;

  // High complexity: flag if >8% density OR >8 absolute
  const highComplexity = complexity.summary.high;
  const complexityDensity = highComplexity / totalComponents;
  if (complexityDensity > 0.08 || highComplexity > 8) {
    score += 1;
    issues.push(`${highComplexity} high-complexity component${highComplexity > 1 ? 's' : ''} (${(complexityDensity * 100).toFixed(0)}% of ${totalComponents})`);
  }

  // Circular deps: always flag, weight scales with severity
  const circCount = circularDepsResult.circularDependencies.length;
  if (circularDepsResult.hasCircularDeps) {
    const circWeight = circCount >= 10 ? 3 : circCount >= 3 ? 2 : 1.5;
    score += circWeight;
    issues.push(`${circCount} circular dependency cycle${circCount > 1 ? 's' : ''}`);
  }

  // Prop drilling: flag if >8% density (skip for tiny codebases <10 components)
  const propDrillingDensity = propDrillingCandidates.length / totalComponents;
  if (totalComponents >= 10 && propDrillingDensity > 0.08) {
    score += 1;
    issues.push(`${propDrillingCandidates.length} component${propDrillingCandidates.length > 1 ? 's' : ''} with 5+ props (${(propDrillingDensity * 100).toFixed(0)}% of ${totalComponents})`);
  }

  // Heavy context: flag if >3 providers with 10+ consumers
  if (heavyContextProviders.length > 3) {
    score += 1;
    issues.push(`${heavyContextProviders.length} context providers with 10+ consumers`);
  }

  // High rerender risks: flag if ≥2 high AND (>3% density OR >8 absolute)
  const highRerender = rerenderRisks.highSeverityCount;
  const rerenderDensity = highRerender / totalComponents;
  if (highRerender >= 2 && (rerenderDensity > 0.03 || highRerender > 8)) {
    score += 1;
    issues.push(`${highRerender} high-severity re-render risk${highRerender > 1 ? 's' : ''} (${(rerenderDensity * 100).toFixed(0)}% of ${totalComponents})`);
  }

  // Grade from weighted score
  let grade: QuickAuditResult['healthSummary']['grade'];
  if (score === 0) {
    grade = 'A';
  } else if (score <= 2) {
    grade = 'B';
  } else if (score <= 4.5) {
    grade = 'C';
  } else if (score <= 7) {
    grade = 'D';
  } else {
    grade = 'F';
  }

  // Effect hygiene — real-bug families (leaked subscriptions, derived state
  // via effects). Informational: reported, never graded, so scores stay
  // comparable across versions.
  const hygiene = parseEffectHygiene(rootPath);
  const effectHygiene = {
    findings: hygiene.findings.slice(0, 20),
    byRule: hygiene.summary.byRule as Record<string, number>,
    note: hygiene.findings.length > 20 ? `Showing 20 of ${hygiene.findings.length} findings.` : undefined,
  };

  // Dead code — unused files (informational, not graded)
  const dead = parseDeadCode(rootPath);
  const deadCode = {
    unusedFiles: dead.unusedFiles.slice(0, 25),
    unusedCount: dead.summary.unusedCount,
    note: dead.summary.unusedCount > 25 ? `Showing 25 of ${dead.summary.unusedCount}. ${dead.note}` : dead.note,
  };

  // Baseline (known-issues) support — lets teams gate on "no NEW findings"
  // instead of paying down the whole backlog before adopting the audit.
  const issueKeys = [
    ...issues.map(i => `issue:${i}`),
    ...circularDepsResult.circularDependencies.map(c => `cycle:${c.description}`),
    ...hygiene.findings.map(f => `${f.rule}:${f.file}:${f.evidence}`),
    ...dead.unusedFiles.map(f => `unused-file:${f.file}`),
  ];
  const baselinePath = path.join(path.resolve(rootPath), '.dendro', 'audit-baseline.json');
  let baseline: QuickAuditResult['baseline'];
  if (baselineMode === 'update') {
    try {
      fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
      fs.writeFileSync(baselinePath, JSON.stringify({ updatedAt: new Date().toISOString(), known: issueKeys }, null, 2));
      baseline = { mode: 'updated', baselinePath, knownSuppressed: 0, newIssues: [], note: `Baseline written with ${issueKeys.length} known issue(s). Future audits report only NEW findings relative to it.` };
    } catch (err) {
      errors.push(`baseline: could not write ${baselinePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else if (baselineMode !== 'off' && fs.existsSync(baselinePath)) {
    try {
      const known = new Set<string>((JSON.parse(fs.readFileSync(baselinePath, 'utf-8')) as { known?: string[] }).known ?? []);
      const newIssues = issueKeys.filter(k => !known.has(k));
      baseline = {
        mode: 'compared', baselinePath,
        knownSuppressed: issueKeys.length - newIssues.length,
        newIssues,
        note: newIssues.length === 0
          ? `No NEW issues vs the baseline (${issueKeys.length - newIssues.length} known issue(s) suppressed).`
          : `${newIssues.length} NEW issue(s) since the baseline — these are the ones to act on; ${issueKeys.length - newIssues.length} known issue(s) suppressed.`,
      };
    } catch (err) {
      errors.push(`baseline: could not read ${baselinePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    topComplexComponents,
    circularDeps: {
      found: circularDepsResult.hasCircularDeps,
      count: circularDepsResult.circularDependencies.length,
      cycles: circularDepsResult.circularDependencies,
    },
    propDrillingCandidates,
    heavyContextProviders,
    rerenderRisks,
    healthSummary: { grade, score, totalComponents, issues },
    effectHygiene,
    deadCode,
    baseline,
    errors,
  };
}

export type AnalysisFocus = 'complexity' | 'deps' | 'context' | 'performance' | 'all';

export interface VisualizeAnalysisResult {
  visualizer: OpenVisualizerResult;
  analysisPerformed: AnalysisFocus;
  highlightedNodes: string[];
  annotatedNodes: string[];
  errors: string[];
}

/**
 * Composite Tool: visualize_analysis
 * Opens the visualizer and auto-highlights based on analysis focus:
 * - "complexity": highlights high-complexity nodes (red) and annotates scores
 * - "deps": highlights circular dependency participants (red with pulse)
 * - "context": highlights context providers (purple) and traces flow
 * - "all": runs all three focuses
 *
 * One call instead of 5+ sequential viz calls. Requires VS Code extension.
 */
export async function visualizeAnalysis(
  entryFile: string,
  focus?: AnalysisFocus
): Promise<VisualizeAnalysisResult> {
  const errors: string[] = [];
  const highlightedNodes: string[] = [];
  const annotatedNodes: string[] = [];
  const resolvedFocus = focus || 'all';
  const validatedEntry = assertPathInWorkspace(entryFile, 'entryFile');
  const rootPath = path.dirname(validatedEntry);

  // Step 1: Open the visualizer
  const vizResult = await openVisualizer(entryFile);
  if (!vizResult.success) {
    return {
      visualizer: vizResult,
      analysisPerformed: resolvedFocus,
      highlightedNodes: [],
      annotatedNodes: [],
      errors: [`Failed to open visualizer: ${vizResult.message}`],
    };
  }

  // Step 2: Run analyses and highlight based on focus
  if (resolvedFocus === 'complexity' || resolvedFocus === 'all') {
    try {
      const complexity = getComplexityReport(rootPath, 5);
      const highNodes = complexity.components
        .filter(c => c.rating === 'high')
        .map(c => path.basename(c.file, path.extname(c.file)));
      const medNodes = complexity.components
        .filter(c => c.rating === 'medium')
        .map(c => path.basename(c.file, path.extname(c.file)));

      if (highNodes.length > 0) {
        visualizeHighlight(highNodes, 'red', {
          label: 'High Complexity',
          pulse: true,
          entryFile,
        });
        highlightedNodes.push(...highNodes);
      }
      if (medNodes.length > 0) {
        visualizeHighlight(medNodes, 'orange', {
          label: 'Medium Complexity',
          entryFile,
        });
        highlightedNodes.push(...medNodes);
      }

      // Annotate top 3 complex components with scores
      const top3 = complexity.components
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);
      for (const comp of top3) {
        const nodeName = path.basename(comp.file, path.extname(comp.file));
        visualizeAnnotate(nodeName, `Score: ${comp.score}`, {
          style: 'badge',
          color: comp.rating === 'high' ? 'red' : 'orange',
          entryFile,
        });
        annotatedNodes.push(nodeName);
      }
    } catch (err) {
      errors.push(`complexity visualization: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (resolvedFocus === 'deps' || resolvedFocus === 'all') {
    try {
      const deps = detectCircularDeps(rootPath);
      if (deps.hasCircularDeps) {
        const cycleNodes = new Set<string>();
        for (const dep of deps.circularDependencies) {
          for (const file of dep.cycle) {
            cycleNodes.add(path.basename(file, path.extname(file)));
          }
        }
        const nodeList = Array.from(cycleNodes);
        if (nodeList.length > 0) {
          visualizeHighlight(nodeList, 'red', {
            label: 'Circular Dep',
            pulse: true,
            entryFile,
          });
          highlightedNodes.push(...nodeList);
        }
      }
    } catch (err) {
      errors.push(`dependency visualization: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (resolvedFocus === 'context' || resolvedFocus === 'all') {
    try {
      const ctx = getContextMap(rootPath);
      const providerNodes = ctx.providers.map(p =>
        path.basename(p.filePath, path.extname(p.filePath))
      );
      if (providerNodes.length > 0) {
        visualizeHighlight(providerNodes, 'purple', {
          label: 'Context Provider',
          entryFile,
        });
        highlightedNodes.push(...providerNodes);
      }
    } catch (err) {
      errors.push(`context visualization: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (resolvedFocus === 'performance' || resolvedFocus === 'all') {
    try {
      const risks = getRerenderRisks(rootPath);
      const riskyFiles = risks.files.filter(f => f.riskCount > 0);
      const riskyNodes = riskyFiles
        .map(f => path.basename(f.file, path.extname(f.file)));
      if (riskyNodes.length > 0) {
        visualizeHighlight(riskyNodes, 'orange', {
          label: 'Re-render Risk',
          entryFile,
        });
        highlightedNodes.push(...riskyNodes);
      }
    } catch (err) {
      errors.push(`performance visualization: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Step 3: Zoom to highlighted nodes
  if (highlightedNodes.length > 0) {
    visualizeZoom(highlightedNodes, { entryFile });
  }

  return {
    visualizer: vizResult,
    analysisPerformed: resolvedFocus,
    highlightedNodes,
    annotatedNodes,
    errors,
  };
}

// Export tool types and functions
export { ExportMermaidResult, exportMermaid } from './exporters/mermaid-exporter';
export { ExportJsonResult, exportJson } from './exporters/json-exporter';


// ============================================================================
// Tool: get_component_contract — the one-call pre-edit contract
// ============================================================================

export interface ComponentContractResult {
  component: string;
  file: string | null;
  absolutePath: string | null;
  /** Other files declaring a same-named component, when the name is ambiguous. */
  candidates?: Array<{ file: string }>;
  kind: 'functional' | 'class' | null;
  directive: 'use client' | 'use server' | null;
  /** Prop names, with where they came from: the TS type (authoritative) or destructuring (fallback). */
  props: { names: string[]; source: 'type' | 'destructuring' | 'none'; typeText?: string | null; inheritsFrom?: string[] };
  state: string[];
  hooks: { total: number; issueCount: number; contextsRead: string[]; refs: string[] };
  /** Context providers this file renders (<X.Provider>). */
  providesContexts: string[];
  usedBy: { count: number; files: string[]; searchScope?: { root: string; maxDepth: number } };
  children: string[];
  complexity: { score: number; rating: 'low' | 'medium' | 'high' } | null;
  rerenderRiskCount: number;
  /** What this contract deliberately does NOT cover — so absence is never read as "none". */
  notCovered: string[];
  note?: string;
  error?: string;
}

/**
 * Tool: get_component_contract
 * Everything an agent needs BEFORE editing a component, in one call — the
 * tool Run Fun dogfooding proved was missing (agents chained find → details →
 * used_by → prop_flow → hook_deps and still lacked prop names).
 * Resolution is by COMPONENT NAME across the workspace (not file basename),
 * fixing the index.tsx blindness of find_component_by_name.
 */
export function getComponentContract(component: string, searchDir?: string): ComponentContractResult {
  const empty = (error: string, note?: string): ComponentContractResult => ({
    component, file: null, absolutePath: null, kind: null, directive: null,
    props: { names: [], source: 'none' }, state: [],
    hooks: { total: 0, issueCount: 0, contextsRead: [], refs: [] },
    providesContexts: [], usedBy: { count: 0, files: [] }, children: [],
    complexity: null, rerenderRiskCount: 0, notCovered: [], error, note,
  });

  try {
    // 1. Resolve the component to a file
    let absolutePath: string | null = null;
    let componentName = component;
    let candidates: Array<{ file: string }> = [];

    const looksLikePath = component.includes('/') || /\.(t|j)sx?$/.test(component);
    if (looksLikePath) {
      absolutePath = assertPathInWorkspace(component, 'component');
      const inFile = listComponentsInFile(absolutePath);
      componentName = inFile[0] ?? path.basename(absolutePath).replace(/\.(t|j)sx?$/, '');
    } else {
      const root = searchDir
        ? assertPathInWorkspace(searchDir, 'searchDir')
        : (getWorkspaceRoot() ?? process.cwd());
      const files = scanComponentFiles(root, { maxDepth: 8 });
      const matches: string[] = [];
      for (const f of files) {
        if (listComponentsInFile(f).includes(component)) matches.push(f);
      }
      if (matches.length === 0) {
        return empty(
          'component_not_found',
          `No component named "${component}" declared in ${files.length} files under ${root} (depth ≤ 8, node_modules excluded). The search matches declared component names (function/const/class), so a component created dynamically or re-exported under a different name won't match — grep the identifier to locate it, then pass its file path directly.`
        );
      }
      absolutePath = matches[0];
      candidates = matches.slice(1).map(f => ({ file: f }));
    }

    // 2. Compose the contract from single-file analyses + the used-by scan
    const details = getComponentDetails(absolutePath);
    const hookInfo = analyzeHookDependencies(absolutePath);
    const complexityAll = analyzeFileComplexityAll(absolutePath);
    const complexityEntry = complexityAll.find(c => c.componentName === componentName) ?? complexityAll[0] ?? null;
    const rerender = analyzeFileRerenderRisks(absolutePath);

    // Props: TS type first (authoritative), destructured params as fallback
    const sig = getPropsSignature(absolutePath, componentName);
    const props: ComponentContractResult['props'] =
      sig.props && sig.props.length > 0
        ? { names: sig.props, source: 'type', typeText: sig.typeText, inheritsFrom: sig.inheritsFrom }
        : hookInfo.propDestructures.length > 0
          ? { names: hookInfo.propDestructures, source: 'destructuring' }
          : { names: [], source: 'none' };

    // Providers rendered by this file
    const source = fs.readFileSync(absolutePath, 'utf-8');
    const providesContexts = Array.from(new Set(
      Array.from(source.matchAll(/<(\w+)\.Provider[\s>]/g)).map(m => m[1])
    ));

    // Blast radius (workspace-wide by default via getUsedBy)
    const usedByResult = getUsedBy(absolutePath, searchDir);

    return {
      component: componentName,
      file: path.basename(absolutePath),
      absolutePath,
      candidates: candidates.length > 0 ? candidates : undefined,
      kind: details.type,
      directive: details.directive ?? null,
      props,
      state: details.state,
      hooks: {
        total: hookInfo.totalHooks,
        issueCount: hookInfo.issueCount,
        contextsRead: hookInfo.contextUsages,
        refs: hookInfo.refVariables,
      },
      providesContexts,
      usedBy: {
        count: usedByResult.usedBy.length,
        files: usedByResult.usedBy.map(u => u.absolutePath),
        searchScope: usedByResult.searchScope,
      },
      children: details.directChildren,
      complexity: complexityEntry ? { score: complexityEntry.score, rating: complexityEntry.rating } : null,
      rerenderRiskCount: rerender?.risks.length ?? 0,
      notCovered: [
        'navigation edges (use get_navigation_structure)',
        'prop flow into descendants (use get_prop_flow per prop)',
        'runtime values (use inspect_live_component)',
      ],
      note: candidates.length > 0
        ? `"${componentName}" is declared in ${candidates.length + 1} files — this contract covers ${path.basename(absolutePath)}; the others are listed in candidates.`
        : undefined,
    };
  } catch (err) {
    return empty(`Error: ${err instanceof Error ? err.message : String(err)}`);
  }
}
