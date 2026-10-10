import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { renderConstructionMap } = require("./rnd-shirt-construction-map.js");

test("source-only map labels flat paths without claiming a drape", () => {
  const svg = renderConstructionMap({
    kind: "grav-shirt-construction-source-manifest", readyForDrape: false,
    panels: [{ name: "Front<&", outerCutMm: [[0, 0], [10, 0], [10, 10], [0, 10]],
      internalLines: [{ pointsMm: [[2, 2], [8, 2]] }] }],
    paths: [{ pair: 1, location: "interior-attachment", sides: [
      { owner: "Front<&", coordinateSpace: "dxf-panel-mm", points: [[2, 2], [8, 2]] },
      { owner: "Front<&", coordinateSpace: "dxf-panel-mm", points: [[2, 2], [8, 2]] },
    ] }],
  });
  assert.match(svg, /NOT A DRAPE/);
  assert.match(svg, /Front&lt;&amp;/);
  assert.match(svg, /pair 1/);
  assert.throws(() => renderConstructionMap({ readyForDrape: true }), /source-only/);
});
