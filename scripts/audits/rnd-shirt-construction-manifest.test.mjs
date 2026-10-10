import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { fromReferenceUv, sourcePathIds } = require("./rnd-shirt-construction-manifest.js");

test("reference flat UV fit is inverted to the original 2D panel, including swapped axes", () => {
  assert.deepEqual(fromReferenceUv([37, -16],
    { sx: 1, sy: -1, swap: false, shift: [7, 4] }), [30, 20]);
  assert.deepEqual(fromReferenceUv([-13, 34],
    { sx: -1, sy: 1, swap: true, shift: [7, 4] }), [30, 20]);
});

test("native source path indices must be valid, ordered, in-range points", () => {
  assert.deepEqual(sourcePathIds("3/1/2", 3), [3, 1, 2]);
  assert.throws(() => sourcePathIds("3/0", 3), /invalid/);
  assert.throws(() => sourcePathIds("3/4", 3), /invalid/);
  assert.throws(() => sourcePathIds("3/Nan", 3), /invalid/);
});
