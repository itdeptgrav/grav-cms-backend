#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const { inspectCloCalibration } = require("../../services/rnd/cloCalibration.service");
const { inspectDxf } = require("../../utils/dxfInspect");

const [glbPath, patternPath, metadataPath, garmentType = "unspecified"] = process.argv.slice(2);
if (!glbPath || !patternPath || !metadataPath) {
  process.stderr.write("Usage: node scripts/audits/rnd-clo-calibration-source.js <CLO.glb> <AAMA.dxf|parsed-pattern.json> <CLO-metadata.xml> [garment-type]\n");
  process.exitCode = 2;
} else {
  Promise.resolve().then(async () => {
    const pattern = /\.dxf$/i.test(patternPath)
      ? inspectDxf(fs.readFileSync(patternPath))
      : JSON.parse(fs.readFileSync(patternPath, "utf8"));
    const report = await inspectCloCalibration(fs.readFileSync(glbPath),
      pattern, fs.readFileSync(metadataPath, "utf8"),
      { garmentType });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.sourcePiecesMatched) process.exitCode = 1;
  }).catch(error => {
    process.stderr.write(`${error.code || "CALIBRATION_ERROR"}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
