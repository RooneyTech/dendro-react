/**
 * Dendro Pro — Proprietary
 * Copyright (c) 2025 Rooney Industries LLC. All rights reserved.
 * Unauthorized copying, modification, or distribution is prohibited.
 */

import { getComponentTree, GetComponentTreeResult } from '../tools';

interface ComponentNode {
  file: string;
  type: 'functional' | 'class' | null;
  state: string[];
  directive?: 'use client' | 'use server' | null;
  children: ComponentNode[];
}

export interface ExportSvgResult {
  svg: string;
  nodeCount: number;
  error?: string;
}

// Layout constants
const NODE_WIDTH = 180;
const NODE_HEIGHT = 40;
const NODE_PADDING_X = 30;
const NODE_PADDING_Y = 60;
const FONT_SIZE = 13;
const FONT_FAMILY = 'system-ui, -apple-system, sans-serif';

// Brand colors
const COLORS = {
  light: {
    bg: '#ffffff',
    functional: '#4CAF50',
    class: '#2196F3',
    hasState: '#FF9800',
    unknown: '#9E9E9E',
    text: '#333333',
    textLight: '#ffffff',
    edge: '#999999',
  },
  dark: {
    bg: '#1e1e1e',
    functional: '#66BB6A',
    class: '#42A5F5',
    hasState: '#FFA726',
    unknown: '#BDBDBD',
    text: '#e0e0e0',
    textLight: '#ffffff',
    edge: '#666666',
  },
};

interface LayoutNode {
  id: string;
  label: string;
  fill: string;
  x: number;
  y: number;
  children: LayoutNode[];
  file: string;
}

/**
 * Compute the width of a subtree (number of leaf nodes).
 */
function subtreeWidth(node: ComponentNode, maxDepth?: number, depth = 0): number {
  if (maxDepth !== undefined && depth >= maxDepth) return 1;
  if (!node.children || node.children.length === 0) return 1;
  let w = 0;
  for (const child of node.children) {
    w += subtreeWidth(child, maxDepth, depth + 1);
  }
  return w;
}

/**
 * Recursively layout nodes into x,y positions.
 */
function layoutTree(
  node: ComponentNode,
  theme: 'light' | 'dark',
  x: number,
  y: number,
  idMap: Map<string, string>,
  idCounter: Map<string, number>,
  maxDepth?: number,
  depth = 0
): LayoutNode | null {
  if (maxDepth !== undefined && depth > maxDepth) return null;

  const colors = COLORS[theme];

  // Generate unique ID
  let baseId = node.file.replace(/\.(jsx?|tsx?)$/, '').replace(/[^a-zA-Z0-9]/g, '_');
  let nodeId: string;
  if (idMap.has(node.file)) {
    nodeId = idMap.get(node.file)!;
  } else {
    const count = idCounter.get(baseId) || 0;
    nodeId = count > 0 ? `${baseId}_${count}` : baseId;
    idCounter.set(baseId, count + 1);
    idMap.set(node.file, nodeId);
  }

  // Determine fill color
  let fill: string;
  if (node.state && node.state.length > 0) {
    fill = colors.hasState;
  } else if (node.type === 'class') {
    fill = colors.class;
  } else if (node.type === 'functional') {
    fill = colors.functional;
  } else {
    fill = colors.unknown;
  }

  // Label: file name without extension
  let label = node.file.replace(/\.(jsx?|tsx?)$/, '');
  if (label.length > 20) {
    label = label.substring(0, 17) + '...';
  }

  const layoutNode: LayoutNode = {
    id: nodeId,
    label,
    fill,
    x,
    y,
    children: [],
    file: node.file,
  };

  if (node.children && node.children.length > 0 && (maxDepth === undefined || depth < maxDepth)) {
    const totalLeaves = subtreeWidth(node, maxDepth, depth);
    const totalWidth = totalLeaves * (NODE_WIDTH + NODE_PADDING_X);
    let childX = x - totalWidth / 2;

    for (const child of node.children) {
      const childLeaves = subtreeWidth(child, maxDepth, depth + 1);
      const childWidth = childLeaves * (NODE_WIDTH + NODE_PADDING_X);
      const childCenterX = childX + childWidth / 2;

      const childLayout = layoutTree(
        child, theme, childCenterX,
        y + NODE_HEIGHT + NODE_PADDING_Y,
        idMap, idCounter, maxDepth, depth + 1
      );
      if (childLayout) {
        layoutNode.children.push(childLayout);
      }
      childX += childWidth;
    }
  }

  return layoutNode;
}

/**
 * Collect all nodes in flat list for bounding box calculation.
 */
function flattenNodes(node: LayoutNode): LayoutNode[] {
  const result: LayoutNode[] = [node];
  for (const child of node.children) {
    result.push(...flattenNodes(child));
  }
  return result;
}

/**
 * Generate SVG edges (curved paths from parent to children).
 */
