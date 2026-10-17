import React, { useRef, useEffect, useState } from "react";
import * as d3 from "d3";
import { PALETTE, HIGHLIGHT_COLORS, THEMES, CSS_VARS, GRADIENTS } from "./tokens";
import { useVisualizationCommands } from "./hooks/useVisualizationCommands";
import { renderHighlightLabels } from "./layers/renderHighlightLabels";
import { renderAnnotations } from "./layers/renderAnnotations";
import { renderFlows } from "./layers/renderFlows";

// Alias for backward compatibility within this file
const BRAND = PALETTE;

// Node rendering style: 'neural' (v0.3 circles) or 'organic' (v0.2 paths)
const NODE_STYLE = 'neural';

// Node layout configuration
const NODE_CONFIG = {
  // Neural style dimensions (layered circles)
  membraneRadius: 40,
  somaRadius: 34,
  nucleusRadius: 8,
  nucleolusRadius: 3,
  // Organic style dimensions (legacy concave/convex paths)
  cornerRadius: 10,
  topCurveDepth: 12,
  bottomCurveDepth: 10,
  // Layout (computed from active style)
  baseWidth: NODE_STYLE === 'neural' ? 80 : 130,
  baseHeight: NODE_STYLE === 'neural' ? 80 : 70,
  textTruncateLength: NODE_STYLE === 'neural' ? 16 : 15,
};

// Flow type constants moved to layers/renderFlows.js and hooks/useVisualizationCommands.js

// Creates an organic node shape path
// Concave (indent) at top to "receive" parent connection
// Convex (bulge) at bottom to "send" child connection
function createOrganicNodePath(width, height, topDepth, bottomDepth, cornerRadius) {
  const halfW = width / 2;
  const halfH = height / 2;
  const r = cornerRadius;

  // Control points for the curves
  const topCurveWidth = width * 0.4; // Width of the concave indent
  const bottomCurveWidth = width * 0.4; // Width of the convex bulge

  return `
    M ${-halfW + r},${-halfH}

    L ${-topCurveWidth / 2},${-halfH}
    Q ${0},${-halfH + topDepth} ${topCurveWidth / 2},${-halfH}

    L ${halfW - r},${-halfH}
    Q ${halfW},${-halfH} ${halfW},${-halfH + r}

    L ${halfW},${halfH - r}
    Q ${halfW},${halfH} ${halfW - r},${halfH}

    L ${bottomCurveWidth / 2},${halfH}
    Q ${0},${halfH + bottomDepth} ${-bottomCurveWidth / 2},${halfH}

    L ${-halfW + r},${halfH}
    Q ${-halfW},${halfH} ${-halfW},${halfH - r}

    L ${-halfW},${-halfH + r}
    Q ${-halfW},${-halfH} ${-halfW + r},${-halfH}

    Z
  `;
}

// Link configuration for organic curves
const LINK_CONFIG = {
  startWidth: 8,       // Much thicker at parent (was 4)
  endWidth: 2,         // Thinner at child (was 1.5)
  controlOffset: 0.7,  // Very pronounced S-curve (was 0.55)
  wobble: 15,          // More random offset for hand-drawn feel (was 8)
};

// Seeded random for consistent "hand-drawn" wobble per link
function seededRandom(seed) {
  const x = Math.sin(seed * 9999) * 10000;
  return x - Math.floor(x);
}

