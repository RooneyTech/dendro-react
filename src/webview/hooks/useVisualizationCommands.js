/**
 * Custom hook for AI-controlled visualization commands.
 *
 * Extracted from Dendrogram.jsx to isolate command handling logic
 * and prevent scoping bugs between the command layer and the D3 render layer.
 *
 * Manages: highlights, annotations, flows state + command queue + all handlers.
 */
import { useState, useCallback, useRef, useEffect } from "react";
import * as d3 from "d3";
import { HIGHLIGHT_COLORS } from "../tokens";

// Flow type → color mapping for traced connections
const FLOW_TYPE_COLORS = {
  prop: '#00BFFF',       // PALETTE.stellarCyan
  context: '#9B59B6',    // PALETTE.quasarViolet
  'hook-state': '#F1C40F', // PALETTE.solarGold
  hook: '#F1C40F',
};

// Derive a human-readable description from a batch command
function describeCommand(cmd) {
  if (cmd.label) return String(cmd.label);
  const p = cmd.payload || {};
  switch (cmd.type) {
    case 'highlight': {
      const count = p.nodes?.length || 0;
      const color = p.color || '';
      const lbl = p.label ? ` — ${p.label}` : '';
      return `Highlighting ${count} component${count !== 1 ? 's' : ''} ${color}${lbl}`;
    }
    case 'zoom':
      return p.target ? `Zooming to ${Array.isArray(p.target) ? p.target[0] : p.target}` : 'Zooming';
    case 'annotate':
      return typeof p.text === 'string' && p.text ? `Annotating: ${p.text.slice(0, 50)}` : `Annotating ${p.nodeId || 'node'}`;
    case 'traceFlow':
      return `Tracing ${p.flowType || 'prop'} flow (${p.nodes?.length || 0} nodes)`;
    case 'clear':
      return `Clearing ${p.clearType || 'all'} overlays`;
    case 'expand':
      return `Expanding ${p.nodeId || 'node'}`;
    case 'collapse':
      return `Collapsing ${p.nodeId || 'node'}`;
    case 'fitAll':
      return 'Fitting tree to viewport';
    default:
      return cmd.type;
  }
}

// Geometry alone survives opacity/display changes. Check the effective visible
// ancestor chain as well, including the SVG and map container.
function isVisible(element) {
  if (!element?.isConnected) return false;
  const bounds = element.getBoundingClientRect();
  if (!(bounds.width > 0 || bounds.height > 0)) return false;
  for (let current = element; current; current = current.parentElement) {
    const style = getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' ||
        style.contentVisibility === 'hidden' || Number(style.opacity) <= 0) return false;
  }
  return true;
}

function hasVisibleFill(element) {
  if (!isVisible(element)) return false;
  const style = getComputedStyle(element);
  return Number(style.fillOpacity) > 0 && d3.color(style.fill)?.opacity > 0;
}

