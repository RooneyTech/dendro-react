/**
 * Render annotation callouts on the visualization.
 *
 * Extracted from Dendrogram.jsx main useEffect (was lines 1375-1436).
 */
export function renderAnnotations(g, {
  annotations,
  findNodeByPath,
  colorScheme,
  pFont,
}) {
  const annotationGroup = g.append("g").attr("class", "annotations-layer");

  annotations.forEach((annotation) => {
    const node = findNodeByPath(annotation.nodeId);
    if (!node) {
      console.warn('Dendro: Annotation node not found:', annotation.nodeId);
      return;
    }

    const offsetX = annotation.position === 'left' ? -150 : (annotation.position === 'right' ? 100 : 0);
    const offsetY = annotation.position === 'top' ? -80 : (annotation.position === 'bottom' ? 80 : -30);

    const annotationEl = annotationGroup.append("g")
      .attr("class", "annotation-callout")
      .attr("transform", `translate(${node.x + offsetX},${node.y + offsetY})`);

    const textContent = annotation.text;
    const padding = 8;
    const lineHeight = 16;
    const lines = textContent.split('\n');
    const textWidth = Math.max(...lines.map(l => l.length * 7)) + padding * 2;
    const textHeight = lines.length * lineHeight + padding * 2;

    annotationEl.append("rect")
      .attr("x", -padding)
      .attr("y", -padding - 2)
      .attr("width", textWidth)
      .attr("height", textHeight)
      .attr("rx", 4)
      .attr("ry", 4)
      .style("fill", annotation.color || colorScheme.popup.background)
      .style("stroke", colorScheme.popup.border)
      .style("stroke-width", "1px")
      .style("filter", `drop-shadow(0 0 6px ${colorScheme.popup.shadow})`);

    annotationEl.append("line")
      .attr("x1", annotation.position === 'left' ? textWidth : 0)
      .attr("y1", textHeight / 2 - padding)
      .attr("x2", annotation.position === 'left' ? textWidth + 50 : -offsetX)
      .attr("y2", annotation.position === 'left' || annotation.position === 'right' ? textHeight / 2 - padding : (annotation.position === 'top' ? textHeight + 30 : -50))
      .style("stroke", colorScheme.popup.border)
      .style("stroke-width", "1px")
      .style("stroke-dasharray", "4,2");

    lines.forEach((line, idx) => {
      annotationEl.append("text")
        .attr("x", 0)
        .attr("y", idx * lineHeight + lineHeight / 2)
        .text(line)
        .style("fill", colorScheme.popup.text)
        .style("font-size", pFont(12))
        .style("font-family", "'Space Grotesk', Inter, 'IBM Plex Sans', sans-serif")
        .style("pointer-events", "none");
    });
  });
}
