/**
 * Shared AST Walker Utility
 *
 * Consolidates the 8 duplicate walkAST implementations across the codebase
 * into a single parameterized function. Three pre-built variants are exported
 * for backward compatibility with existing call sites.
 *
 * @module ast-walker
 */

/**
 * Minimal ESTree node interface used by all parsers.
 * Import this instead of redefining per-file.
 */
export interface ESTreeNode {
  type: string;
  start?: number;
  end?: number;
  [key: string]: unknown;
}

/**
 * Walk all nodes in an OXC/ESTree AST. Calls `callback` for every node
 * that has a `type` property, then recurses into all object/array children.
 *
 * @param node - The root AST node (or subtree) to walk
 * @param callback - Called for each typed node. Receives the node, its parent, and the current depth.
 * @param parent - Parent node (used internally for recursion)
 * @param depth - Current tree depth (used internally for recursion)
 */
export function walkAST(
  node: unknown,
  callback: (node: ESTreeNode, parent: ESTreeNode | undefined, depth: number) => void,
  parent?: ESTreeNode,
  depth = 0,
): void {
  if (!node || typeof node !== 'object') return;

  const esNode = node as ESTreeNode;
  if (esNode.type) {
    callback(esNode, parent, depth);
  }

  for (const key of Object.keys(node as object)) {
    const child = (node as Record<string, unknown>)[key];
    if (Array.isArray(child)) {
      child.forEach((c) => walkAST(c, callback, esNode, depth + 1));
    } else if (child && typeof child === 'object') {
      walkAST(child, callback, esNode, depth + 1);
    }
  }
}

/**
 * Simple walker — callback receives only the node.
 * Drop-in replacement for the 6 identical simple variants.
 */
export function walkASTSimple(
  node: unknown,
  callback: (node: ESTreeNode) => void,
): void {
  walkAST(node, (n) => callback(n));
}

/**
 * Walker with parent tracking — callback receives (node, parent).
 * Drop-in replacement for context-parser's variant.
 */
export function walkASTWithParent(
  node: unknown,
  callback: (node: ESTreeNode, parent?: ESTreeNode) => void,
): void {
  walkAST(node, (n, p) => callback(n, p));
}

/**
 * Walker with depth tracking — callback receives (node, depth).
 * Drop-in replacement for complexity-parser's variant.
 */
export function walkASTWithDepth(
  node: unknown,
  callback: (node: ESTreeNode, depth: number) => void,
): void {
  walkAST(node, (n, _p, d) => callback(n, d));
}