export function useVisualizationCommands({ svgRef, gRef, zoomRef, rootRef, updateRef, nodeMapRef, NODE_CONFIG }) {
  // Visualization state
  const [highlights, setHighlights] = useState(new Map());
  const [annotations, setAnnotations] = useState([]);
  const [flows, setFlows] = useState([]);

  const activeRunRef = useRef(null);
  const pendingRunsRef = useRef([]);
  const processRunRef = useRef(null);
  const executionSignalRef = useRef(null);
  const durationTimersRef = useRef(new Set());
  const overlayStateRef = useRef(null);
  overlayStateRef.current = { highlights, annotations, flows };
  const [waitingForAdvance, setWaitingForAdvance] = useState(false);
  const [batchProgress, setBatchProgress] = useState({ current: 0, total: 0 });
  const [currentStepDescription, setCurrentStepDescription] = useState('');

  // nodeMap can overwrite duplicate basenames. Inspect the complete hierarchy,
  // including collapsed children, before accepting a selector as unambiguous.
  const resolveNode = useCallback((searchTerm) => {
    if (typeof searchTerm !== 'string' || !searchTerm.trim()) return { error: 'Empty or invalid node selector' };
    const normalize = value => String(value || '').replace(/\\/g, '/');
    const selector = normalize(searchTerm);
    const nodes = [];
    const seen = new Set();
    const visit = node => {
      if (!node || seen.has(node)) return;
      seen.add(node);
      nodes.push(node);
      for (const child of node.children || []) visit(child);
      for (const child of node._children || []) visit(child);
    };
    visit(rootRef.current);
    if (!nodes.length) for (const node of nodeMapRef.current.values()) visit(node);
    const names = node => [node.data?.absolutePath, node.data?._sourceFile, node.data?.file,
      node.data?._displayName, node.data?._runtimeId != null ? String(node.data._runtimeId) : null]
      .filter(Boolean).map(normalize);
    let candidates = nodes.filter(node => names(node).includes(selector));
    if (!candidates.length) {
      const hasSourcePaths = nodes.some(node => node.data?.absolutePath || node.data?._sourceFile);
      if (selector.includes('/') && hasSourcePaths) {
        // A wrong absolute path is a miss even when its basename is unique.
        // Relative path aliases may match a unique suffix of a known full path.
        if (!/^(?:[A-Za-z]:\/|\/)/.test(selector)) {
          candidates = nodes.filter(node => names(node).some(name => name.endsWith(`/${selector.replace(/^\.\//, '')}`)));
        }
      } else {
        const basename = selector.split('/').pop().replace(/\.(jsx?|tsx?)$/, '');
        candidates = nodes.filter(node => names(node).some(name => name.split('/').pop().replace(/\.(jsx?|tsx?)$/, '') === basename));
      }
    }
    if (candidates.length !== 1) return { error: candidates.length
      ? `Ambiguous node selector: ${searchTerm} (${candidates.length} matches; use an exact path)`
      : `Node not found: ${searchTerm}` };
    const node = candidates[0];
    // Runtime source files and display names identify components, not instances.
    // Keep the unique instance ID through handler re-resolution and overlay state.
    const key = node.data?._runtimeId != null ? String(node.data._runtimeId)
      : node.data?.absolutePath || node.data?._sourceFile || node.data?.file || node.data?._displayName;
    return { node, key };
  }, []);

  const findNodeByPath = useCallback(searchTerm => resolveNode(searchTerm).node || null, [resolveNode]);

  const postMessage = useCallback(message => {
    // The VS Code template exposes a lexical binding, not necessarily window.vscode.
    const api = typeof vscode !== 'undefined' ? vscode : window.vscode;
    if (api?.postMessage) api.postMessage(message);
  }, []);

  const emitBatch = useCallback((run, status) => {
    if (run.requestId) postMessage({ type: 'batchResult', requestId: run.requestId, status,
      results: run.results.filter(Boolean).map(result => ({ ...result })) });
  }, [postMessage]);

  const mainGroup = useCallback(() => gRef.current?.node?.() || gRef.current, []);

  const renderedNodes = useCallback(node => Array.from(mainGroup()?.querySelectorAll('g.node') || [])
    .filter(element => {
      if (!element.isConnected || element.__data__?.data !== node.data || element.classList.contains('apoptosis')) return false;
      return isVisible(element);
    }), []);

  // --- Command Handlers ---

  const handleHighlightCommand = useCallback((payload) => {
    const { color, label, pulse, duration } = payload;
    // Canonical field is `nodes`; accept the aliases agents actually send.
    const rawNodes = payload.nodes ?? payload.components ?? payload.targets ?? [];
    const nodes = (Array.isArray(rawNodes) ? rawNodes : [rawNodes]).filter(Boolean);
    const highlightColor = HIGHLIGHT_COLORS[color] || color;
    const notFound = [];
    const found = [];

    for (const nodeId of nodes) {
      const node = findNodeByPath(nodeId);
      if (node) {
        found.push(nodeId);
      } else {
        notFound.push(nodeId);
      }
    }

    // Functional update, NOT `new Map(highlights)`: the batch queue's timeout
    // chain holds the executeCommand identity from queue time, so a second
    // highlight command would build from the stale (pre-first-command) map and
    // silently wipe the first command's highlights.
    const info = { color: highlightColor, label, pulse: pulse ?? true };
    setHighlights(prev => {
      const next = new Map(prev);
      for (const nodeId of found) {
        next.set(nodeId, info);
      }
      return next;
    });

    if (duration && duration > 0) {
      const signal = executionSignalRef.current;
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', cancel);
        durationTimersRef.current.delete(timer);
        setHighlights(prev => {
          const updated = new Map(prev);
          for (const nodeId of found) if (updated.get(nodeId) === info) updated.delete(nodeId);
          return updated;
        });
      }, duration * 1000);
      durationTimersRef.current.add(timer);
      const cancel = () => { clearTimeout(timer); durationTimersRef.current.delete(timer); };
      signal?.addEventListener('abort', cancel, { once: true });
    }

    if (notFound.length > 0) {
      console.warn(`Dendro: ${notFound.length} node(s) not found in tree:`, notFound);
      console.warn('Dendro: Available nodes:', Array.from(nodeMapRef.current.keys()).slice(0, 20));
    }

    return {
      success: true,
      highlightedCount: nodes.length - notFound.length,
      notFound: notFound.length > 0 ? notFound : undefined
    };
  }, [findNodeByPath]);

  const handleZoomCommand = useCallback((payload) => {
    const { padding = 50, duration = 750 } = payload;
    // Canonical field is `target`; accept the aliases agents actually send.
    const target = payload.target ?? payload.component ?? payload.node ?? payload.nodes;
    const targets = (Array.isArray(target) ? target : [target]).filter(Boolean);

    if (!svgRef.current || !gRef.current || !zoomRef.current) {
      return { success: false, error: 'Visualization not ready' };
    }

    const svg = d3.select(svgRef.current);
    const targetNodes = [];
    for (const t of targets) {
      const node = findNodeByPath(t);
      if (node) targetNodes.push(node);
    }

    if (targetNodes.length === 0) {
      return { success: false, error: 'No matching nodes found' };
    }

    const halfW = NODE_CONFIG.baseWidth / 2;
    const halfH = NODE_CONFIG.baseHeight / 2;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const node of targetNodes) {
      minX = Math.min(minX, node.x - halfW);
      maxX = Math.max(maxX, node.x + halfW);
      minY = Math.min(minY, node.y - halfH);
      maxY = Math.max(maxY, node.y + halfH);
    }

    minX -= padding; maxX += padding; minY -= padding; maxY += padding;

    const width = window.innerWidth;
    const height = window.innerHeight;
    const scale = Math.min(width / (maxX - minX), height / (maxY - minY), 1.5);
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;

    const transform = d3.zoomIdentity.translate(width / 2, height / 2).scale(scale).translate(-centerX, -centerY);
    const transition = svg.transition()
      .duration(duration)
      .call(
        zoomRef.current.transform,
        transform
      );

    return { success: true, _transform: transform, _animation: transition.end().then(() => true, () => false) };
  }, [findNodeByPath]);

  const handleAnnotateCommand = useCallback((payload) => {
    const { nodeId, text, position = 'right', style = 'callout', color } = payload;
    const node = findNodeByPath(nodeId);
    if (!node) return { success: false, error: `Node not found: ${nodeId}` };

    const annotationId = `annotation-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    setAnnotations(prev => [...prev, {
      id: annotationId, nodeId,
      nodeX: node.x, nodeY: node.y,
      text, position, style, color
    }]);
    return { success: true, annotationId };
  }, [findNodeByPath]);

  const handleTraceFlowCommand = useCallback((payload) => {
    const { nodes, label, color, animated = true, flowType = 'prop' } = payload;
    const resolvedColor = color || FLOW_TYPE_COLORS[flowType] || '#ff4444';
    const flowId = `flow-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const flowNodes = [];
    for (const nodeId of nodes) {
      const node = findNodeByPath(nodeId);
      if (node) flowNodes.push({ id: nodeId, x: node.x, y: node.y });
    }

    if (flowNodes.length < 2) {
      return { success: false, error: 'Need at least 2 valid nodes for flow' };
    }

    setFlows(prev => [...prev, {
      id: flowId, nodes: flowNodes, label,
      color: resolvedColor, animated, flowType
    }]);
    return { success: true, flowId };
  }, [findNodeByPath]);

  const handleClearCommand = useCallback((payload) => {
    const { clearType = 'all', ids } = payload;
    if (ids && ids.length > 0) {
      if (clearType === 'annotations' || clearType === 'all') {
        setAnnotations(prev => prev.filter(a => !ids.includes(a.id)));
      }
      if (clearType === 'flows' || clearType === 'all') {
        setFlows(prev => prev.filter(f => !ids.includes(f.id)));
      }
      if (clearType === 'highlights' || clearType === 'all') {
        setHighlights(prev => {
          const updated = new Map(prev);
          for (const id of ids) updated.delete(id);
          return updated;
        });
      }
    } else {
      if (clearType === 'highlights' || clearType === 'all') setHighlights(new Map());
      if (clearType === 'annotations' || clearType === 'all') setAnnotations([]);
      if (clearType === 'flows' || clearType === 'all') setFlows([]);
    }
    return { success: true };
  }, []);

  const handleExpandCommand = useCallback((payload) => {
    const { nodeId, recursive } = payload;
    const node = findNodeByPath(nodeId);
    if (!node) return { success: false, error: `Node not found: ${nodeId}` };

    const expandNode = (d) => {
      if (d._children) { d.children = d._children; d._children = null; }
      if (recursive && d.children) d.children.forEach(expandNode);
    };
    expandNode(node);
    if (updateRef.current) updateRef.current(node);
    return { success: true };
  }, [findNodeByPath]);

  const handleCollapseCommand = useCallback((payload) => {
    const { nodeId } = payload;
    const node = findNodeByPath(nodeId);
    if (!node) return { success: false, error: `Node not found: ${nodeId}` };
    if (node.children) { node._children = node.children; node.children = null; }
    if (updateRef.current) updateRef.current(node);
    return { success: true };
  }, [findNodeByPath]);

  const handleFitAllCommand = useCallback((payload) => {
    const { duration = 1500, padding = 60 } = payload || {};
    if (!svgRef.current || !zoomRef.current || !rootRef.current) {
      return { success: false, error: 'Visualization not ready' };
    }

    const svg = d3.select(svgRef.current);
    const allNodes = rootRef.current.descendants();
    if (allNodes.length === 0) return { success: false, error: 'No nodes in tree' };

    const headerHeight = 120;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    allNodes.forEach(d => {
      if (d.x < minX) minX = d.x;
      if (d.x > maxX) maxX = d.x;
      if (d.y < minY) minY = d.y;
      if (d.y > maxY) maxY = d.y;
    });

    const treeWidth = (maxX - minX) || 1;
    const treeHeight = (maxY - minY) || 1;
    const width = window.innerWidth;
    const height = window.innerHeight;
    const availableWidth = width - padding * 2;
    const availableHeight = height - headerHeight - padding;
    const fitScale = Math.min(availableWidth / treeWidth, availableHeight / treeHeight);
    const scale = Math.max(0.1, Math.min(fitScale, 2));

    const treeCenterX = (minX + maxX) / 2;
    const treeCenterY = (minY + maxY) / 2;
    const tx = width / 2 - treeCenterX * scale;
    const ty = headerHeight + (availableHeight / 2) - treeCenterY * scale;

    const transform = d3.zoomIdentity.translate(tx, ty).scale(scale);
    const transition = svg.transition().duration(duration).call(
      zoomRef.current.transform,
      transform
    );
    return { success: true, _transform: transform, _animation: transition.end().then(() => true, () => false) };
  }, []);

  // --- Execution and render receipts ---

  const executeCommand = useCallback(command => {
    const beforeGroup = mainGroup();
    const payload = { ...(command?.payload || {}) };
    const targets = command?.type === 'highlight' ? (payload.nodes ?? payload.components ?? payload.targets ?? [])
      : command?.type === 'zoom' ? (payload.target ?? payload.component ?? payload.node ?? payload.nodes ?? [])
      : command?.type === 'traceFlow' ? payload.nodes ?? []
      : ['annotate', 'expand', 'collapse'].includes(command?.type) ? [payload.nodeId] : [];
    const selectors = Array.isArray(targets) ? targets : [targets];
    const resolved = selectors.map(selector => ({ selector, ...resolveNode(selector) }));
    const found = resolved.filter(item => item.node);
    const notFound = resolved.filter(item => !item.node).map(item => String(item.selector ?? ''));
    const matched = [...new Set(found.map(item => item.key))];
    const errors = resolved.filter(item => item.error).map(item => item.error);
    const requiresTargets = ['highlight', 'zoom', 'annotate', 'traceFlow', 'expand', 'collapse'].includes(command?.type);
    const failure = error => ({ success: false, matched, notFound, error, _applied: false });
    if (requiresTargets && !found.length) return failure(errors.join('; ') || 'No node selectors provided');
    if (command?.type === 'traceFlow' && found.length < 2) return failure(errors.join('; ') || 'Need at least 2 valid nodes for flow');
    if (command?.type === 'annotate' && typeof payload.text !== 'string') return failure('Annotation text must be a string');
    if (command?.type === 'highlight' && !d3.color(HIGHLIGHT_COLORS[payload.color] || payload.color)) return failure('Invalid highlight color');
    if (command?.type === 'traceFlow') {
      const color = d3.color(payload.color || FLOW_TYPE_COLORS[payload.flowType || 'prop'] || '#ff4444');
      if (!color || color.opacity <= 0) return failure('Invalid or transparent flow color');
    }
    if (command?.type === 'clear' && !['all', 'highlights', 'annotations', 'flows'].includes(payload.clearType || 'all')) return failure('Unknown clear type');
    if (command?.type === 'clear' && payload.ids != null && (!Array.isArray(payload.ids) || payload.ids.some(id => typeof id !== 'string'))) return failure('Clear ids must be an array of strings');
    if (command?.type === 'clear' && payload.ids && ['all', 'highlights'].includes(payload.clearType || 'all')) {
      payload.ids = [...new Set(payload.ids.flatMap(id => [id, resolveNode(id).key].filter(Boolean)))];
    }
    if (['zoom', 'fitAll'].includes(command?.type) && payload.duration != null &&
        (!Number.isFinite(payload.duration) || payload.duration < 0 || payload.duration > 30000)) return failure('Animation duration must be between 0 and 30000 ms');
    if (command?.type === 'highlight' || command?.type === 'traceFlow') payload.nodes = matched;
    if (command?.type === 'zoom') payload.target = matched;
    if (['annotate', 'expand', 'collapse'].includes(command?.type)) payload.nodeId = matched[0];
    const handlers = { highlight: handleHighlightCommand, zoom: handleZoomCommand, annotate: handleAnnotateCommand,
      traceFlow: handleTraceFlowCommand, clear: handleClearCommand, expand: handleExpandCommand,
      collapse: handleCollapseCommand, fitAll: handleFitAllCommand };
    try {
      if (!handlers[command?.type]) return failure(`Unknown command: ${command?.type}`);
      const result = handlers[command.type](payload);
      return { ...result, success: result.success && !notFound.length, matched, notFound,
        ...(errors.length ? { error: errors.join('; ') } : {}),
        _applied: !!result.success, _nodes: found.map(item => item.node), _payload: payload,
        _beforeGroup: beforeGroup,
        _requiresCommit: ['highlight', 'annotate', 'traceFlow', 'clear'].includes(command.type) };
    } catch (error) {
      return failure(`${command?.type} handler threw: ${error?.message || error}`);
    }
  }, [resolveNode, handleHighlightCommand, handleZoomCommand, handleAnnotateCommand, handleTraceFlowCommand,
    handleClearCommand, handleExpandCommand, handleCollapseCommand, handleFitAllCommand]);

  const verifyRendered = useCallback((command, result) => {
    const group = mainGroup();
    const bounds = svgRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0 || !isVisible(svgRef.current) || !isVisible(group)) return false;
    if (result._requiresCommit && group === result._beforeGroup) return false;
    const payload = result._payload;
    const normalizeColor = value => d3.color(value)?.formatRgb();
    const hasNodes = () => result._nodes.every(node => renderedNodes(node).length > 0);
    switch (command.type) {
      case 'highlight': {
        const color = normalizeColor(HIGHLIGHT_COLORS[payload.color] || payload.color);
        return hasNodes() && result._nodes.every(node => renderedNodes(node).every(element => {
          const shape = element.querySelector('.node-rect');
          return hasVisibleFill(shape) && normalizeColor(getComputedStyle(shape).fill) === color;
        })) &&
          (!payload.label || result.matched.every(key => {
            const node = findNodeByPath(key);
            return node && Array.from(group.querySelectorAll('.highlight-labels-layer > g')).some(element =>
              isVisible(element) && hasVisibleFill(element.querySelector('text')) &&
              element.getAttribute('transform') === `translate(${node.x},${node.y})` && element.querySelector('text')?.textContent === payload.label);
          }));
      }
      case 'annotate': {
        if (!hasNodes()) return false;
        // The renderer creates one callout per annotation, in state order. Compare
        // the complete current state so an old identical annotation cannot satisfy
        // a receipt for a newly requested annotation.
        const callouts = Array.from(group.querySelectorAll('.annotation-callout'));
        const expected = overlayStateRef.current.annotations;
        return callouts.length === expected.length && expected.some(item => item.id === result.annotationId) &&
          callouts.every((element, index) => {
            const item = expected[index];
            const node = findNodeByPath(item.nodeId);
            const offsetX = item.position === 'left' ? -150 : item.position === 'right' ? 100 : 0;
            const offsetY = item.position === 'top' ? -80 : item.position === 'bottom' ? 80 : -30;
            return node && isVisible(element) && isVisible(element.querySelector('rect')) &&
              Array.from(element.querySelectorAll('text')).every(text => !text.textContent.trim() || hasVisibleFill(text)) &&
              element.getAttribute('transform') === `translate(${node.x + offsetX},${node.y + offsetY})` &&
              Array.from(element.querySelectorAll('text')).map(text => text.textContent).join('\n') === item.text;
          });
      }
      case 'traceFlow': {
        const path = group.querySelector(`[id="flow-path-${result.flowId}"]`);
        const flow = overlayStateRef.current.flows.find(item => item.id === result.flowId);
        const style = path && getComputedStyle(path);
        const stroke = style && d3.color(style.stroke);
        const expectedColor = normalizeColor(payload.color || FLOW_TYPE_COLORS[payload.flowType || 'prop'] || '#ff4444');
        return hasNodes() && isVisible(path) && stroke?.opacity > 0 && normalizeColor(style.stroke) === expectedColor &&
          Number(style.strokeOpacity) > 0 && parseFloat(style.strokeWidth) > 0 && path.getTotalLength() > 0 && flow?.nodes.every(point => {
          const node = findNodeByPath(point.id);
          return node && Math.abs(node.x - point.x) < 0.01 && Math.abs(node.y - point.y) < 0.01;
        });
      }
      case 'clear': {
        const expected = overlayStateRef.current;
        const annotations = Array.from(group.querySelectorAll('.annotation-callout'));
        const flowPaths = Array.from(group.querySelectorAll('.flow-path'));
        const nodes = Array.from(group.querySelectorAll('g.node'));
        const highlightedNodes = nodes.filter(element => {
          const cell = element.querySelector('.node-cell');
          return cell ? (cell.getAttribute('filter') || '').startsWith('drop-shadow(')
            : element.querySelector('.node-rect')?.style.strokeOpacity === '1';
        });
        const expectedHighlights = [...expected.highlights].map(([key, info]) => ({ node: findNodeByPath(key), info })).filter(item => item.node);
        return highlightedNodes.length === expectedHighlights.length &&
          expectedHighlights.every(({ node, info }) => renderedNodes(node).every(element =>
            normalizeColor(getComputedStyle(element.querySelector('.node-rect')).fill) === normalizeColor(info.color))) &&
          annotations.every((element, index) => Array.from(element.querySelectorAll('text')).map(text => text.textContent).join('\n') === expected.annotations[index]?.text) &&
          annotations.length === expected.annotations.length && flowPaths.length === expected.flows.length &&
          expected.flows.every(flow => flowPaths.some(element => element.id === `flow-path-${flow.id}`)) &&
          // Highlight labels are optional, so use their expected state count and
          // the committed replacement group to verify clear operations as well.
          group.querySelectorAll('.highlight-labels-layer text').length === [...expected.highlights.values()].filter(info => info.label).length;
      }
      case 'zoom': case 'fitAll': {
        const actual = d3.zoomTransform(svgRef.current);
        const target = result._transform;
        const nodes = Array.from(group.querySelectorAll('g.node'));
        return nodes.length > 0 && !nodes.some(element => d3.active(element)) &&
          (command.type === 'fitAll' || hasNodes()) && target &&
          Math.abs(actual.x - target.x) < 0.01 && Math.abs(actual.y - target.y) < 0.01 && Math.abs(actual.k - target.k) < 0.0001 &&
          group.getAttribute('transform') === actual.toString();
      }
      case 'expand': case 'collapse': {
        if (!hasNodes()) return false;
        const visible = rootRef.current.descendants();
        const elements = Array.from(group.querySelectorAll('g.node'));
        if (elements.length !== visible.length || elements.some(element => element.classList.contains('apoptosis'))) return false;
        return visible.every(node => elements.some(element => {
          const matrix = element.transform.baseVal.consolidate()?.matrix;
          return element.__data__ === node && matrix && Math.abs(matrix.e - node.x) < 0.01 && Math.abs(matrix.f - node.y) < 0.01;
        })) &&
          ![svgRef.current, ...elements, ...group.querySelectorAll('path.link')].some(element => d3.active(element)) &&
          !elements.some(element => element.getAnimations().some(animation => animation.playState === 'running' && animation.effect?.getTiming().iterations !== Infinity));
      }
      default: return false;
    }
  }, [renderedNodes, findNodeByPath]);

  const settleCommand = useCallback((command, result, signal) => {
    if (!result._applied) return Promise.resolve({ rendered: false });
    return new Promise(resolve => {
      let frame;
      let stableFrames = 0;
      let animation = result._animation ? null : true;
      let finished = false;
      const finish = value => {
        if (finished) return;
        finished = true;
        cancelAnimationFrame(frame);
        clearTimeout(deadline);
        signal.removeEventListener('abort', abort);
        resolve(value);
      };
      const abort = () => finish(null);
      const deadline = setTimeout(() => finish({ rendered: false, error: 'Render confirmation timed out' }),
        Math.max(3500, (result._payload?.duration || 0) + 1500));
      result._animation?.then(completed => { animation = completed; });
      const poll = () => {
        if (signal.aborted) return abort();
        if (animation === false) return finish({ rendered: false, error: 'Animation interrupted before completion' });
        let verified = false;
        try { verified = animation === true && verifyRendered(command, result); }
        catch { /* A D3 commit may temporarily detach a target; retry until bounded deadline. */ }
        stableFrames = verified ? stableFrames + 1 : 0;
        if (stableFrames >= 2) return finish({ rendered: true });
        frame = requestAnimationFrame(poll);
      };
      signal.addEventListener('abort', abort, { once: true });
      frame = requestAnimationFrame(poll);
    });
  }, [verifyRendered]);

  const wait = useCallback((delay, signal) => new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, delay);
    if (signal.aborted) finish();
    else signal.addEventListener('abort', finish, { once: true });
  }), []);

  const resetControls = useCallback(() => {
    setWaitingForAdvance(false);
    setBatchProgress({ current: 0, total: 0 });
    setCurrentStepDescription('');
  }, []);

  const stopRun = useCallback((run, status) => {
    run.controller.abort();
    d3.select(svgRef.current).interrupt();
    d3.select(mainGroup()).selectAll('*').interrupt();
    emitBatch(run, status);
    if (activeRunRef.current === run) activeRunRef.current = null;
    resetControls();
  }, [emitBatch, resetControls]);

  const startRun = useCallback(run => {
    activeRunRef.current = run;
    setBatchProgress({ current: 0, total: run.commands.length });
    emitBatch(run, 'running');
    processRunRef.current(run);
  }, [emitBatch]);

  const makeRun = useCallback((commands, manual = false, options = {}) => ({
    commands: [...commands], manual, requestId: options.requestId, results: [], nextIndex: 0,
    controller: new AbortController(), waiting: false, processing: false,
    delay: Number.isFinite(options.delay) ? Math.max(0, Math.min(options.delay, 30000)) : null,
  }), []);

  processRunRef.current = async run => {
    if (run.processing) return;
    run.processing = true;
    try {
      while (activeRunRef.current === run && !run.controller.signal.aborted) {
        const index = run.nextIndex;
        if (index >= run.commands.length) {
          emitBatch(run, 'completed');
          activeRunRef.current = null;
          resetControls();
          const next = pendingRunsRef.current.shift();
          if (next) startRun(next);
          return;
        }
        const command = run.commands[index];
        executionSignalRef.current = run.controller.signal;
        const result = executeCommand(command);
        const receipt = await settleCommand(command, result, run.controller.signal);
        if (!receipt || activeRunRef.current !== run || run.controller.signal.aborted) return;
        const publicResult = Object.fromEntries(Object.entries(result).filter(([key]) => !key.startsWith('_')));
        const success = !!result.success && receipt.rendered;
        run.results[index] = { index, commandType: command?.type || 'unknown', success, rendered: receipt.rendered,
          matched: result.matched || [], notFound: result.notFound || [],
          ...(receipt.error || result.error ? { error: [result.error, receipt.error].filter(Boolean).join('; ') } : {}) };
        run.nextIndex = index + 1;
        postMessage({ type: 'commandResult', commandType: command?.type, result: { ...publicResult, ...receipt, success } });
        setBatchProgress({ current: run.nextIndex, total: run.commands.length });
        setCurrentStepDescription(describeCommand(command || {}));
        emitBatch(run, 'running');
        const replayFinished = run.replayUntil != null && run.nextIndex >= run.replayUntil;
        if (run.nextIndex < run.commands.length && (replayFinished || (run.replayUntil == null && run.manual && receipt.rendered))) {
          run.replayUntil = null;
          run.waiting = true;
          setWaitingForAdvance(true);
          emitBatch(run, 'waiting_for_user');
          return;
        }
        if (run.replayUntil == null && !run.manual && run.nextIndex < run.commands.length) {
          const defaultDelay = { highlight: 800, annotate: 800, traceFlow: 1200, clear: 400, expand: 600, collapse: 600 }[command?.type] || 0;
          await wait(run.delay ?? defaultDelay, run.controller.signal);
        }
      }
    } finally {
      run.processing = false;
    }
  };

  const advanceNext = useCallback(() => {
    const run = activeRunRef.current;
    if (!run?.waiting || run.processing) return;
    run.waiting = false;
    setWaitingForAdvance(false);
    processRunRef.current(run);
  }, []);

  const advancePrev = useCallback(async () => {
    const run = activeRunRef.current;
    if (!run?.waiting || run.processing || run.nextIndex <= 1) return;
    const previous = run.results.slice(0, run.nextIndex - 1).findLastIndex(result => result?.rendered);
    if (previous < 0) return;
    const replayUntil = previous + 1;
    run.waiting = false;
    run.processing = true;
    run.controller.abort();
    run.controller = new AbortController();
    setWaitingForAdvance(false);
    run.results = [];
    run.nextIndex = 0;
    run.replayUntil = replayUntil;
    emitBatch(run, 'running');
    executionSignalRef.current = run.controller.signal;
    const reset = { type: 'clear', payload: { clearType: 'all' } };
    const result = executeCommand(reset);
    const receipt = await settleCommand(reset, result, run.controller.signal);
    run.processing = false;
    if (receipt && activeRunRef.current === run && !run.controller.signal.aborted) processRunRef.current(run);
  }, [emitBatch, executeCommand, settleCommand]);

  const skipBatch = useCallback(() => {
    const run = activeRunRef.current;
    if (!run) return;
    stopRun(run, 'skipped');
    const next = pendingRunsRef.current.shift();
    if (next) startRun(next);
  }, [stopRun, startRun]);

  const handleVisualizationCommand = useCallback(command => {
    const run = makeRun([command]);
    if (activeRunRef.current) pendingRunsRef.current.push(run);
    else startRun(run);
    return { success: true, queued: true };
  }, [makeRun, startRun]);

  const handleBatchCommands = useCallback((commands, waitForUser, options = {}) => {
    const previous = activeRunRef.current;
    if (previous) stopRun(previous, 'superseded');
    pendingRunsRef.current = [];
    startRun(makeRun(Array.isArray(commands) ? commands : [], !!waitForUser, options));
  }, [makeRun, startRun, stopRun]);

  useEffect(() => () => {
    activeRunRef.current?.controller.abort();
    for (const timer of durationTimersRef.current) clearTimeout(timer);
    durationTimersRef.current.clear();
    pendingRunsRef.current = [];
  }, []);

  return {
    highlights,
    annotations,
    flows,
    findNodeByPath,
    handleVisualizationCommand,
    handleBatchCommands,
    waitingForAdvance,
    batchProgress,
    currentStepDescription,
    advanceNext,
    advancePrev,
    skipBatch,
  };
}
