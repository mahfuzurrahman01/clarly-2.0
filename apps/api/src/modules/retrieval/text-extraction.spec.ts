// NOTE: the PDF cases need `NODE_OPTIONS=--experimental-vm-modules` (already
// set on every `test*` script in package.json). pdf.js loads its worker via a
// dynamic `import()`, which Jest's default CJS VM cannot service — plain
// `npx jest` will fail these two cases with "A dynamic import callback was
// invoked without --experimental-vm-modules". Production is unaffected.
import { buildDocx, buildPdf, buildXlsx } from './__fixtures__/documents';
import {
  DOCX_MIME_TYPE,
  PDF_MIME_TYPE,
  TextExtractionError,
  XLSX_MIME_TYPE,
  XLS_MIME_TYPE,
  extractText,
  isSupportedMimeType,
} from './text-extraction';

describe('isSupportedMimeType()', () => {
  it.each([
    'text/plain',
    'text/markdown',
    'text/csv',
    PDF_MIME_TYPE,
    DOCX_MIME_TYPE,
    XLSX_MIME_TYPE,
    XLS_MIME_TYPE,
  ])('accepts %s', (mimeType) => {
    expect(isSupportedMimeType(mimeType)).toBe(true);
  });

  it.each([
    'image/png',
    'application/zip',
    'application/octet-stream',
    'application/msword',
  ])('rejects %s', (mimeType) => {
    expect(isSupportedMimeType(mimeType)).toBe(false);
  });
});

describe('extractText() — text/*', () => {
  it('passes the bytes through as utf8', async () => {
    await expect(
      extractText(Buffer.from('Refunds take 5 days.', 'utf8'), 'text/plain'),
    ).resolves.toBe('Refunds take 5 days.');
  });

  // Unlike the binary formats, an empty text file is not an extraction
  // failure — it chunks to zero chunks, which is what it always did.
  it('returns empty string for an empty text file rather than throwing', async () => {
    await expect(extractText(Buffer.from(''), 'text/plain')).resolves.toBe('');
  });
});

describe('extractText() — application/pdf', () => {
  it('extracts the page text', async () => {
    const text = await extractText(
      buildPdf('Refunds are processed within 5 business days.'),
      PDF_MIME_TYPE,
    );

    expect(text).toContain('Refunds are processed within 5 business days.');
  });

  it('does not include pdf-parse page-boundary markers in the extracted text', async () => {
    const text = await extractText(buildPdf('Shipping is free'), PDF_MIME_TYPE);

    expect(text).not.toMatch(/-- \d+ of \d+ --/);
  });

  it('throws TextExtractionError on a corrupt file', async () => {
    await expect(
      extractText(Buffer.from('%PDF-1.4 not really a pdf'), PDF_MIME_TYPE),
    ).rejects.toBeInstanceOf(TextExtractionError);
  });
});

describe('extractText() — docx', () => {
  it('extracts every paragraph', async () => {
    const text = await extractText(
      await buildDocx(['Warranty is 12 months.', 'Extendable to 24 months.']),
      DOCX_MIME_TYPE,
    );

    expect(text).toContain('Warranty is 12 months.');
    expect(text).toContain('Extendable to 24 months.');
  });

  it('throws TextExtractionError on a file that is not a docx zip', async () => {
    await expect(
      extractText(Buffer.from('definitely not a docx'), DOCX_MIME_TYPE),
    ).rejects.toBeInstanceOf(TextExtractionError);
  });

  it('throws TextExtractionError on a docx with no text', async () => {
    await expect(
      extractText(await buildDocx([]), DOCX_MIME_TYPE),
    ).rejects.toThrow(/contains no text/);
  });
});

describe('extractText() — spreadsheets', () => {
  it('renders each sheet as a labelled CSV block', async () => {
    const text = await extractText(
      buildXlsx([
        {
          name: 'Prices',
          rows: [
            ['SKU', 'Price'],
            ['A1', 1050],
          ],
        },
        {
          name: 'Stock',
          rows: [
            ['SKU', 'Qty'],
            ['A1', 3],
          ],
        },
      ]),
      XLSX_MIME_TYPE,
    );

    expect(text).toBe(
      '# Sheet: Prices\nSKU,Price\nA1,1050\n\n# Sheet: Stock\nSKU,Qty\nA1,3',
    );
  });

  it('accepts the legacy .xls mime type', async () => {
    const text = await extractText(
      buildXlsx([{ name: 'Prices', rows: [['SKU'], ['A1']] }]),
      XLS_MIME_TYPE,
    );

    expect(text).toContain('# Sheet: Prices');
  });

  // SheetJS silently falls back to CSV-guessing for unrecognised bytes, which
  // would index junk as if it were content.
  it('throws TextExtractionError on bytes that are not a workbook', async () => {
    await expect(
      extractText(Buffer.from('not a spreadsheet'), XLSX_MIME_TYPE),
    ).rejects.toThrow(/unrecognised file header/);
  });

  it('throws TextExtractionError when every sheet is empty', async () => {
    await expect(
      extractText(buildXlsx([{ name: 'Empty', rows: [] }]), XLSX_MIME_TYPE),
    ).rejects.toThrow(/every sheet is empty/);
  });
});

describe('extractText() — unsupported', () => {
  it('throws TextExtractionError naming the supported types', async () => {
    await expect(extractText(Buffer.from('x'), 'image/png')).rejects.toThrow(
      /unsupported type/,
    );
  });
});
