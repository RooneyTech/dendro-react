/**
 * Dendro Pro — Proprietary
 * Copyright (c) 2025 Rooney Industries LLC. All rights reserved.
 * Unauthorized copying, modification, or distribution is prohibited.
 */

import { getComponentTree, GetComponentTreeResult } from '../tools';

// Types for the component tree nodes (mirrors tools.ts)
interface ComponentNode {
  file: string;
  type: 'functional' | 'class' | null;
  state: string[];
  directive?: 'use client' | 'use server' | null;
  children: ComponentNode[];
}

export interface ExportMermaidResult {
  mermaid: string;
  nodeCount: number;
  error?: string;
}

/**
 * Sanitize a node name for use as a Mermaid node ID.
 * Strips file extensions, replaces non-alphanumeric characters with underscores,
 * and ensures the ID starts with a letter.
 */
function sanitizeNodeId(name: string): string {
  // Remove file extension
  let id = name.replace(/\.(jsx?|tsx?)$/, '');
  // Replace any non-alphanumeric character with underscore
  id = id.replace(/[^a-zA-Z0-9]/g, '_');
  // Ensure it starts with a letter (Mermaid requirement)
  if (!/^[a-zA-Z]/.test(id)) {
    id = 'N_' + id;
  }
  return id;
}

/**
 * Sanitize a display label for Mermaid. Escapes quotes and truncates long names.
 */
