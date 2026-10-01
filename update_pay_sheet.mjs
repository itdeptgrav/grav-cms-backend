import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const inputPath = "/Users/risheeray/grav-cms-backend/Pay Sheet AUG 2026 - TODAY.xlsx";
const outputPath = "/Users/risheeray/grav-cms-backend/Pay Sheet AUG 2026 - TODAY.xlsx";
const addedRows = [64, 68, 72, 83];

const input = await FileBlob.load(inputPath);
const workbook = await SpreadsheetFile.importXlsx(input);
const sheet = workbook.worksheets.getItem("Sheet1");

for (const row of addedRows) {
  sheet.getRange(`F${row}`).values = [["SALARY TODAY"]];
}
sheet.getRange("F10").values = [["SALARY AUG"]];

await workbook.recalculate();
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);
console.log(`saved ${outputPath}`);
