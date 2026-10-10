#!/usr/bin/env node
"use strict";

// Renders the source-only construction manifest as a flat DXF diagnostic map.
// This is not a drape, simulated result, or manufacturing instruction.
const fs = require("node:fs");

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  })[ch]);
}

function renderConstructionMap(manifest) {
  if (manifest?.kind !== "grav-shirt-construction-source-manifest"
    || !Array.isArray(manifest.panels) || !Array.isArray(manifest.paths)
    || manifest.readyForDrape !== false) {
    throw new Error("Expected a source-only, not-ready construction manifest.");
  }
  const width = 1600, height = 850;
  const outer = manifest.panels.flatMap(panel => panel.outerCutMm);
  if (!outer.length || outer.some(point => point.length !== 2
    || !point.every(Number.isFinite))) throw new Error("Invalid 2D outer cut geometry.");
  const minX = Math.min(...outer.map(p => p[0]));
  const maxX = Math.max(...outer.map(p => p[0]));
  const minY = Math.min(...outer.map(p => p[1]));
  const maxY = Math.max(...outer.map(p => p[1]));
  const scale = Math.min((width - 90) / (maxX - minX),
    (height - 170) / (maxY - minY));
  if (!Number.isFinite(scale) || scale <= 0) throw new Error("Invalid pattern bounds.");
  const transform = p => [45 + (p[0] - minX) * scale,
    96 + (maxY - p[1]) * scale];
  const polyline = (points, close = false) => points.map((p, i) => {
    const [x, y] = transform(p);
    return `${i ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(" ") + (close ? " Z" : "");
  const colors = { "both-on-outer-cut": "#62baf9",
    "interior-attachment": "#f9a641", "same-piece": "#d5a5f7" };
  const panels = manifest.panels.map(panel => {
    const outline = `<path d="${polyline(panel.outerCutMm, true)}" fill="#26313a" stroke="#91a1aa" stroke-width="1.1"/>`;
    const internal = panel.internalLines.map(line => `<path d="${polyline(line.pointsMm)}" fill="none" stroke="#536872" stroke-width="0.8"/>`).join("");
    const cx = (Math.min(...panel.outerCutMm.map(p => p[0]))
      + Math.max(...panel.outerCutMm.map(p => p[0]))) / 2;
    const cy = (Math.min(...panel.outerCutMm.map(p => p[1]))
      + Math.max(...panel.outerCutMm.map(p => p[1]))) / 2;
    const [x, y] = transform([cx, cy]);
    const label = `<text x="${x.toFixed(2)}" y="${y.toFixed(2)}" text-anchor="middle" class="panel-label">${escapeXml(panel.name)}</text>`;
    return outline + internal + label;
  }).join("");
  const pathMarks = manifest.paths.flatMap(path => {
    if (!colors[path.location]) return [];
    return path.sides.filter(side => side.coordinateSpace === "dxf-panel-mm")
      .map(side => `<path d="${polyline(side.points)}" fill="none" stroke="${colors[path.location]}" stroke-width="2.8" stroke-linecap="round" opacity="0.8"/>`);
  }).join("");
  const smallPanelCenters = new Map(manifest.panels.map(panel => {
    const xs = panel.outerCutMm.map(p => p[0]);
    const ys = panel.outerCutMm.map(p => p[1]);
    return [panel.name, transform([(Math.min(...xs) + Math.max(...xs)) / 2,
      (Math.min(...ys) + Math.max(...ys)) / 2])];
  }));
  const interiorLabels = manifest.paths.filter(path => path.location === "interior-attachment")
    .map(path => {
      const point = smallPanelCenters.get(path.sides[0].owner);
      if (!point) return "";
      return `<text x="${point[0].toFixed(2)}" y="${(point[1] + 20).toFixed(2)}" text-anchor="middle" class="pair-label">pair ${path.pair}</text>`;
    }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<style>text{font-family:system-ui,-apple-system,sans-serif;fill:#e6edf2}.title{font-size:22px;font-weight:700}.sub{font-size:13px;fill:#9bb0bc}.panel-label{font-size:10px;paint-order:stroke;stroke:#152029;stroke-width:3px}.pair-label{font-size:9px;fill:#ffd598;paint-order:stroke;stroke:#152029;stroke-width:3px}.legend{font-size:13px}</style>
<rect width="${width}" height="${height}" fill="#151c22"/>
<text x="45" y="34" class="title">shirt2 — source construction map</text>
<text x="45" y="57" class="sub">Flat DXF coordinates · 13 panels · 38 native paths · NOT A DRAPE · sewing operations unconfirmed</text>
${panels}${pathMarks}${interiorLabels}
<rect x="0" y="795" width="${width}" height="55" fill="#10171c"/>
<text x="45" y="822" class="legend">🔵 Outer-cut paths (24)</text>
<text x="340" y="822" class="legend" fill="#f9a641">🟠 Interior attachments (6)</text>
<text x="700" y="822" class="legend" fill="#d5a5f7">🟣 Same-piece paths (4)</text>
<text x="1030" y="822" class="legend">Auxiliary piping (4): no DXF panel; not plotted</text>
</svg>`;
}

if (require.main === module) {
  const output = process.argv[2];
  if (!output) {
    process.stderr.write("Usage: node scripts/audits/rnd-shirt-construction-map.js <output.svg> < manifest.json\n");
    process.exitCode = 2;
  } else {
    try {
      const manifest = JSON.parse(fs.readFileSync(0, "utf8"));
      fs.writeFileSync(output, renderConstructionMap(manifest));
    } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
  }
}

module.exports = { renderConstructionMap };
