/**
 * Custom hook for AI-controlled visualization commands.
 *
 * Extracted from Dendrogram.jsx to isolate command handling logic
 * and prevent scoping bugs between the command layer and the D3 render layer.
 *
 * Manages: highlights, annotations, flows state + command queue + all handlers.
 */
import { useState, useCallback, useRef } from "react";
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
  if (cmd.label) return cmd.label;
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
      return p.text ? `Annotating: ${p.text.slice(0, 50)}` : `Annotating ${p.nodeId || 'node'}`;
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

export function useVisualizationCommands({ svgRef, gRef, zoomRef, rootRef, updateRef, nodeMapRef, NODE_CONFIG }) {
  // Visualization state
  const [highlights, setHighlights] = useState(new Map());
  const [annotations, setAnnotations] = useState([]);
  const [flows, setFlows] = useState([]);

  // Command queue
  const commandQueueRef = useRef([]);
  const processingRef = useRef(false);

  // Manual advance (waitForUser) state
  const manualAdvanceRef = useRef(false);
  const [waitingForAdvance, setWaitingForAdvance] = useState(false);
  const [batchProgress, setBatchProgress] = useState({ current: 0, total: 0 });
  // History of executed commands for Back navigation
  const batchHistoryRef = useRef([]);  // array of commands already executed
  const allBatchCommandsRef = useRef([]); // original full batch for indexing
  const [currentStepDescription, setCurrentStepDescription] = useState('');

  // Helper to find node by file path or name
  const findNodeByPath = useCallback((searchTerm) => {
    // Agents send arbitrary payloads — a missing/non-string target must miss,
    // never throw (an uncaught error here takes down the whole walkthrough).
    if (typeof searchTerm !== 'string' || searchTerm.length === 0) return null;
    if (nodeMapRef.current.has(searchTerm)) {
      return nodeMapRef.current.get(searchTerm);
    }
    const searchBasename = searchTerm.split('/').pop()?.replace(/\.(jsx?|tsx?)$/, '');
    for (const [path, node] of nodeMapRef.current.entries()) {
      const nodeBasename = path.split('/').pop()?.replace(/\.(jsx?|tsx?)$/, '');
      if (nodeBasename === searchBasename) return node;
      if (node.data?.file) {
        const fileBasename = node.data.file.replace(/\.(jsx?|tsx?)$/, '');
        if (fileBasename === searchBasename || fileBasename === searchTerm) return node;
      }
    }
    return null;
  }, []);

  // --- Command Handlers ---

  const handleHighlightCommand = useCallback((payload) => {
    const { color, label, pulse, duration } = payload;
    // Canonical field is `nodes`; accept the aliases agents actually send.
    const rawNodes = payload.nodes ?? payload.components ?? payload.targets ?? [];
    const nodes = (Array.isArray(rawNodes) ? rawNodes : [rawNodes]).filter(Boolean);
    const highlightColor = HIGHLIGHT_COLORS[color] || color;
    const newHighlights = new Map(highlights);
    const notFound = [];

    for (const nodeId of nodes) {
      const node = findNodeByPath(nodeId);
      if (node) {
        newHighlights.set(nodeId, { color: highlightColor, label, pulse: pulse ?? true });
      } else {
        notFound.push(nodeId);
      }
    }

    setHighlights(newHighlights);

    if (duration && duration > 0) {
      setTimeout(() => {
        setHighlights(prev => {
          const updated = new Map(prev);
          for (const nodeId of nodes) updated.delete(nodeId);
          return updated;
        });
      }, duration * 1000);
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
  }, [highlights, findNodeByPath]);

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

    svg.transition()
      .duration(duration)
      .call(
        zoomRef.current.transform,
        d3.zoomIdentity.translate(width / 2, height / 2).scale(scale).translate(-centerX, -centerY)
      );

    return { success: true };
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

    svg.transition().duration(duration).call(
      zoomRef.current.transform,
      d3.zoomIdentity.translate(tx, ty).scale(scale)
    );
    return { success: true };
  }, []);

  // --- Command Queue ---

  const executeCommand = useCallback((command) => {
    console.log('Dendro: Executing command:', command.type, command.payload);
    // A handler throwing on a malformed agent payload must degrade to a
    // structured failure, not an uncaught error that kills the walkthrough.
    try {
      const payload = command.payload || {};
      switch (command.type) {
        case 'highlight': return handleHighlightCommand(payload);
        case 'zoom': return handleZoomCommand(payload);
        case 'annotate': return handleAnnotateCommand(payload);
        case 'traceFlow': return handleTraceFlowCommand(payload);
        case 'clear': return handleClearCommand(payload);
        case 'expand': return handleExpandCommand(payload);
        case 'collapse': return handleCollapseCommand(payload);
        case 'fitAll': return handleFitAllCommand(payload);
        default:
          console.warn('Dendro: Unknown command type:', command.type);
          return { success: false, error: `Unknown command: ${command.type}` };
      }
    } catch (err) {
      console.error('Dendro: Command handler threw:', command.type, err);
      return { success: false, error: `${command.type} handler threw: ${err && err.message ? err.message : err}` };
    }
  }, [handleHighlightCommand, handleZoomCommand, handleAnnotateCommand, handleTraceFlowCommand, handleClearCommand, handleExpandCommand, handleCollapseCommand, handleFitAllCommand]);

  const getCommandDelay = useCallback((command) => {
    // Minimum delay (ms) before the next queued command executes.
    // These must be long enough for users to perceive each change —
    // agents fire tools in rapid succession (2-3s apart) which is too fast.
    switch (command.type) {
      case 'zoom': return command.payload?.duration || 750;
      case 'fitAll': return command.payload?.duration || 1500;
      case 'traceFlow': return 1200;
      case 'highlight': return 800;
      case 'annotate': return 800;
      case 'clear': return 400;
      case 'expand': case 'collapse': return 600;
      default: return 500;
    }
  }, []);

  const processNextCommand = useCallback(() => {
    if (commandQueueRef.current.length === 0) {
      processingRef.current = false;
      manualAdvanceRef.current = false;
      setWaitingForAdvance(false);
      setBatchProgress({ current: 0, total: 0 });
      setCurrentStepDescription('');
      batchHistoryRef.current = [];
      return;
    }
    processingRef.current = true;
    const cmd = commandQueueRef.current.shift();
    batchHistoryRef.current.push(cmd);
    const result = executeCommand(cmd);
    console.log('Dendro: Command result:', cmd.type, result);

    const stepIndex = batchHistoryRef.current.length;
    setBatchProgress(prev => ({ ...prev, current: stepIndex }));
    setCurrentStepDescription(describeCommand(cmd));

    // The HTML template declares `const vscode = acquireVsCodeApi()` at script
    // scope — a global lexical binding, NOT a window property. Reading
    // window.vscode here silently disabled commandResult reporting.
    const vscodeApi = typeof vscode !== 'undefined' ? vscode : null;
    if (vscodeApi && result) {
      vscodeApi.postMessage({ type: 'commandResult', commandType: cmd.type, result });
    }

    // If manual advance mode and more commands remain, pause and wait for user click
    if (manualAdvanceRef.current && commandQueueRef.current.length > 0) {
      setWaitingForAdvance(true);
      return; // Don't auto-advance — wait for advanceNext()
    }

    const delay = getCommandDelay(cmd);
    setTimeout(processNextCommand, delay);
  }, [executeCommand, getCommandDelay]);

  // User clicks "Next" to advance to the next command
  const advanceNext = useCallback(() => {
    setWaitingForAdvance(false);
    processNextCommand();
  }, [processNextCommand]);

  // User clicks "Back" to go to the previous step.
  // Replays all commands from the beginning up to (current - 1).
  const advancePrev = useCallback(() => {
    const history = batchHistoryRef.current;
    if (history.length <= 1) return; // Can't go back past step 1

    // Pop the last executed command back onto the front of the queue
    const lastCmd = history.pop();
    commandQueueRef.current.unshift(lastCmd);

    // Clear all visual state and replay history from scratch
    setHighlights(new Map());
    setAnnotations([]);
    setFlows([]);

    // Re-execute all remaining history commands (without advancing the queue)
    for (const cmd of history) {
      executeCommand(cmd);
    }

    const stepIndex = history.length;
    setBatchProgress(prev => ({ ...prev, current: stepIndex }));
    setCurrentStepDescription(history.length > 0 ? describeCommand(history[history.length - 1]) : '');
    setWaitingForAdvance(true);
  }, [executeCommand]);

  // Skip remaining batch commands
  const skipBatch = useCallback(() => {
    commandQueueRef.current = [];
    batchHistoryRef.current = [];
    processingRef.current = false;
    manualAdvanceRef.current = false;
    setWaitingForAdvance(false);
    setBatchProgress({ current: 0, total: 0 });
    setCurrentStepDescription('');
  }, []);

  const handleVisualizationCommand = useCallback((command) => {
    console.log('Dendro: Enqueuing command:', command.type);
    commandQueueRef.current.push(command);
    if (!processingRef.current) processNextCommand();
    return { success: true, queued: true };
  }, [processNextCommand]);

  // Handle a batch of commands with optional manual advance
  const handleBatchCommands = useCallback((commands, waitForUser) => {
    console.log(`Dendro: Enqueuing batch of ${commands.length} commands, waitForUser=${waitForUser}`);
    manualAdvanceRef.current = !!waitForUser;
    batchHistoryRef.current = [];
    allBatchCommandsRef.current = [...commands];
    setBatchProgress({ current: 0, total: commands.length });
    setCurrentStepDescription('');
    for (const cmd of commands) {
      commandQueueRef.current.push(cmd);
    }
    if (!processingRef.current) processNextCommand();
  }, [processNextCommand]);

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
