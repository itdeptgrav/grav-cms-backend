"use strict";

const fs = require("fs");
const path = require("path");

const JS_EXTENSIONS = ["", ".js", ".cjs", ".json"];
const EXTERNAL_DATA_MODULES = [
  /^@google-cloud\//,
  /^firebase-admin(?:\/|$)/,
  /^googleapis(?:\/|$)/,
  /^@aws-sdk\//,
  /^aws-sdk(?:\/|$)/,
];

function normalizedRelative(root, target) {
  return path.relative(root, target).replace(/\\/g, "/");
}

function resolveLocalModule(fromFile, request) {
  if (!request.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), request);
  for (const extension of JS_EXTENSIONS) {
    const candidate = `${base}${extension}`;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  for (const extension of [".js", ".cjs", ".json"]) {
    const candidate = path.join(base, `index${extension}`);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function lineNumber(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

function stringConstants(source) {
  const values = new Map();
  const pattern = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(["'`])([^"'`]+)\2\s*;?/g;
  for (const match of source.matchAll(pattern)) values.set(match[1], match[3]);
  return values;
}

function analyseSource(source, file = "<source>") {
  const requires = [];
  const externalModules = new Set();
  const requirePattern = /\brequire\(\s*(["'])([^"']+)\1\s*\)/g;
  for (const match of source.matchAll(requirePattern)) {
    requires.push(match[2]);
    if (!match[2].startsWith(".") && EXTERNAL_DATA_MODULES.some((pattern) => pattern.test(match[2]))) {
      externalModules.add(match[2]);
    }
  }

  const constants = stringConstants(source);
  const firestoreCollections = new Set();
  const unresolvedCollections = [];
  const collectionPattern = /\.collection\(\s*(.+?)\s*\)(?=\s*\.)/g;
  for (const match of source.matchAll(collectionPattern)) {
    const expression = match[1].trim();
    const literal = expression.match(/^(["'`])([^"'`]+)\1$/);
    if (literal) firestoreCollections.add(literal[2]);
    else if (/^[A-Za-z_$][\w$]*$/.test(expression) && constants.has(expression)) {
      firestoreCollections.add(constants.get(expression));
    } else {
      unresolvedCollections.push({ file, line: lineNumber(source, match.index), expression });
    }
  }

  return {
    requires,
    firestoreCollections: [...firestoreCollections].sort(),
    unresolvedCollections,
    externalModules: [...externalModules].sort(),
  };
}

function inventorySourceFiles({ root, entryFiles }) {
  const absoluteRoot = path.resolve(root);
  const queue = [...entryFiles.map((file) => path.resolve(file))];
  const visited = new Set();
  const mongoModels = new Set();
  const firestoreCollections = new Set();
  const unresolvedCollections = [];
  const externalModules = new Set();

  while (queue.length) {
    const file = queue.shift();
    if (visited.has(file) || !file.startsWith(`${absoluteRoot}${path.sep}`)) continue;
    if (!fs.existsSync(file) || !fs.statSync(file).isFile() || file.endsWith(".json")) continue;
    visited.add(file);
    const relativeFile = normalizedRelative(absoluteRoot, file);
    const analysed = analyseSource(fs.readFileSync(file, "utf8"), relativeFile);
    for (const collection of analysed.firestoreCollections) firestoreCollections.add(collection);
    unresolvedCollections.push(...analysed.unresolvedCollections);
    for (const moduleName of analysed.externalModules) externalModules.add(moduleName);

    for (const request of analysed.requires) {
      const target = resolveLocalModule(file, request);
      if (!target || !target.startsWith(`${absoluteRoot}${path.sep}`)) continue;
      const relative = normalizedRelative(absoluteRoot, target);
      if (relative.startsWith("models/")) mongoModels.add(relative);
      if (!visited.has(target)) queue.push(target);
    }
  }

  return {
    scannedFiles: visited.size,
    mongoModels: [...mongoModels].sort(),
    firestoreCollections: [...firestoreCollections].sort(),
    unresolvedCollections: unresolvedCollections.sort((a, b) => (
      a.file.localeCompare(b.file) || a.line - b.line || a.expression.localeCompare(b.expression)
    )),
    externalModules: [...externalModules].sort(),
  };
}

module.exports = { analyseSource, inventorySourceFiles, resolveLocalModule };