function sanitizeLabel(name: string, maxLength = 40): string {
  // Remove file extension for display
  let label = name.replace(/\.(jsx?|tsx?)$/, '');
  // Truncate long names
  if (label.length > maxLength) {
    label = label.substring(0, maxLength - 3) + '...';
  }
  // Escape double quotes for Mermaid string safety
  label = label.replace(/"/g, '#quot;');
  return label;
}

/**
 * Build a display label that includes directive and state markers.
 */
function buildLabel(node: ComponentNode): string {
  const base = sanitizeLabel(node.file);
  const markers: string[] = [];

  if (node.directive === 'use client') {
    markers.push('Client');
  } else if (node.directive === 'use server') {
    markers.push('Server');
  }

  if (node.state.length > 0) {
    markers.push('State');
  }

  if (markers.length > 0) {
    return `${base}\\n[${markers.join(', ')}]`;
  }
  return base;
}

/**
 * Recursively traverse the component tree and collect Mermaid node definitions
 * and edge definitions. Handles duplicate file names by tracking seen IDs and
 * appending a counter suffix.
 */
function traverseTree(
  node: ComponentNode,
  nodes: string[],
  edges: string[],
  classifications: { functional: string[]; classComp: string[]; hasState: string[] },
  idMap: Map<string, string>,
  idCounter: Map<string, number>,
  currentDepth: number,
  maxDepth?: number
): void {
  if (maxDepth !== undefined && currentDepth > maxDepth) {
    return;
  }

  // Generate a unique node ID
  let baseId = sanitizeNodeId(node.file);
  let nodeId: string;

  // If this exact file path has already been mapped, reuse the ID
  // (a component can appear multiple times in edges but should only be defined once)
  if (idMap.has(node.file)) {
    nodeId = idMap.get(node.file)!;
  } else {
    // Handle duplicate base IDs (different files with same name in different dirs)
    const count = idCounter.get(baseId) || 0;
    if (count > 0) {
      nodeId = `${baseId}_${count}`;
    } else {
      nodeId = baseId;
    }
    idCounter.set(baseId, count + 1);
    idMap.set(node.file, nodeId);

    // Build the label
    const label = buildLabel(node);

    // Use different Mermaid shapes based on component type:
    //   functional: rounded rectangle ["..."]
    //   class: stadium shape (["..."]) - uses double brackets for visual distinction
    //   unknown: default rectangle ["..."]
    if (node.type === 'class') {
      nodes.push(`  ${nodeId}(["${label}"])`);
      classifications.classComp.push(nodeId);
    } else {
      nodes.push(`  ${nodeId}["${label}"]`);
      if (node.type === 'functional') {
        classifications.functional.push(nodeId);
      }
    }

    // Track state classification
    if (node.state.length > 0) {
      classifications.hasState.push(nodeId);
    }
  }

  // Recurse into children and create edges
  for (const child of node.children || []) {
    // Ensure child is traversed first so its node definition exists
    traverseTree(child, nodes, edges, classifications, idMap, idCounter, currentDepth + 1, maxDepth);

    const childId = idMap.get(child.file);
    if (childId) {
      const edge = `  ${nodeId} --> ${childId}`;
      // Avoid duplicate edges
      if (!edges.includes(edge)) {
        edges.push(edge);
      }
    }
  }
}

/**
 * Export a component tree as a Mermaid flowchart diagram.
 *
 * @param entryFile - Path to the root component file
 * @param maxDepth - Optional maximum depth to traverse
 * @param direction - Flow direction: 'TB' (top-bottom) or 'LR' (left-right). Default: 'LR'
 * @returns ExportMermaidResult with the Mermaid syntax string and node count
 */
export function exportMermaid(
  entryFile: string,
  maxDepth?: number,
  direction: 'TB' | 'LR' | 'BT' | 'RL' = 'LR'
): ExportMermaidResult {
  try {
    const treeResult: GetComponentTreeResult = getComponentTree(entryFile, maxDepth);

    if (treeResult.error) {
      return {
        mermaid: '',
        nodeCount: 0,
        error: treeResult.error
      };
    }

    if (!treeResult.tree) {
      return {
        mermaid: '',
        nodeCount: 0,
        error: 'No component tree found'
      };
    }

    const nodes: string[] = [];
    const edges: string[] = [];
    const classifications = {
      functional: [] as string[],
      classComp: [] as string[],
      hasState: [] as string[]
    };
    const idMap = new Map<string, string>();
    const idCounter = new Map<string, number>();

    traverseTree(treeResult.tree, nodes, edges, classifications, idMap, idCounter, 0, maxDepth);

    // Build the Mermaid output
    const lines: string[] = [];
    lines.push(`graph ${direction}`);

    // Node definitions
    if (nodes.length > 0) {
      lines.push(...nodes);
    }

    // Edge definitions
    if (edges.length > 0) {
      lines.push('');
      lines.push(...edges);
    }

    // Class definitions for styling
    lines.push('');
    lines.push('  classDef functional fill:#4CAF50,stroke:#333');
    lines.push('  classDef classComp fill:#2196F3,stroke:#333');
    lines.push('  classDef hasState fill:#FF9800,stroke:#333');

    // Apply classes to nodes
    // Note: hasState takes precedence over type styling for visual emphasis
    if (classifications.functional.length > 0) {
      // Filter out nodes that also have state (state styling wins)
      const pureFunc = classifications.functional.filter(
        id => !classifications.hasState.includes(id)
      );
      if (pureFunc.length > 0) {
        lines.push(`  class ${pureFunc.join(',')} functional`);
      }
    }

    if (classifications.classComp.length > 0) {
      const pureClass = classifications.classComp.filter(
        id => !classifications.hasState.includes(id)
      );
      if (pureClass.length > 0) {
        lines.push(`  class ${pureClass.join(',')} classComp`);
      }
    }

    if (classifications.hasState.length > 0) {
      lines.push(`  class ${classifications.hasState.join(',')} hasState`);
    }

    return {
      mermaid: lines.join('\n'),
      nodeCount: idMap.size
    };
  } catch (err) {
    return {
      mermaid: '',
      nodeCount: 0,
      error: `Mermaid export error: ${err instanceof Error ? err.message : String(err)}`
    };
  }
}

// Alias for server.ts compatibility
export const exportToMermaid = exportMermaid;
