/**
 * Render highlight labels on top of tree nodes.
 *
 * Extracted from Dendrogram.jsx main useEffect (was lines 1329-1373).
 * Labels are rendered in a separate top-level group AFTER all nodes,
 * so they're never clipped behind child nodes (SVG render order = z-order).
 */
export function renderHighlightLabels(g, {
  highlights,
  root,
  getHighlightInfo,
  nodeRadius,
  effectiveHeight,
  isNeural,
  darkMode,
  pFont,
}) {
  const highlightLabelGroup = g.append("g").attr("class", "highlight-labels-layer");

  if (highlights.size === 0) return;

  const allRenderedNodes = root.descendants();
  allRenderedNodes.forEach((d) => {
    const highlightInfo = getHighlightInfo(d);
    if (!highlightInfo?.label) return;

    const labelG = highlightLabelGroup.append("g")
      .attr("transform", `translate(${d.x},${d.y})`);

    const labelText = highlightInfo.label;
    const charWidth = 7;
    const pillPadding = 6;
    const pillWidth = labelText.length * charWidth + pillPadding * 2;
    const pillHeight = 20;
    const labelY = isNeural ? nodeRadius + 22 : effectiveHeight / 2 + 16;

    labelG.append("rect")
      .attr("x", -pillWidth / 2)
      .attr("y", labelY - pillHeight / 2 - 2)
      .attr("width", pillWidth)
      .attr("height", pillHeight)
      .attr("rx", 4)
      .attr("ry", 4)
      .style("fill", darkMode ? "rgba(10, 14, 23, 0.85)" : "rgba(255, 251, 245, 0.9)")
      .style("stroke", highlightInfo.color)
      .style("stroke-width", "1px")
      .style("stroke-opacity", 0.6);

    labelG.append("text")
      .attr("text-anchor", "middle")
      .attr("y", labelY + 3)
      .style("fill", highlightInfo.color)
      .style("font-size", pFont(11))
      .style("font-weight", "bold")
      .style("font-family", "'JetBrains Mono', 'IBM Plex Mono', monospace")
      .style("filter", `drop-shadow(0 0 4px ${highlightInfo.color})`)
      .text(labelText);
  });
}