function generateEdges(node: LayoutNode, theme: 'light' | 'dark'): string[] {
  const color = COLORS[theme].edge;
  const lines: string[] = [];

  for (const child of node.children) {
    const x1 = node.x;
    const y1 = node.y + NODE_HEIGHT;
    const x2 = child.x;
    const y2 = child.y;
    const midY = (y1 + y2) / 2;

    lines.push(
      `  <path d="M${x1},${y1} C${x1},${midY} ${x2},${midY} ${x2},${y2}" ` +
      `fill="none" stroke="${color}" stroke-width="1.5" opacity="0.6"/>`
    );

    lines.push(...generateEdges(child, theme));
  }

  return lines;
}

/**
 * Generate SVG node rectangles and labels.
 */
function generateNodes(nodes: LayoutNode[], theme: 'light' | 'dark'): string[] {
  const textColor = COLORS[theme].textLight;
  const lines: string[] = [];

  for (const node of nodes) {
    const rx = node.fill === COLORS[theme].class ? 20 : 6; // stadium for class, rounded for functional
    lines.push(
      `  <rect x="${node.x - NODE_WIDTH / 2}" y="${node.y}" ` +
      `width="${NODE_WIDTH}" height="${NODE_HEIGHT}" ` +
      `rx="${rx}" ry="${rx}" fill="${node.fill}" />`
    );
    lines.push(
      `  <text x="${node.x}" y="${node.y + NODE_HEIGHT / 2 + FONT_SIZE / 3}" ` +
      `text-anchor="middle" font-family="${FONT_FAMILY}" font-size="${FONT_SIZE}" ` +
      `fill="${textColor}">${escapeXml(node.label)}</text>`
    );
  }

  return lines;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Export a component tree as an SVG diagram.
 *
 * @param entryFile - Path to the root component file
 * @param maxDepth - Optional maximum depth to traverse
 * @param theme - Color theme: 'light' or 'dark'. Default: 'dark'
 * @returns ExportSvgResult with the SVG string and node count
 */
export function exportSvg(
  entryFile: string,
  maxDepth?: number,
  theme: 'light' | 'dark' = 'dark'
): ExportSvgResult {
  try {
    const treeResult: GetComponentTreeResult = getComponentTree(entryFile, maxDepth);

    if (treeResult.error) {
      return { svg: '', nodeCount: 0, error: treeResult.error };
    }

    if (!treeResult.tree) {
      return { svg: '', nodeCount: 0, error: 'No component tree found' };
    }

    const idMap = new Map<string, string>();
    const idCounter = new Map<string, number>();

    // Layout the tree starting at origin
    const root = layoutTree(treeResult.tree, theme, 0, 0, idMap, idCounter, maxDepth);
    if (!root) {
      return { svg: '', nodeCount: 0, error: 'Failed to layout tree' };
    }

    const allNodes = flattenNodes(root);

    // Calculate bounding box
    const padding = 40;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of allNodes) {
      minX = Math.min(minX, n.x - NODE_WIDTH / 2);
      maxX = Math.max(maxX, n.x + NODE_WIDTH / 2);
      minY = Math.min(minY, n.y);
      maxY = Math.max(maxY, n.y + NODE_HEIGHT);
    }

    const width = maxX - minX + padding * 2;
    const height = maxY - minY + padding * 2;
    const offsetX = -minX + padding;
    const offsetY = -minY + padding;

    const colors = COLORS[theme];

    // Build SVG
    const svgLines: string[] = [];
    svgLines.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`);
    svgLines.push(`  <rect width="${width}" height="${height}" fill="${colors.bg}"/>`);
    svgLines.push(`  <g transform="translate(${offsetX}, ${offsetY})">`);

    // Edges first (behind nodes)
    svgLines.push(...generateEdges(root, theme));

    // Nodes on top
    svgLines.push(...generateNodes(allNodes, theme));

    svgLines.push('  </g>');

    // Legend
    const legendY = height - 30;
    svgLines.push(`  <g transform="translate(10, ${legendY})">`);
    svgLines.push(`    <rect x="0" y="0" width="12" height="12" rx="2" fill="${colors.functional}"/>`);
    svgLines.push(`    <text x="16" y="10" font-family="${FONT_FAMILY}" font-size="10" fill="${colors.text}">Functional</text>`);
    svgLines.push(`    <rect x="80" y="0" width="12" height="12" rx="6" fill="${colors.class}"/>`);
    svgLines.push(`    <text x="96" y="10" font-family="${FONT_FAMILY}" font-size="10" fill="${colors.text}">Class</text>`);
    svgLines.push(`    <rect x="140" y="0" width="12" height="12" rx="2" fill="${colors.hasState}"/>`);
    svgLines.push(`    <text x="156" y="10" font-family="${FONT_FAMILY}" font-size="10" fill="${colors.text}">Has State</text>`);
    svgLines.push('  </g>');

    svgLines.push('</svg>');

    return {
      svg: svgLines.join('\n'),
      nodeCount: allNodes.length,
    };
  } catch (err) {
    return {
      svg: '',
      nodeCount: 0,
      error: `SVG export error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export const exportToSvg = exportSvg;
