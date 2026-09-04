// verifyCompanyDocuments.js
//
// The company-documents model, without a database or a Drive account.
//
// Run:  node verifyCompanyDocuments.js
//
// READS AND WRITES NOTHING. Every check here is against the pure helpers and
// the schema definition — the point is the multi-file shape and the
// backwards-compatible read path, both of which are decidable without I/O.

"use strict";

const {
  ACC_COMPANY_DOC_KINDS,
  ACC_COMPANY_DOC_KIND_VALUES,
  filesOfDoc,
  labelOfDoc,
} = require("./models/Accountant_model/Acc_MasterModels");

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) {
    pass += 1;
    console.log(`  ok    ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

console.log("\nthe catalogue");
check("has a useful number of kinds", ACC_COMPANY_DOC_KINDS.length >= 25);
check(
  "every kind has a value, a label and a group",
  ACC_COMPANY_DOC_KINDS.every((k) => k.value && k.label && k.group),
);
check(
  "values are unique",
  new Set(ACC_COMPANY_DOC_KIND_VALUES).size === ACC_COMPANY_DOC_KIND_VALUES.length,
);
check(
  "the four form rows are all in it",
  ["gst", "pan", "tan", "incorporation"].every((k) =>
    ACC_COMPANY_DOC_KIND_VALUES.includes(k),
  ),
);
check('"other" survives, as the escape hatch', ACC_COMPANY_DOC_KIND_VALUES.includes("other"));
check(
  "the front/back and multi-page kinds are marked",
  ACC_COMPANY_DOC_KINDS.find((k) => k.value === "aadhaar")?.multi === true &&
    ACC_COMPANY_DOC_KINDS.find((k) => k.value === "rent-agreement")?.multi === true,
);
check(
  "nothing is marked required — every proof is optional",
  ACC_COMPANY_DOC_KINDS.every((k) => k.required === undefined),
);

console.log("\nreading a document's files");
check(
  "a multi-file document returns its files in order",
  (() => {
    const f = filesOfDoc({
      files: [
        { _id: "1", name: "front.jpg", caption: "Front" },
        { _id: "2", name: "back.jpg", caption: "Back" },
      ],
    });
    return f.length === 2 && f[0].caption === "Front" && f[1].caption === "Back";
  })(),
);

// The compatibility path: rows written before multi-file support.
check(
  "a legacy single-file row still reads as one file",
  (() => {
    const f = filesOfDoc({
      _id: "abc",
      driveFileId: "drive-1",
      name: "pan.pdf",
      bytes: 2048,
    });
    return f.length === 1 && f[0].driveFileId === "drive-1" && f[0].isLegacy === true;
  })(),
);
check(
  "a document with neither files nor a legacy file reads as empty",
  filesOfDoc({ kind: "other" }).length === 0,
);
check("a missing document does not throw", filesOfDoc(undefined).length === 0);
check(
  "files win over the legacy field when both are present",
  filesOfDoc({ driveFileId: "old", files: [{ _id: "1", name: "new.pdf" }] }).length === 1 &&
    filesOfDoc({ driveFileId: "old", files: [{ _id: "1", name: "new.pdf" }] })[0].name ===
      "new.pdf",
);

console.log("\nnaming a document");
check(
  "a known kind uses the catalogue label",
  labelOfDoc({ kind: "aadhaar" }) === "Aadhaar (front & back)",
);
check(
  "a custom label wins — this is what Other is for",
  labelOfDoc({ kind: "other", label: "Franchise agreement" }) === "Franchise agreement",
);
check(
  "a custom label wins even on a known kind",
  labelOfDoc({ kind: "bank", label: "HDFC current account cheque" }) ===
    "HDFC current account cheque",
);
check("an unknown kind falls back to something printable", labelOfDoc({ kind: "nonsense" }) === "Document");
check("a missing document is still printable", labelOfDoc(undefined) === "Document");

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
