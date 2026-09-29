import fs from "node:fs/promises";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const inputPath = "/Users/risheeray/Downloads/Pay Sheet AUG 2026.xlsx";
const outputPath = "/Users/risheeray/grav-cms-backend/Pay Sheet AUG 2026 - TODAY.xlsx";
const selectedRows = [5,10,11,14,21,24,25,29,35,41,42,43,44,45,47,48,50,51,53,55,57,59,60,61,65,67,71,74,75,78,81,82,85,86];

const input = await FileBlob.load(inputPath);
const workbook = await SpreadsheetFile.importXlsx(input);
const sheet = workbook.worksheets.getItem("Sheet1");

for (const row of selectedRows) {
  sheet.getRange(`F${row}`).values = [["SALARY TODAY"]];
}

await workbook.recalculate();
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);

const check = await workbook.inspect({ kind: "region", sheetId: "Sheet1", range: "A1:G12", maxChars: 3000 });
console.log(check.ndjson ?? check);
console.log(`saved ${outputPath}`);
