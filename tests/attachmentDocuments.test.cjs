const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Excel = require('exceljs');
const { extractAttachmentDocument, extractedDocumentText } = require('../src/main/attachmentDocuments');
test('Excel upload extraction includes worksheets, cells and cached formula results', async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'attachment-xlsx-'));
 try {
  const file=path.join(root,'budget.xlsx');
  const workbook=new Excel.Workbook();
  const sheet=workbook.addWorksheet('Budget');sheet.addRow(['Item','Amount']);sheet.addRow(['Hosting',12]);sheet.addRow(['Total',{formula:'SUM(B2:B2)',result:12}]);
  await workbook.xlsx.writeFile(file);await extractAttachmentDocument(file);
  const text=extractedDocumentText(file);
  assert.match(text,/Worksheet: Budget/);assert.match(text,/Hosting\t12/);assert.match(text,/Total\t12/);
  fs.unlinkSync(file+'.extracted.txt');fs.writeFileSync(path.join(root,'outside.txt'),'secret');fs.mkdirSync(path.join(root,'managed'));const managed=path.join(root,'managed','file.xlsx');fs.copyFileSync(file,managed);fs.symlinkSync(path.join(root,'outside.txt'),managed+'.extracted.txt');
  assert.throws(()=>extractedDocumentText(managed),/Invalid extracted/);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('PDF upload extraction produces text usable by text-only models', async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'attachment-pdf-'));
 try {
  const stream='BT /F1 12 Tf 72 720 Td (Hello PDF) Tj ET';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>','<< /Length '+stream.length+' >>\nstream\n'+stream+'\nendstream'];
  let pdf='%PDF-1.4\n';const offsets=[0];objects.forEach((object,index)=>{offsets.push(Buffer.byteLength(pdf));pdf+=(index+1)+' 0 obj\n'+object+'\nendobj\n';});const start=Buffer.byteLength(pdf);pdf+='xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(offset=>String(offset).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n'+start+'\n%%EOF';
  const file=path.join(root,'paper.pdf');fs.writeFileSync(file,pdf);await extractAttachmentDocument(file);assert.match(extractedDocumentText(file),/Hello PDF/);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
