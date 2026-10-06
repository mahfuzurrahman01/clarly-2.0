// Test-only builders for the binary document formats text-extraction.ts
// supports. Generated in-memory rather than checked in as binary blobs: a
// .pdf/.docx/.xlsx in git is unreviewable in a diff, and the repo has no
// binary-fixture convention to follow.
import JSZip from 'jszip';
import * as XLSX from 'xlsx';

/**
 * A single-page, uncompressed PDF containing `text`. Hand-assembled (a PDF
 * writer dependency would be a production dependency added for tests only)
 * with a real xref table, so pdf.js accepts it.
 */
export function buildPdf(text: string): Buffer {
  const stream = `BT /F1 24 Tf 72 720 Td (${escapePdfText(text)}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  const offsets: number[] = [];
  let pdf = '%PDF-1.4\n';
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const startxref = pdf.length;
  const xref = offsets
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${xref}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

/** A .docx (OOXML zip) whose body is one paragraph per entry in `paragraphs`. */
export async function buildDocx(
  paragraphs: readonly string[],
): Promise<Buffer> {
  const body = paragraphs
    .map((p) => `<w:p><w:r><w:t>${escapeXml(p)}</w:t></w:r></w:p>`)
    .join('');

  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  );

  return zip.generateAsync({ type: 'nodebuffer' });
}

/** An .xlsx workbook: one sheet per entry, each a row-major array of cell values. */
export function buildXlsx(
  sheets: ReadonlyArray<{
    name: string;
    rows: ReadonlyArray<ReadonlyArray<string | number>>;
  }>,
): Buffer {
  const workbook = XLSX.utils.book_new();
  for (const sheet of sheets) {
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet(sheet.rows.map((row) => [...row])),
      sheet.name,
    );
  }
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

function escapePdfText(text: string): string {
  return text.replace(/([\\()])/g, '\\$1');
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
