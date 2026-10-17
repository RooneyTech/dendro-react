import type { ComponentNode } from '../server/parser-oxc';

export const MAX_RESPONSE_CHARS = 40_000;
export type McpResult = { content: [{ type: 'text'; text: string }] };
type FollowUp = { tool: string; arguments: Record<string, unknown> };
type Omission = { path: string; unit: 'items' | 'characters' | 'fields'; total: number; returned: number };
type RecordValue = Record<string, unknown>;

const isObject = (value: unknown): value is RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const pointer = (base: string, key: string | number): string =>
  `${base}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;
const formattedFields = new Set(['formattedOutput', 'formattedTree', 'formattedReport']);
const priorityFields = new Set(['error', 'errors', 'warnings', 'note', 'notCovered', 'summary', 'stats', 'scanScope', 'tree']);

/** Keep the first three levels, breadth first, so one branch cannot consume the preview. */
function treePreview(tree: ComponentNode, base: string, omit: (o: Omission) => void): ComponentNode {
  const root: ComponentNode = { ...tree, children: [] };
  const queue = [{ source: tree, target: root, depth: 0, path: base }];
  let count = 1;
  for (let i = 0; i < queue.length; i++) {
    const { source, target, depth, path } = queue[i];
    const children = source.children || [];
    const keep = depth < 2 ? Math.min(children.length, 20, 60 - count) : 0;
    if (keep < children.length) omit({ path: pointer(path, 'children'), unit: 'items', total: children.length, returned: keep });
    for (let j = 0; j < keep; j++) {
      const child: ComponentNode = { ...children[j], children: [] };
      target.children.push(child);
      queue.push({ source: children[j], target: child, depth: depth + 1, path: pointer(pointer(path, 'children'), j) });
      count++;
    }
  }
  return root;
}

function treeCounts(value: unknown): { shownNodes: number; shownMaxDepth: number } {
  let shownNodes = 0, shownMaxDepth = 0;
  const visit = (node: unknown, depth: number): void => {
    if (!isObject(node) || typeof node.file !== 'string') return;
    shownNodes++; shownMaxDepth = Math.max(shownMaxDepth, depth);
    if (Array.isArray(node.children)) node.children.forEach(child => visit(child, depth + 1));
  };
  visit(value, 0);
  return { shownNodes, shownMaxDepth };
}

/** Bound the final serialized JSON, including all omission metadata. Never slice JSON text. */
export function guardedResponse(result: unknown, options: {
  maxChars?: number;
  previewTree?: boolean;
  followUp?: FollowUp[];
} = {}): McpResult {
  const maxChars = options.maxChars ?? MAX_RESPONSE_CHARS;
  if (!Number.isInteger(maxChars) || maxChars < 2_000) throw new Error('Response budget must be at least 2000 characters');
  const full = JSON.stringify(result, null, 2);
  if (full.length <= maxChars) return { content: [{ type: 'text', text: full }] };
  // Whitespace alone may account for the excess; preserve every value when possible.
  const dense = JSON.stringify(result);
  if (dense.length <= maxChars) return { content: [{ type: 'text', text: dense }] };

  const initial: Omission[] = [];
  let prepared = result;
  let sourceTree: RecordValue | undefined;
  let composite = false;
  if (options.previewTree && isObject(result)) {
    composite = isObject(result.tree) && 'stats' in result.tree;
    sourceTree = composite ? result.tree as RecordValue : result;
    if (isObject(sourceTree.tree) && typeof sourceTree.tree.file === 'string') {
      const tree = treePreview(sourceTree.tree as unknown as ComponentNode, composite ? '/tree/tree' : '/tree', o => initial.push(o));
      prepared = composite ? { ...result, tree: { ...sourceTree, tree } } : { ...result, tree };
    }
  }

  for (let pass = 0; pass < 10; pass++) {
    const omissions = new Map<string, Omission>();
    const omit = (o: Omission): void => {
      const key = `${o.path}:${o.unit}`;
      const previous = omissions.get(key);
      omissions.set(key, { ...o, total: previous ? Math.max(previous.total, o.total) : o.total });
    };
    initial.forEach(omit);
    const items = Math.max(1, Math.floor(40 / 2 ** pass));
    const chars = Math.max(32, Math.floor(4000 / 2 ** pass));
    const depthLimit = Math.max(3, 12 - pass);
    const fields = Math.max(4, Math.floor(80 / 2 ** pass));
    const reduce = (value: unknown, at: string, depth: number, field = ''): unknown => {
      // Keep identifiers usable as follow-up arguments; shrink collection breadth instead.
      const locator = /(?:path|file|dir|name|id)$/i.test(field);
      if (typeof value === 'string' && value.length > chars && !locator) {
        const text = value.slice(0, chars).replace(/[\uD800-\uDBFF]$/, '');
        omit({ path: at, unit: 'characters', total: value.length, returned: text.length });
        return text + '…';
      }
      if (Array.isArray(value)) {
        const keep = depth >= depthLimit ? 0 : Math.min(items, value.length);
        if (keep < value.length) omit({ path: at, unit: 'items', total: value.length, returned: keep });
        return value.slice(0, keep).map((v, i) => reduce(v, pointer(at, i), depth + 1, field));
      }
      if (isObject(value)) {
        const keys = Object.keys(value).filter(k => value[k] !== undefined);
        const sorted = [...keys].sort((a, b) => Number(priorityFields.has(b)) - Number(priorityFields.has(a)));
        const selected = new Set(sorted.slice(0, depth >= depthLimit ? 0 : fields));
        if (selected.size < keys.length) omit({ path: at, unit: 'fields', total: keys.length, returned: selected.size });
        const reduced: RecordValue = Object.create(null);
        for (const key of keys) {
          if (!selected.has(key)) continue;
          if (formattedFields.has(key) && typeof value[key] === 'string' && value[key].length) {
            omit({ path: pointer(at, key), unit: 'characters', total: value[key].length, returned: 0 });
            reduced[key] = '';
          } else reduced[key] = reduce(value[key], pointer(at, key), depth + 1, key);
        }
        return reduced;
      }
      return value;
    };
    const reduced = reduce(prepared, '', 0);
    const body = isObject(reduced) ? reduced : { result: reduced };
    const records = [...omissions.values()];
    const treeResult = composite && isObject(body.tree) ? body.tree : body;
    const counts = sourceTree ? treeCounts(treeResult.tree) : undefined;
    const stats = sourceTree && isObject(sourceTree.stats) ? sourceTree.stats : undefined;
    const output = {
      ...body,
      _output: {
        partial: true, maxChars, originalChars: full.length,
        note: 'Partial response. Counts and summaries describe the requested analysis, not just the displayed sample. Empty collections at omitted paths do not mean no findings. Omission paths use JSON Pointer.',
        omissions: records.slice(0, 24).map(o => ({ ...o, path: o.path.length > 200 ? o.path.slice(0, 200) + '…' : o.path,
          ...(o.path.length > 200 ? { pathTruncated: true } : {}) })),
        omissionDetailsOmitted: Math.max(0, records.length - 24),
        tree: counts && stats ? { ...counts, omittedNodes: Number(stats.totalComponents) - counts.shownNodes, statsScope: 'Tree analyzed before response compaction; caller maxDepth still applies.' } : undefined,
        followUp: options.followUp,
        treeDrillDown: sourceTree ? 'Call get_component_tree with a displayed node absolutePath as entryFile and maxDepth:2, or get_component_details with that absolutePath as filePath.' : undefined,
      }
    };
    const text = JSON.stringify(output);
    if (text.length <= maxChars) return { content: [{ type: 'text', text }] };
  }
  // Pathological objects/keys or unusually large follow-up arguments still get valid, bounded JSON.
  const text = JSON.stringify({ _output: { partial: true, maxChars, originalChars: full.length,
    note: 'Response could not fit a useful preview. All analysis details omitted. Narrow the requested file/directory scope and retry.' } });
  return { content: [{ type: 'text', text }] };
}