const Dendrogram = ({ data, sessionId, isRuntime = false }) => {
  const svgRef = useRef();
  const [darkMode, setDarkMode] = useState(
    () => window.dendroInitialTheme !== 'light'
  );
  const [projectorMode, setProjectorMode] = useState(
    () => window.dendroProjectorMode || false
  );

  // Panel width for responsive layout
  const [panelWidth, setPanelWidth] = useState(window.innerWidth);

  // Listen for VS Code theme changes and projector mode
  useEffect(() => {
    const handler = (event) => {
      if (event.data && event.data.type === 'themeChanged') {
        setDarkMode(event.data.darkMode);
      }
      if (event.data && event.data.type === 'projectorModeChanged') {
        setProjectorMode(event.data.projectorMode);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  // Responsive: observe container size changes
  useEffect(() => {
    const container = svgRef.current?.parentElement;
    if (!container) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setPanelWidth(entry.contentRect.width);
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Refs for D3 elements that need to be accessible from command handlers
  const gRef = useRef(null);        // Main SVG group
  const zoomRef = useRef(null);     // D3 zoom behavior
  const rootRef = useRef(null);     // D3 hierarchy root
  const updateRef = useRef(null);   // D3 update function for expand/collapse
  const nodeMapRef = useRef(new Map()); // Maps file paths to D3 nodes

  // Visualization commands (highlights, annotations, flows) — extracted to custom hook
  const {
    highlights, annotations, flows,
    findNodeByPath, handleVisualizationCommand,
    handleBatchCommands, waitingForAdvance, batchProgress, currentStepDescription,
    advanceNext, advancePrev, skipBatch,
  } = useVisualizationCommands({ svgRef, gRef, zoomRef, rootRef, updateRef, nodeMapRef, NODE_CONFIG });

  // Register command handlers with window on mount
  useEffect(() => {
    if (window.setVisualizationCommandHandler) {
      window.setVisualizationCommandHandler(handleVisualizationCommand);
    }
  }, [handleVisualizationCommand]);

  useEffect(() => {
    window.dendroHandleBatchCommands = handleBatchCommands;
    return () => { window.dendroHandleBatchCommands = null; };
  }, [handleBatchCommands]);

  useEffect(() => {
    if (!svgRef.current) return;

    // Clear previous SVG content. D3 owns everything inside the <svg> (React
    // renders it empty — the stylesheet lives outside it), so a full wipe is
    // safe. Interrupt first so in-flight transitions can't fire on detached
    // nodes. See .dev/bugs/TOUR-BUG-REPORT.md Bug 3.
    d3.select(svgRef.current).selectAll("*").interrupt().remove();

    const svg = d3.select(svgRef.current);
    const width = window.innerWidth;
    const height = window.innerHeight;
    let i = 0; // Node ID counter — scoped to this effect run

    // Set background color based on theme
    svg.style("background", darkMode ? THEMES.dark.background : THEMES.light.background);

    const colorScheme = darkMode ? THEMES.dark : THEMES.light;

    // Reduced motion: one-shot check at render time. CSS media query handles
    // most animations instantly, but SMIL <animateMotion> particles must be
    // gated in JS. If a user toggles reduced-motion while the extension is open,
    // CSS animations stop immediately but existing SMIL particles persist until
    // the next flow trigger recreates them. (v1 limitation)
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Responsive sizing
    const isCompact = panelWidth < 400;
    const isMinimal = panelWidth < 300;
    // Projector mode: scale up sizes for readability on projectors/screen-share
    const pScale = projectorMode ? 1.4 : 1;
    const pFont = (basePx) => `${Math.round(basePx * pScale)}px`;
    const baseRadius = isMinimal ? 25 : isCompact ? 32 : NODE_CONFIG.membraneRadius;
    const nodeRadius = Math.round(baseRadius * pScale);
    const somaRadius = Math.round(nodeRadius * 0.85);
    const nucleusRadius = Math.round(nodeRadius * 0.2);
    const nucleolusRadius = Math.round(nodeRadius * 0.075);
    const isNeural = NODE_STYLE === 'neural';
    const effectiveWidth = isNeural ? nodeRadius * 2 : Math.round(NODE_CONFIG.baseWidth * pScale);
    const effectiveHeight = isNeural ? nodeRadius * 2 : Math.round(NODE_CONFIG.baseHeight * pScale);

    // Create gradient definitions for tapered links
    const defs = svg.append("defs");

    // Create gradient for link tapering effect
    const linkGradientId = "linkTaperGradient";
    const linkGradient = defs.append("linearGradient")
      .attr("id", linkGradientId)
      .attr("gradientUnits", "userSpaceOnUse");

    linkGradient.append("stop")
      .attr("offset", "0%")
      .attr("stop-color", colorScheme.link)
      .attr("stop-opacity", 0.8);

    linkGradient.append("stop")
      .attr("offset", "100%")
      .attr("stop-color", colorScheme.link)
      .attr("stop-opacity", 0.3);

    // 3-layer glow filter: ambient + halo + source (neural luminescence)
    const glowFilter = defs.append("filter")
      .attr("id", "nodeGlow")
      .attr("x", "-80%")
      .attr("y", "-80%")
      .attr("width", "260%")
      .attr("height", "260%");

    // Ambient glow (outermost, subtle)
    glowFilter.append("feGaussianBlur")
      .attr("in", "SourceGraphic")
      .attr("stdDeviation", "10")
      .attr("result", "ambientBlur");

    // Halo glow (middle layer)
    glowFilter.append("feGaussianBlur")
      .attr("in", "SourceGraphic")
      .attr("stdDeviation", "4")
      .attr("result", "haloBlur");

    const feMerge = glowFilter.append("feMerge");
    feMerge.append("feMergeNode").attr("in", "ambientBlur");
    feMerge.append("feMergeNode").attr("in", "haloBlur");
    feMerge.append("feMergeNode").attr("in", "SourceGraphic");

    // Soma inner membrane radial gradient (neural style)
    if (NODE_STYLE === 'neural') {
      const somaGrad = defs.append("radialGradient")
        .attr("id", "somaGradient")
        .attr("cx", "50%").attr("cy", "50%").attr("r", "50%");
      somaGrad.append("stop")
        .attr("offset", "0%")
        .attr("stop-color", darkMode ? PALETTE.stellarCyan : PALETTE.cyanDark)
        .attr("stop-opacity", 0.15);
      somaGrad.append("stop")
        .attr("offset", "100%")
        .attr("stop-color", "transparent")
        .attr("stop-opacity", 0);

      // Particle glow filter for action potential
      const particleGlow = defs.append("filter")
        .attr("id", "particleGlow")
        .attr("x", "-100%").attr("y", "-100%")
        .attr("width", "300%").attr("height", "300%");
      particleGlow.append("feGaussianBlur")
        .attr("in", "SourceGraphic")
        .attr("stdDeviation", "3")
        .attr("result", "blur");
      const pMerge = particleGlow.append("feMerge");
      pMerge.append("feMergeNode").attr("in", "blur");
      pMerge.append("feMergeNode").attr("in", "SourceGraphic");
    }

    const g = svg.append("g").attr("transform", `translate(${width / 2},${height / 2})`);
    gRef.current = g;

    const tree = d3
      .tree()
      .nodeSize([effectiveWidth * (NODE_STYLE === 'neural' ? 2.2 : 1.5), effectiveHeight * (NODE_STYLE === 'neural' ? 3.2 : 4)])
      .separation((a, b) => (a.parent === b.parent ? 1 : 1.5));

    const zoom = d3
      .zoom()
      .scaleExtent([0.1, 2])
      // Explicit extent: the SVG uses 100vw/100vh, which d3-zoom's defaultExtent
      // cannot resolve via baseVal.value (throws NotSupportedError on every
      // zoom.transform). See .dev/bugs/TOUR-BUG-REPORT.md Bug 1.
      .extent(() => [[0, 0], [window.innerWidth, window.innerHeight]])
      .on("zoom", (event) => g.attr("transform", event.transform));

    svg.call(zoom);
    zoomRef.current = zoom;

    // Create hierarchy and store initial children state
    const root = d3.hierarchy(data);
    root.x0 = 0;
    root.y0 = 0;
    rootRef.current = root;

    // Build nodeMap for command lookups
    nodeMapRef.current.clear();
    root.descendants().forEach((d) => {
      d._children = d.children;
      // Map by file path and file name
      if (d.data.file) {
        nodeMapRef.current.set(d.data.file, d);
      }
      // Also map runtime nodes by displayName and runtimeId
      if (d.data._displayName) {
        nodeMapRef.current.set(d.data._displayName, d);
      }
      if (d.data._runtimeId) {
        nodeMapRef.current.set(String(d.data._runtimeId), d);
      }
    });

    // Helper function to remove state popup
    function removeStatePopup() {
      g.selectAll(".state-details").remove();
    }

    // Helper to check if a node is highlighted (shared by update() and highlight labels layer)
    const getHighlightInfo = (d) => {
      // Check by file name
      if (d.data.file && highlights.has(d.data.file)) {
        return highlights.get(d.data.file);
      }
      // Check all highlights for partial match
      for (const [key, info] of highlights.entries()) {
        const keyBasename = key.split('/').pop()?.replace(/\.(jsx?|tsx?)$/, '');
        const nodeBasename = d.data.file?.replace(/\.(jsx?|tsx?)$/, '');
        if (keyBasename === nodeBasename) {
          return info;
        }
      }
      return null;
    };

    // Function to update the tree
    function update(source) {
      const duration = 750;

      // Assigns the x and y position for the nodes
      const treeData = tree(root);

      // Compute the new tree layout
      const nodes = treeData.descendants();
      const links = treeData.links();

      // Auto-disable soma breathing on large trees (>50 nodes)
      svg.classed("large-tree", nodes.length > 50);

      // Normalize for fixed-depth (adjusted depth factor)
      nodes.forEach((d) => (d.y = d.depth * 200)); // Increase depth spacing

      /** Nodes Section **/

      // Update the nodes...
      const node = g.selectAll("g.node").data(nodes, (d) => d.id || (d.id = ++i));

      // Enter any new nodes at the parent's previous position.
      // Neurogenesis: nodes bloom from zero scale
      const nodeEnter = node
        .enter()
        .append("g")
        .attr("class", "node neurogenesis")
        .attr("transform", (d) => `translate(${source.x0},${source.y0})`)
        .on("click", (event, d) => {
          const vsCodeApi = typeof vscode !== 'undefined' ? vscode : null;
          if (vsCodeApi) {
            // Open source file in editor (works for both static and runtime nodes)
            const filePath = d.data._sourceFile || d.data.file;
            if (filePath) {
              vsCodeApi.postMessage({
                type: 'openSourceFile',
                filePath,
              });
            }
            // Runtime-only: inspect component if no source file available
            if (isRuntime && d.data._runtimeId && d.data._runtimeId > 0 && !filePath) {
              vsCodeApi.postMessage({
                type: 'inspectComponent',
                runtimeId: d.data._runtimeId,
              });
            }
          }
          // Always allow expand/collapse
          if (d.children) {
            d._children = d.children;
            d.children = null;
          } else {
            d.children = d._children;
            d._children = null;
          }
          update(d);
        });

      if (NODE_STYLE === 'neural') {
        // Neural node: layered circles (membrane → soma → nucleus)
        const cellGroup = nodeEnter.append("g")
          .attr("class", "node-cell")
          .attr("filter", (d) => {
            const hi = getHighlightInfo(d);
            if (hi) return `drop-shadow(0 0 12px ${hi.color})`;
            return darkMode ? "url(#nodeGlow)" : null;
          });

        // Membrane (outer ring)
        cellGroup.append("circle")
          .attr("class", "node-membrane")
          .attr("r", nodeRadius)
          .style("fill", "none")
          .style("stroke", (d) => {
            const hi = getHighlightInfo(d);
            return hi ? hi.color : colorScheme.nodeStroke;
          })
          .style("stroke-width", (d) => (getHighlightInfo(d) ? 2.5 : 1.5) * pScale)
          .style("stroke-opacity", (d) => getHighlightInfo(d) ? 0.8 : 0.3);

        // Soma fill (main body — also gets .node-rect for CSS compat)
        cellGroup.append("circle")
          .attr("class", "node-rect node-soma")
          .attr("r", somaRadius)
          .style("fill", (d) => {
            const hi = getHighlightInfo(d);
            if (hi) return hi.color;
            const depth = d.depth % colorScheme.depths.length;
            return colorScheme.depths[depth];
          })
          .style("cursor", "pointer");

        // Inner membrane gradient overlay
        cellGroup.append("circle")
          .attr("class", "node-inner")
          .attr("r", somaRadius)
          .style("fill", "url(#somaGradient)")
          .style("opacity", 0.6)
          .style("pointer-events", "none");

        // Nucleus (bright center dot — clickable to open source)
        cellGroup.append("circle")
          .attr("class", "node-nucleus")
          .attr("r", nucleusRadius)
          .style("fill", (d) => {
            const hi = getHighlightInfo(d);
            return hi ? hi.color : (darkMode ? PALETTE.stellarCyan : PALETTE.cyanDark);
          })
          .style("opacity", 0.9)
          .style("cursor", "pointer");

        // Nucleolus (brightest pinpoint)
        cellGroup.append("circle")
          .attr("class", "node-nucleolus")
          .attr("r", nucleolusRadius)
          .style("fill", PALETTE.novaWhite)
          .style("opacity", 0.8)
          .style("pointer-events", "none");

        // Set CSS variable for staggered breathing animation
        nodeEnter.style("--node-index", (d, i) => i);

      } else {
        // Organic node: concave/convex path (legacy v0.2 style)
        const organicPath = createOrganicNodePath(
          NODE_CONFIG.baseWidth,
          NODE_CONFIG.baseHeight,
          NODE_CONFIG.topCurveDepth,
          NODE_CONFIG.bottomCurveDepth,
          NODE_CONFIG.cornerRadius
        );

        nodeEnter
          .append("path")
          .attr("class", (d) => {
            const highlightInfo = getHighlightInfo(d);
            return `node-rect${highlightInfo?.pulse ? ' highlighted-pulse' : ''}`;
          })
          .attr("d", organicPath)
          .style("fill", (d) => {
            const highlightInfo = getHighlightInfo(d);
            if (highlightInfo) return highlightInfo.color;
            const depth = d.depth % colorScheme.depths.length;
            return colorScheme.depths[depth];
          })
          .style("stroke", (d) => {
            const highlightInfo = getHighlightInfo(d);
            return highlightInfo ? highlightInfo.color : colorScheme.nodeStroke;
          })
          .style("stroke-width", (d) => `${(getHighlightInfo(d) ? 3 : (darkMode ? 1 : 1.5)) * pScale}px`)
          .style("stroke-opacity", (d) => getHighlightInfo(d) ? 1 : colorScheme.nodeStrokeOpacity)
          .style("filter", (d) => {
            const highlightInfo = getHighlightInfo(d);
            if (highlightInfo) return `drop-shadow(0 0 12px ${highlightInfo.color})`;
            if (darkMode) return `drop-shadow(0 0 20px rgba(0, 212, 255, 0.12)) drop-shadow(0 0 6px rgba(0, 212, 255, 0.2))`;
            return null;
          });
      }

      // Keyboard navigation attributes
      nodeEnter
        .attr("tabindex", 0)
        .attr("role", "treeitem")
        .attr("aria-expanded", (d) => d.children ? "true" : (d._children ? "false" : null))
        .attr("aria-label", (d) => d.data.file || "Unnamed")
        .on("keydown", (event, d) => {
          switch (event.key) {
            case 'ArrowDown': {
              event.preventDefault();
              const parent = d.parent;
              if (parent && parent.children) {
                const idx = parent.children.indexOf(d);
                if (idx < parent.children.length - 1) {
                  const next = parent.children[idx + 1];
                  const nextEl = g.selectAll("g.node").filter((n) => n === next).node();
                  if (nextEl) nextEl.focus();
                }
              }
              break;
            }
            case 'ArrowUp': {
              event.preventDefault();
              const parent = d.parent;
              if (parent && parent.children) {
                const idx = parent.children.indexOf(d);
                if (idx > 0) {
                  const prev = parent.children[idx - 1];
                  const prevEl = g.selectAll("g.node").filter((n) => n === prev).node();
                  if (prevEl) prevEl.focus();
                }
              }
              break;
            }
            case 'ArrowRight': {
              event.preventDefault();
              if (d._children) {
                d.children = d._children;
                d._children = null;
                update(d);
              } else if (d.children && d.children.length > 0) {
                const firstChild = d.children[0];
                const childEl = g.selectAll("g.node").filter((n) => n === firstChild).node();
                if (childEl) childEl.focus();
              }
              break;
            }
            case 'ArrowLeft': {
              event.preventDefault();
              if (d.children) {
                d._children = d.children;
                d.children = null;
                update(d);
              } else if (d.parent) {
                const parentEl = g.selectAll("g.node").filter((n) => n === d.parent).node();
                if (parentEl) parentEl.focus();
              }
              break;
            }
            case 'Enter': {
              event.preventDefault();
              const vsCodeApi = typeof vscode !== 'undefined' ? vscode : null;
              if (vsCodeApi && d.data._sourceFile) {
                vsCodeApi.postMessage({ type: 'openSourceFile', filePath: d.data._sourceFile });
              } else if (vsCodeApi && d.data.file) {
                vsCodeApi.postMessage({ type: 'openSourceFile', filePath: d.data.file });
              }
              break;
            }
          }
        });

      // Add text to the nodes
      const textGroup = nodeEnter.append("g").attr("class", "text-group");

      // Component name
      const truncLen = isCompact ? 9 : NODE_CONFIG.textTruncateLength;
      const fileName = (d) => d.data.file || "Unnamed";
      const truncatedName = (d) =>
        fileName(d).length > truncLen
          ? `${fileName(d).slice(0, truncLen - 3)}...`
          : fileName(d);

      textGroup
        .append("text")
        .attr("dy", isNeural ? "-0.4em" : "-0.6em")
        .attr("text-anchor", "middle")
        .style("fill", colorScheme.text.primary)
        .style("font-size", isCompact ? pFont(10) : pFont(12))
        .text((d) => truncatedName(d));

      // Add tooltip for truncated names
      textGroup
        .append("title")
        .text((d) => (truncatedName(d) !== fileName(d) ? fileName(d) : ""));

      // Component type (hidden in minimal mode)
      if (!isMinimal) {
        textGroup
          .append("text")
          .attr("dy", isNeural ? "0.9em" : "0.7em")
          .attr("text-anchor", "middle")
          .style("fill", (d) => {
            if (d.data._runtime && d.data._runtimeType === 'host') {
              return colorScheme.text.tertiary;
            }
            return colorScheme.text.secondary;
          })
          .style("font-size", isCompact ? pFont(9) : pFont(11))
          .text((d) => {
            if (d.data._runtime) {
              return d.data._runtimeType || d.data.type || "unknown";
            }
            return d.data.type || "Unknown";
          });
      }

      // State count / runtime indicator (below circle in neural, inline in organic)
      if (!isMinimal) {
        textGroup
          .append("text")
          .attr("dy", isNeural ? "4.2em" : "1.9em")
          .attr("text-anchor", "middle")
          .style("fill", colorScheme.text.tertiary)
          .style("font-size", isCompact ? pFont(9) : pFont(11))
          .text((d) => {
          if (d.data._runtime) {
            return d.data._sourceFile ? "\u2022 mapped" : "\u2022 live";
          }
          return `State: ${d.data.state ? d.data.state.length : 0}`;
        })
        .on("click", (event, d) => {
          event.stopPropagation();
          removeStatePopup();

          if (!d.data.state || d.data.state.length === 0) return;

          const stateDetails = g
            .append("g")
            .attr("class", "state-details")
            .attr("transform", `translate(${d.x + 100},${d.y - 30})`);

          const padding = 10;
          const itemHeight = 20;
          const popupWidth = 200;
          const popupHeight = Math.min(d.data.state.length * itemHeight + padding * 2, 300);

          // Popup background
          stateDetails
            .append("rect")
            .attr("x", -padding)
            .attr("y", -padding)
            .attr("width", popupWidth)
            .attr("height", popupHeight)
            .attr("rx", 5)
            .attr("ry", 5)
            .style("fill", colorScheme.popup.background)
            .style("stroke", colorScheme.popup.border)
            .style("stroke-width", "2px")
            .style("filter", `drop-shadow(0 4px 12px ${colorScheme.popup.shadow})`);

          // Close button
          stateDetails
            .append("text")
            .attr("x", popupWidth - 25)
            .attr("y", 5)
            .text("x")
            .style("fill", colorScheme.popup.text)
            .style("cursor", "pointer")
            .style("font-size", pFont(16))
            .on("click", removeStatePopup);

          // Create scrollable container for state items
          const stateContainer = stateDetails
            .append("g")
            .attr("class", "state-container")
            .attr("clip-path", "url(#state-clip)");

          // Add state items
          d.data.state.forEach((item, idx) => {
            stateContainer
              .append("text")
              .attr("x", 5)
              .attr("y", idx * itemHeight + 15)
              .text(item)
              .style("fill", colorScheme.popup.text)
              .style("font-size", pFont(12));
          });
        });
      } // end if (!isMinimal)

      // Highlight labels are rendered in a separate top-level layer
      // after all nodes, so they always appear on top of child nodes.
      // See "Highlight Labels Layer" section below update().

      // UPDATE
      const nodeUpdate = nodeEnter.merge(node);

      // Transition to the proper position for the nodes
      nodeUpdate
        .transition()
        .duration(duration)
        .attr("transform", (d) => `translate(${d.x},${d.y})`);

      // Remove any exiting nodes — Apoptosis: dim, shrink, dissolve
      const nodeExit = node
        .exit()
        .classed("apoptosis", true)
        .transition()
        .duration(duration)
        .attr("transform", (d) => `translate(${source.x},${source.y})`)
        .remove();

      // Apoptosis dissolve effect
      if (NODE_STYLE === 'neural') {
        nodeExit.select(".node-cell")
          .style("transform", "scale(0.3)")
          .style("opacity", 0)
          .style("filter", "blur(4px)");
      } else {
        nodeExit.select(".node-rect")
          .style("transform", "scale(0)")
          .style("opacity", 0);
      }
      nodeExit.selectAll("text").style("opacity", 0);

      /** Links Section **/

      // Update the links...
      const link = g.selectAll("path.link").data(links, (d) => d.target.id);

      // Enter any new links at the parent's previous position.
      // Links are now FILLED tapered shapes (not stroked lines)
      // Neurogenesis: connection draws itself outward via stroke-dashoffset
      const linkEnter = link
        .enter()
        .insert("path", "g")
        .attr("class", "link")
        .attr("d", (d, idx) => {
          const o = { x: source.x0, y: source.y0 };
          return diagonal(o, o, idx);
        })
        .style("fill", colorScheme.link)  // Filled, not stroked
        .style("stroke", "none")
        .style("opacity", 0);

      // UPDATE
      const linkUpdate = linkEnter.merge(link);

      // Neurogenesis: links fade in as they transition to position
      linkUpdate
        .transition()
        .duration(duration)
        .attr("d", (d, idx) => diagonal(d.source, d.target, idx))
        .style("opacity", 1);

      // Apoptosis: links retract and fade out
      link
        .exit()
        .transition()
        .duration(duration)
        .style("opacity", 0)
        .attr("d", (d, idx) => {
          const o = { x: source.x, y: source.y };
          return diagonal(o, o, idx);
        })
        .remove();

      // === Myelination Pattern for Memoized Components (neural mode) ===
      if (NODE_STYLE === 'neural') {
        g.selectAll(".myelin-group").remove();
        const myelinGroup = g.append("g").attr("class", "myelin-group");

        links.forEach((link, idx) => {
          // Check if the target (child) component is memoized
          if (!link.target.data?.memoized) return;

          const gap = SYNAPSE_CONFIG.gapSize;
          const startY = link.source.y + nodeRadius;
          const endY = link.target.y - nodeRadius - gap;

          // Only draw if there's enough vertical space
          if (endY <= startY) return;

          const { controlOffset, wobble } = LINK_CONFIG;
          const wobble1 = (seededRandom(idx * 1) - 0.5) * wobble;
          const wobble2 = (seededRandom(idx * 2) - 0.5) * wobble;
          const wobble3 = (seededRandom(idx * 3) - 0.5) * wobble;
          const wobble4 = (seededRandom(idx * 4) - 0.5) * wobble;

          const cp1x = link.source.x + wobble1;
          const cp1y = startY + (endY - startY) * controlOffset + wobble2;
          const cp2x = link.target.x + wobble3;
          const cp2y = endY - (endY - startY) * controlOffset + wobble4;

          // Myelination: segmented stroke overlay on the center line
          const myelinPath = `M ${link.source.x},${startY} C ${cp1x},${cp1y} ${cp2x},${cp2y} ${link.target.x},${endY}`;

          myelinGroup.append("path")
            .attr("class", "myelin-sheath")
            .attr("d", myelinPath)
            .style("fill", "none")
            .style("stroke", darkMode ? PALETTE.nebulaSlate : PALETTE.cream)
            .style("stroke-width", 10 * pScale)
            .style("stroke-dasharray", "14 8")
            .style("stroke-linecap", "round")
            .style("opacity", 0.4)
            .style("pointer-events", "none");

          // Brighter inner line (fast signal through myelin)
          myelinGroup.append("path")
            .attr("class", "myelin-core")
            .attr("d", myelinPath)
            .style("fill", "none")
            .style("stroke", darkMode ? PALETTE.stellarCyan : PALETTE.cyanDark)
            .style("stroke-width", 1.5 * pScale)
            .style("stroke-opacity", 0.5)
            .style("pointer-events", "none");
        });
      }

      // === Synaptic Gap Visualization (neural mode) ===
      if (NODE_STYLE === 'neural') {
        // Remove previous synapse elements
        g.selectAll(".synapse-group").remove();

        const synapseGroup = g.append("g").attr("class", "synapse-group");

        links.forEach((link, idx) => {
          const { gapSize, terminalBulb, particleCount } = SYNAPSE_CONFIG;
          const targetY = link.target.y - nodeRadius - gapSize;
          const targetX = link.target.x;

          // Axon terminal bulb (end of parent connection)
          synapseGroup.append("circle")
            .attr("class", "axon-terminal")
            .attr("cx", targetX)
            .attr("cy", targetY)
            .attr("r", terminalBulb)
            .style("fill", darkMode ? PALETTE.stellarCyan : PALETTE.cyanDark)
            .style("opacity", 0.7);

          // Neurotransmitter particles in the synaptic cleft
          for (let p = 0; p < particleCount; p++) {
            const pRand = seededRandom(idx * 100 + p);
            const px = targetX + (pRand - 0.5) * gapSize * 0.8;
            const py = targetY + gapSize * 0.3 + pRand * gapSize * 0.5;
            synapseGroup.append("circle")
              .attr("class", "neurotransmitter")
              .attr("cx", px)
              .attr("cy", py)
              .attr("r", 1.5)
              .style("fill", darkMode ? PALETTE.auroraGreen : PALETTE.greenDark)
              .style("opacity", 0.4 + pRand * 0.4);
          }
        });
      }

      // Store the old positions for transition.
      nodes.forEach((d) => {
        d.x0 = d.x;
        d.y0 = d.y;
      });
    }

    // Synaptic gap configuration (neural mode only)
    const SYNAPSE_CONFIG = {
      gapSize: 12,         // Pixel gap between axon terminal and dendrite input
      terminalBulb: 4,     // Radius of axon terminal bulb
      particleCount: 3,    // Neurotransmitter particles in the gap
    };

    // Creates a TAPERED curved path from parent to child nodes
    // Returns a filled polygon that's wider at parent, thinner at child
    // In neural mode, path stops short of child node to create a synaptic gap
    function diagonal(s, d, linkIndex = 0) {
      const { startWidth, endWidth, controlOffset, wobble } = LINK_CONFIG;
      const gap = NODE_STYLE === 'neural' ? SYNAPSE_CONFIG.gapSize : 0;

      // Calculate the vertical distance for control points
      const dy = d.y - s.y;
      const offset = dy * controlOffset;

      // Add slight randomization for hand-drawn feel (seeded by link index for consistency)
      const wobble1 = (seededRandom(linkIndex * 1) - 0.5) * wobble;
      const wobble2 = (seededRandom(linkIndex * 2) - 0.5) * wobble;
      const wobble3 = (seededRandom(linkIndex * 3) - 0.5) * wobble;
      const wobble4 = (seededRandom(linkIndex * 4) - 0.5) * wobble;

      // In neural mode, offset start/end by node radius to start from membrane edge
      const startY = s.y + (NODE_STYLE === 'neural' ? nodeRadius : 0);
      const endY = d.y - (NODE_STYLE === 'neural' ? nodeRadius + gap : 0);

      // Control points with wobble
      const cp1x = s.x + wobble1;
      const cp1y = startY + (endY - startY) * controlOffset + wobble2;
      const cp2x = d.x + wobble3;
      const cp2y = endY - (endY - startY) * controlOffset + wobble4;

      // For tapered effect, we draw a filled shape instead of a stroked line
      // Left edge of the tapered path (offset by half width)
      const halfStartW = startWidth / 2;
      const halfEndW = endWidth / 2;

      // Create tapered path as a filled shape
      // Start at top-left, curve down left edge, across bottom, curve up right edge
      return `
        M ${s.x - halfStartW},${startY}
        C ${cp1x - halfStartW},${cp1y}
          ${cp2x - halfEndW},${cp2y}
          ${d.x - halfEndW},${endY}
        L ${d.x + halfEndW},${endY}
        C ${cp2x + halfEndW},${cp2y}
          ${cp1x + halfStartW},${cp1y}
          ${s.x + halfStartW},${startY}
        Z
      `;
    }

    // Start the visualization with a zoom-in effect
    svg.call(zoom.transform, d3.zoomIdentity.translate(width / 2, height / 2).scale(2));

    // Expose update function for expand/collapse commands
    updateRef.current = update;

    // Initial update to render the tree
    update(root);

    // === Overlay Layers (extracted to src/webview/layers/) ===
    renderHighlightLabels(g, { highlights, root, getHighlightInfo, nodeRadius, effectiveHeight, isNeural, darkMode, pFont });
    renderAnnotations(g, { annotations, findNodeByPath, colorScheme, pFont });
    renderFlows(g, { flows, effectiveHeight, nodeRadius, prefersReducedMotion, NODE_STYLE });

    // Animate zoom-out to fit the entire tree in the viewport.
    // Compute bounding box from all laid-out nodes, then calculate a scale
    // and translate that fits the tree with padding. Accounts for the fixed
    // AppHeader (~120px) so the root node is never hidden.
    const headerHeight = 120;
    const padding = 60;
    // Use treeData.descendants() to get only visible/laid-out nodes
    const treeData = tree(root);
    const allNodes = treeData.descendants();
    // Re-apply the depth normalization so we use the same y positions as rendering
    allNodes.forEach(d => { d.y = d.depth * 200; });

    if (allNodes.length > 0) {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      allNodes.forEach(d => {
        if (d.x < minX) minX = d.x;
        if (d.x > maxX) maxX = d.x;
        if (d.y < minY) minY = d.y;
        if (d.y > maxY) maxY = d.y;
      });

      const treeWidth = (maxX - minX) || 1;
      const treeHeight = (maxY - minY) || 1;
      const treeCenterX = (minX + maxX) / 2;
      const treeCenterY = (minY + maxY) / 2;

      // Available viewport area (subtract header and padding on all sides)
      const availableWidth = width - padding * 2;
      const availableHeight = height - headerHeight - padding;

      // Scale to fit — no upper cap, let small trees fill the viewport too
      const fitScale = Math.min(
        availableWidth / treeWidth,
        availableHeight / treeHeight
      );
      // Clamp between scaleExtent bounds
      const scale = Math.max(0.1, Math.min(fitScale, 2));

      // Translate so the tree center maps to the center of the available area
      const viewportCenterX = width / 2;
      const viewportCenterY = headerHeight + (availableHeight / 2);
      const tx = viewportCenterX - treeCenterX * scale;
      const ty = viewportCenterY - treeCenterY * scale;

      // Use .call(zoom.transform, ...) without a third arg to avoid
      // transition center distortion from the current zoomed-in state
      svg
        .transition()
        .duration(2000)
        .call(
          zoom.transform,
          d3.zoomIdentity.translate(tx, ty).scale(scale)
        );
    }

    // Cleanup function
    return () => {
      svg.selectAll("*").interrupt().remove();
    };
  }, [data, darkMode, panelWidth, projectorMode, highlights, annotations, flows, findNodeByPath]);

  const buttonStyle = {
    position: "absolute",
    top: 10,
    right: 10,
    zIndex: 100,
    padding: "10px 20px",
    cursor: "pointer",
    backgroundColor: darkMode ? BRAND.nebulaSlate : BRAND.cream,
    color: darkMode ? BRAND.cream : BRAND.ink,
    border: `1px solid ${darkMode ? BRAND.cream : BRAND.brown}`,
    borderRadius: "6px",
    fontFamily: "'Space Grotesk', Inter, 'IBM Plex Sans', sans-serif",
    fontSize: "12px",
    fontWeight: 500,
    transition: "all 200ms cubic-bezier(0.4, 0, 0.2, 1)",
  };

  const liveBadgeStyle = {
    position: "absolute",
    top: 10,
    right: isRuntime ? 180 : undefined,
    left: isRuntime ? undefined : undefined,
    zIndex: 100,
    padding: "6px 14px",
    borderRadius: "9999px",
    backgroundColor: "rgba(0, 255, 100, 0.15)",
    color: PALETTE.statusConnected,
    border: "1px solid rgba(0, 255, 100, 0.4)",
    fontFamily: "'Space Grotesk', Inter, 'IBM Plex Sans', sans-serif",
    fontSize: "11px",
    fontWeight: 600,
    letterSpacing: "0.05em",
    display: isRuntime ? "inline-flex" : "none",
    alignItems: "center",
    gap: "6px",
  };

  return (
    <div style={{
      position: "relative",
      width: "100vw",
      height: "100vh",
      background: darkMode ? THEMES.dark.background : THEMES.light.background,
      backgroundImage: darkMode ? GRADIENTS.darkField : "none",
    }}>
      {/* Live Runtime Badge */}
      {isRuntime && (
        <span className="live-badge" style={liveBadgeStyle}>
          <span style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            backgroundColor: PALETTE.statusConnected,
            display: "inline-block",
          }} />
          LIVE
        </span>
      )}
      {/* Dark Mode Toggle */}
      <button
        onClick={() => setDarkMode((prev) => !prev)}
        style={buttonStyle}
        onMouseEnter={(e) => {
          e.target.style.boxShadow = `0 0 12px ${BRAND.cyan}`;
        }}
        onMouseLeave={(e) => {
          e.target.style.boxShadow = "none";
        }}
      >
        {darkMode ? "Switch to Light Mode" : "Switch to Dark Mode"}
      </button>
      {/* Manual Advance Overlay — shown when visualize_batch has waitForUser: true */}
      {waitingForAdvance && (
        <div style={{
          position: 'fixed',
          bottom: 32,
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 9999,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 8,
          background: 'rgba(10, 10, 15, 0.92)',
          border: `1px solid ${BRAND.cyan}`,
          borderRadius: 12,
          padding: '12px 20px',
          boxShadow: `0 0 20px ${BRAND.cyan}40, 0 4px 16px rgba(0,0,0,0.5)`,
          backdropFilter: 'blur(8px)',
          maxWidth: '80vw',
        }}>
          {/* Step description */}
          {currentStepDescription && (
            <span style={{
              color: '#ccc',
              fontSize: 12,
              fontFamily: 'var(--dendro-font-mono, monospace)',
              textAlign: 'center',
              lineHeight: 1.4,
              maxWidth: 560,
              whiteSpace: 'normal',
            }}>
              {currentStepDescription}
            </span>
          )}
          {/* Controls row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              onClick={advancePrev}
              disabled={batchProgress.current <= 1}
              style={{
                background: 'transparent',
                color: batchProgress.current <= 1 ? '#444' : '#aaa',
                border: `1px solid ${batchProgress.current <= 1 ? '#333' : '#555'}`,
                borderRadius: 8,
                padding: '8px 14px',
                fontSize: 12,
                cursor: batchProgress.current <= 1 ? 'default' : 'pointer',
                fontFamily: 'var(--dendro-font-mono, monospace)',
              }}
              onMouseEnter={(e) => { if (batchProgress.current > 1) e.target.style.borderColor = '#888'; }}
              onMouseLeave={(e) => { e.target.style.borderColor = batchProgress.current <= 1 ? '#333' : '#555'; }}
            >
              Back
            </button>
            <span style={{
              color: '#aaa',
              fontSize: 13,
              fontFamily: 'var(--dendro-font-mono, monospace)',
              minWidth: 70,
              textAlign: 'center',
            }}>
              {batchProgress.current} / {batchProgress.total}
            </span>
            <button
              onClick={advanceNext}
              style={{
                background: `linear-gradient(135deg, ${BRAND.cyan}, ${BRAND.green})`,
                color: '#0a0a0f',
                border: 'none',
                borderRadius: 8,
                padding: '8px 24px',
                fontSize: 14,
                fontWeight: 700,
                fontFamily: 'var(--dendro-font-display, sans-serif)',
                cursor: 'pointer',
                letterSpacing: '0.5px',
              }}
              onMouseEnter={(e) => { e.target.style.boxShadow = `0 0 16px ${BRAND.cyan}`; }}
              onMouseLeave={(e) => { e.target.style.boxShadow = 'none'; }}
            >
              Next
            </button>
            <button
              onClick={skipBatch}
              style={{
                background: 'transparent',
                color: '#888',
                border: '1px solid #444',
                borderRadius: 8,
                padding: '8px 14px',
                fontSize: 12,
                cursor: 'pointer',
                fontFamily: 'var(--dendro-font-mono, monospace)',
              }}
              onMouseEnter={(e) => { e.target.style.borderColor = '#888'; }}
              onMouseLeave={(e) => { e.target.style.borderColor = '#444'; }}
            >
              Skip
            </button>
          </div>
        </div>
      )}
      {/* Stylesheet MUST stay outside the <svg>: D3 wipes the SVG's children
          wholesale, and a React-owned node in there causes removeChild
          NotFoundErrors when React reconciles. TOUR-BUG-REPORT.md Bug 3. */}
      <style>{`
          /* CSS Variables - Dendro MCP Brand System */
          ${CSS_VARS}

          /* === Node Base Styles === */

          .node .node-rect {
            cursor: pointer;
            transition: filter var(--dendro-duration) var(--dendro-ease),
                        transform var(--dendro-duration) var(--dendro-ease);
          }

          .node .node-cell {
            transition: filter var(--dendro-duration) var(--dendro-ease),
                        transform var(--dendro-duration) var(--dendro-ease);
          }

          /* Hover glow effect */
          .node:hover .node-rect {
            filter: drop-shadow(0 0 8px var(--dendro-cyan));
          }

          .node:hover .node-cell {
            filter: drop-shadow(0 0 12px var(--dendro-cyan)) drop-shadow(0 0 4px var(--dendro-green));
          }

          /* === Hover Pulse === */

          @keyframes dendro-pulse {
            0%, 100% { filter: drop-shadow(0 0 6px var(--dendro-cyan)); }
            50% { filter: drop-shadow(0 0 12px var(--dendro-cyan)); }
          }

          .node:hover .node-rect {
            animation: dendro-pulse 1.5s var(--dendro-ease) infinite;
          }

          /* === AI Highlight Pulse === */

          @keyframes highlight-pulse {
            0%, 100% { opacity: 0.8; transform: scale(1); }
            50% { opacity: 1; transform: scale(1.02); }
          }

          .node .node-rect.highlighted-pulse {
            animation: highlight-pulse 1.5s var(--dendro-ease) infinite;
          }

          /* === Breathing Idle Animation (Resting Potential) === */

          @keyframes resting-potential {
            0%, 100% {
              opacity: 0.85;
              filter: drop-shadow(0 0 2px var(--dendro-cyan));
            }
            50% {
              opacity: 1;
              filter: drop-shadow(0 0 6px var(--dendro-cyan));
            }
          }

          .node-soma {
            animation: resting-potential 3s ease-in-out infinite;
            animation-delay: calc(1.5s + var(--node-index, 0) * 0.2s);
          }

          .node:hover .node-soma {
            animation: none;
          }

          /* === Nucleus Pulse === */

          @keyframes nucleus-pulse {
            0%, 100% { opacity: 0.8; }
            50% { opacity: 1; }
          }

          .node-nucleus {
            opacity: 0.9;
          }

          /* === Membrane Breathe === */

          @keyframes membrane-breathe {
            0%, 100% { stroke-opacity: 0.25; }
            50% { stroke-opacity: 0.45; }
          }

          .node-membrane {
            /* Static — stroke-opacity set by D3 inline */
          }

          /* === Myelination (Memoized Components) === */

          .myelin-sheath {
            pointer-events: none;
          }

          .myelin-core {
            pointer-events: none;
          }

          /* === Synaptic Gap === */

          .axon-terminal {
            filter: drop-shadow(0 0 3px var(--dendro-cyan));
          }

          @keyframes neurotransmitter-drift {
            0%, 100% { opacity: 0.3; transform: translateY(0px); }
            50% { opacity: 0.7; transform: translateY(2px); }
          }

          .neurotransmitter {
            /* Static — opacity set by D3 inline */
          }

          /* === Action Potential Particle === */

          .action-potential-particle {
            opacity: 0.95;
          }

          @keyframes particle-glow {
            0%, 100% { r: 4; opacity: 0.9; }
            50% { r: 6; opacity: 1; }
          }

          .action-potential-particle {
            animation: particle-glow 0.6s ease-in-out infinite;
          }

          /* === Annotation Styles === */

          .annotation-callout {
            font-family: 'Space Grotesk', Inter, 'IBM Plex Sans', sans-serif;
            font-size: 12px;
            pointer-events: none;
          }

          .annotation-callout rect {
            fill: var(--dendro-navy);
            stroke: var(--dendro-cyan);
            stroke-width: 1px;
            rx: 4;
            ry: 4;
          }

          .annotation-callout text { fill: var(--dendro-cream); }

          .annotation-callout line {
            stroke: var(--dendro-cyan);
            stroke-width: 1px;
            stroke-dasharray: 4,2;
          }

          /* === Calcium Wave (Context Propagation) === */

          .calcium-wave {
            pointer-events: none;
          }

          .calcium-receptor {
            pointer-events: none;
          }

          /* === Flow Line Styles === */

          .flow-path {
            fill: none;
            stroke-width: 3;
            stroke-linecap: round;
            stroke-linejoin: round;
          }

          .flow-path.flow-animated {
            animation: flow-dash 1s linear infinite;
          }

          /* Dotted flows use slower animation to prevent strobe effect */
          .flow-path.flow-animated.flow-dotted {
            animation-duration: 2s;
          }

          @keyframes flow-dash {
            to { stroke-dashoffset: -20; }
          }

          .flow-label {
            font-family: 'Space Grotesk', Inter, 'IBM Plex Sans', sans-serif;
            font-size: 10px;
            fill: var(--dendro-cream);
            text-anchor: middle;
          }

          /* === Node Text === */

          .node text {
            font-size: 12px;
            font-family: 'JetBrains Mono', 'IBM Plex Mono', monospace;
            pointer-events: none;
            transition: fill var(--dendro-duration) var(--dendro-ease);
          }

          .node .text-group text:first-child {
            font-family: 'JetBrains Mono', 'IBM Plex Mono', monospace;
            font-weight: 400;
          }

          .node .text-group text:last-child {
            pointer-events: all;
            cursor: pointer;
          }

          .node .text-group text:last-child:hover {
            filter: drop-shadow(0 0 4px var(--dendro-cyan));
          }

          /* === Links === */

          .link {
            stroke: none;
            transition: fill-opacity var(--dendro-duration) var(--dendro-ease),
                        filter var(--dendro-duration) var(--dendro-ease);
          }

          .link:hover {
            fill-opacity: 0.85;
            filter: drop-shadow(0 0 3px var(--dendro-cyan));
          }

          /* === State Details Popup === */

          .state-details { pointer-events: all; }

          .state-details text {
            user-select: none;
            font-family: 'Space Grotesk', Inter, 'IBM Plex Sans', sans-serif;
          }

          .state-details rect {
            transition: filter var(--dendro-duration) var(--dendro-ease);
          }

          /* === Neurogenesis (Mount) Animation === */

          @keyframes neurogenesis-bloom {
            0% { opacity: 0; transform: scale(0); }
            60% { opacity: 1; transform: scale(1.08); }
            80% { transform: scale(0.97); }
            100% { opacity: 1; transform: scale(1); }
          }

          .node.neurogenesis {
            animation: neurogenesis-bloom 0.6s var(--dendro-ease) backwards;
            outline: none;
          }

          /* Stagger bloom by node order */
          .node.neurogenesis:nth-child(1) { animation-delay: 0ms; }
          .node.neurogenesis:nth-child(2) { animation-delay: 50ms; }
          .node.neurogenesis:nth-child(3) { animation-delay: 100ms; }
          .node.neurogenesis:nth-child(4) { animation-delay: 150ms; }
          .node.neurogenesis:nth-child(5) { animation-delay: 200ms; }
          .node.neurogenesis:nth-child(6) { animation-delay: 250ms; }
          .node.neurogenesis:nth-child(7) { animation-delay: 300ms; }
          .node.neurogenesis:nth-child(8) { animation-delay: 350ms; }
          .node.neurogenesis:nth-child(9) { animation-delay: 400ms; }
          .node.neurogenesis:nth-child(10) { animation-delay: 450ms; }

          /* === Apoptosis (Unmount) Animation === */

          .node.apoptosis .node-cell {
            transition: transform 0.75s var(--dendro-ease), opacity 0.75s var(--dendro-ease), filter 0.75s var(--dendro-ease);
          }

          .node.apoptosis .node-membrane {
            animation: none;
          }

          .node.apoptosis .node-soma {
            animation: none;
          }

          /* === Keyboard Focus Ring === */

          .node:focus .node-membrane {
            stroke: var(--dendro-cyan);
            stroke-width: 2.5px;
            stroke-opacity: 0.9;
          }

          .node:focus .node-rect {
            outline: 2px solid var(--dendro-cyan);
            outline-offset: 3px;
          }

          .node:focus-visible .node-cell {
            filter: drop-shadow(0 0 10px var(--dendro-cyan));
          }

          /* === Live Runtime Badge === */

          @keyframes live-pulse {
            0%, 100% { opacity: 0.85; }
            50% { opacity: 1; }
          }

          .node.runtime-host .node-rect { opacity: 0.7; }
          .node.runtime-host .node-cell { opacity: 0.7; }

          /* === Live Badge Animation (moved from inline) === */

          .live-badge {
            animation: live-pulse 2s ease-in-out infinite;
          }

          /* === Large Tree: Disable Soma Breathing (>50 nodes) === */

          .large-tree .node-soma { animation: none !important; }

          /* === Reduced Motion: Accessibility === */

          @media (prefers-reduced-motion: reduce) {
            /* Kill all idle animations */
            .node-soma,
            .node-nucleus,
            .node-membrane,
            .neurotransmitter,
            .action-potential-particle,
            .flow-path.flow-animated,
            .node .node-rect.highlighted-pulse,
            .calcium-wave,
            .calcium-receptor,
            .live-badge {
              animation: none !important;
            }

            /* Kill hover/interaction animations */
            .node:hover .node-rect,
            .node:hover .node-soma {
              animation: none !important;
            }

            /* Kill transitions */
            .node .node-rect,
            .node .node-cell,
            .link,
            .state-details rect,
            .node text {
              transition: none !important;
            }

            /* Hide calcium wave elements entirely */
            .calcium-wave,
            .calcium-receptor {
              display: none !important;
            }

            /* Neurogenesis/apoptosis: keep structure, disable animation */
            .node.neurogenesis {
              animation: none !important;
              opacity: 1;
              transform: none;
            }

            /* Static opacity for elements that rely on animation for visibility */
            .node-soma { opacity: 0.9; }
            .node-nucleus { opacity: 0.9; }
            .node-membrane { stroke-opacity: 0.3; }
            .neurotransmitter { opacity: 0.5; }
          }
        `}</style>
      <svg ref={svgRef} width="100vw" height="100vh" />
    </div>
  );
};

export default Dendrogram;
