"use strict";
const fs = require("node:fs");
const path = require("node:path");
const MAX_TEXT = 100000;
async function extractDocumentBytes(bytes, mime) {
	const extension = mime === 'application/pdf' ? '.pdf' : mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ? '.xlsx' : '';
	let text;
	if (extension === ".pdf") {
		const { PDFParse } = require("pdf-parse");
		const parser = new PDFParse({ data: new Uint8Array(bytes) });
		try {
			text = (await parser.getText({ pageJoiner: "\n" })).text;
		} finally {
			await parser.destroy();
		}
	} else if (extension === ".xlsx") {
		const Excel = require("exceljs");
		const workbook = new Excel.Workbook();
		await workbook.xlsx.load(bytes);
		const lines = [];
		let size = 0;
		for (const sheet of workbook.worksheets) {
			lines.push(`[Worksheet: ${sheet.name}]`);
			sheet.eachRow((row) => {
				if (size > MAX_TEXT) return;
				const line = row.values
					.slice(1)
					.map((value) => {
						if (value == null) return "";
						if (value instanceof Date) return value.toISOString();
						if (typeof value === "object")
							return String(
								value.result ??
									value.text ??
									value.richText?.map((part) => part.text).join("") ??
									value.formula ??
									"",
							);
						return String(value);
					})
					.join("\t");
				size += line.length + 1;
				lines.push(line);
			});
		}
		text = lines.join("\n");
		if (size > MAX_TEXT) text += "\n[Spreadsheet content truncated.]";
	} else return;
	if (!text?.trim())
		throw new Error(
			"No readable text found. Scanned PDFs require OCR; protected files must be unlocked.",
		);
	if (text.length > MAX_TEXT)
		text = text.slice(0, MAX_TEXT) + "\n[Document text truncated to 100,000 characters.]";
	return text;
}
async function extractAttachmentDocument(filePath) {
	const mime = path.extname(filePath).toLowerCase() === '.pdf' ? 'application/pdf' : path.extname(filePath).toLowerCase() === '.xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : '';
	if (!mime) return;
	const text = await extractDocumentBytes(await fs.promises.readFile(filePath), mime);
	await fs.promises.writeFile(filePath + ".extracted.txt", text, { flag: "wx" });
}
function extractedDocumentText(filePath) {
	const sidecar = filePath + ".extracted.txt";
	if (!fs.existsSync(sidecar)) return null;
	if (path.dirname(fs.realpathSync(sidecar)) !== path.dirname(fs.realpathSync(filePath)))
		throw new Error("Invalid extracted attachment path.");
	return fs.readFileSync(sidecar, "utf8").slice(0, MAX_TEXT + 100);
}
module.exports = { extractAttachmentDocument, extractedDocumentText, extractDocumentBytes };
