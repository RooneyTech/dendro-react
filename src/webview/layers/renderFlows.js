/**
 * Render flow connections with animated particles.
 *
 * Extracted from Dendrogram.jsx main useEffect (was lines 1438-1567).
 * Includes action potential particles (prop/hook flows) and calcium wave (context flows).
 */
import { PALETTE } from "../tokens";

// Flow type → dash pattern for colorblind-safe differentiation
const FLOW_TYPE_PATTERNS = {
  prop: 'none',
  context: '12, 6',
  'hook-state': '3, 4',
  hook: '3, 4',
};

export function renderFlows(g, {
  flows,
  effectiveHeight,
  nodeRadius,
  prefersReducedMotion,
  NODE_STYLE,
}) {
  const flowGroup = g.append("g").attr("class", "flows-layer");

  flows.forEach((flow) => {
    if (flow.nodes.length < 2) return;

    const halfH = effectiveHeight / 2;

    const pathData = flow.nodes.map((node, idx) => {
      if (idx === 0) return `M ${node.x},${node.y + halfH}`;
      const prev = flow.nodes[idx - 1];
      const midY = (prev.y + node.y) / 2 + halfH;
      return `Q ${prev.x},${midY} ${node.x},${node.y + halfH}`;
    }).join(' ');

    const flowPathId = `flow-path-${flow.id}`;
    const dashPattern = FLOW_TYPE_PATTERNS[flow.flowType] || 'none';
    const isDotted = dashPattern === '3, 4';
    const animatedDash = flow.animated
      ? (dashPattern === 'none' ? '16, 4' : dashPattern)
      : (dashPattern === 'none' ? null : dashPattern);

    const flowPath = flowGroup.append("path")
      .attr("id", flowPathId)
      .attr("d", pathData)
      .style("stroke", flow.color)
      .style("opacity", 0.8);

    let flowClass = 'flow-path';
    if (flow.animated) flowClass += ' flow-animated';
    if (isDotted) flowClass += ' flow-dotted';
    flowPath.attr("class", flowClass);

    if (animatedDash) {
      flowPath.style("stroke-dasharray", animatedDash);
    }

    // Action potential particle
    if (flow.animated && NODE_STYLE === 'neural' && !prefersReducedMotion) {
      const particle = flowGroup.append("circle")
        .attr("class", "action-potential-particle")
        .attr("r", 5)
        .style("fill", "#FFFFFF")
        .style("filter", `drop-shadow(0 0 8px ${flow.color}) drop-shadow(0 0 3px #fff)`);

      const animateMotion = particle.append("animateMotion")
        .attr("dur", "1.2s")
        .attr("repeatCount", "indefinite")
        .attr("fill", "freeze");

      animateMotion.append("mpath")
        .attr("href", `#${flowPathId}`);
    }

    // Label at midpoint
    if (flow.label && flow.nodes.length >= 2) {
      const midIdx = Math.floor(flow.nodes.length / 2);
      const midNode = flow.nodes[midIdx];
      flowGroup.append("text")
        .attr("class", "flow-label")
        .attr("x", midNode.x)
        .attr("y", midNode.y - 20)
        .text(flow.label)
        .style("fill", flow.color);
    }

    // Calcium wave for context propagation
    if (flow.flowType === 'context' && NODE_STYLE === 'neural' && flow.nodes.length >= 2 && !prefersReducedMotion) {
      const provider = flow.nodes[0];
      const maxDist = Math.max(...flow.nodes.map(n =>
        Math.sqrt(Math.pow(n.x - provider.x, 2) + Math.pow(n.y - provider.y, 2))
      ));

      const waveId = `calcium-wave-${flow.id}`;
      const waveDefs = flowGroup.append("defs");

      const waveGrad = waveDefs.append("radialGradient")
        .attr("id", `${waveId}-grad`);
      waveGrad.append("stop").attr("offset", "70%").attr("stop-color", PALETTE.quasarViolet).attr("stop-opacity", 0);
      waveGrad.append("stop").attr("offset", "85%").attr("stop-color", PALETTE.quasarViolet).attr("stop-opacity", 0.3);
      waveGrad.append("stop").attr("offset", "100%").attr("stop-color", PALETTE.quasarViolet).attr("stop-opacity", 0);

      flowGroup.append("circle")
        .attr("class", "calcium-wave")
        .attr("cx", provider.x)
        .attr("cy", provider.y)
        .attr("r", 0)
        .style("fill", `url(#${waveId}-grad)`)
        .style("pointer-events", "none")
        .transition()
        .duration(2000)
        .attr("r", maxDist + 60)
        .style("opacity", 0)
        .remove();

      flow.nodes.forEach((node, idx) => {
        if (idx === 0) return;
        const dist = Math.sqrt(Math.pow(node.x - provider.x, 2) + Math.pow(node.y - provider.y, 2));
        const delay = maxDist > 0 ? (dist / maxDist) * 1500 : 0;

        flowGroup.append("circle")
          .attr("class", "calcium-receptor")
          .attr("cx", node.x)
          .attr("cy", node.y)
          .attr("r", nodeRadius + 8)
          .style("fill", "none")
          .style("stroke", PALETTE.quasarViolet)
          .style("stroke-width", 2)
          .style("opacity", 0)
          .style("pointer-events", "none")
          .transition()
          .delay(delay)
          .duration(400)
          .style("opacity", 0.6)
          .transition()
          .duration(800)
          .attr("r", nodeRadius + 16)
          .style("opacity", 0)
          .remove();
      });
    }
  });
}
