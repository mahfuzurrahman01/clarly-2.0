// A1: the step in front of chunking. `chunkText()` operates on plain text;
// this module is what turns an uploaded file into that plain text. Same
// shape as chunking.ts on purpose — plain exported functions, no DI: there
// is no state, no config, and nothing to inject, so a NestJS provider would
// buy nothing over a direct import (RetrievalIngestService is the only
// caller inside the module; KbDocumentController imports only the
// `isSupportedMimeType` predicate so its upload-time 400 and the worker's
// hard failure can never disagree about what is ingestible).
//
// Deliberately not in scope: OCR. A scanned/image-only PDF extracts to no
// text and is rejected loudly rather than being indexed as an empty
// document the agent can never answer from.
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import * as XLSX from 'xlsx';

export const TEXT_MIME_PREFIX = 'text/';
export const PDF_MIME_TYPE = 'application/pdf';
export const DOCX_MIME_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const XLSX_MIME_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const XLS_MIME_TYPE = 'application/vnd.ms-excel';

/** Exact-match types. `text/*` is matched by prefix instead (see isSupportedMimeType). */
export const SUPPORTED_BINARY_MIME_TYPES: readonly string[] = [
  PDF_MIME_TYPE,
  DOCX_MIME_TYPE,
  XLSX_MIME_TYPE,
  XLS_MIME_TYPE,
];

/** Human-readable form of the same list, for API error messages and Swagger docs. */
export const SUPPORTED_MIME_TYPES_DESCRIPTION =
  'text/*, application/pdf, .docx, .xlsx/.xls';

export function isSupportedMimeType(mimeType: string): boolean {
  return (
    mimeType.startsWith(TEXT_MIME_PREFIX) ||
    SUPPORTED_BINARY_MIME_TYPES.includes(mimeType)
  );
}

/** A file of a supported type that could not be read (corrupt, truncated, wrong type behind a right mimetype, or no extractable text). */
export class TextExtractionError extends Error {
  constructor(
    readonly mimeType: string,
    reason: string,
    options?: { cause?: unknown },
  ) {
    super(`Could not extract text from "${mimeType}": ${reason}`);
    this.name = 'TextExtractionError';
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/**
 * Turns an uploaded file into the plain text that gets chunked and embedded.
 * Throws TextExtractionError for an unsupported type or an unreadable file —
 * never returns partial/garbage text, since the caller has no way to tell the
 * difference once it is chunked.
 */
export async function extractText(
  content: Buffer,
  mimeType: string,
): Promise<string> {
  if (mimeType.startsWith(TEXT_MIME_PREFIX)) {
    return content.toString('utf8');
  }
  if (mimeType === PDF_MIME_TYPE) {
    return requireText(mimeType, await extractPdf(content, mimeType), 'pdf');
  }
  if (mimeType === DOCX_MIME_TYPE) {
    return requireText(mimeType, await extractDocx(content, mimeType), 'docx');
  }
  if (mimeType === XLSX_MIME_TYPE || mimeType === XLS_MIME_TYPE) {
    return requireText(
      mimeType,
      extractSpreadsheet(content, mimeType),
      'spreadsheet',
    );
  }
  throw new TextExtractionError(
    mimeType,
    `unsupported type (supported: ${SUPPORTED_MIME_TYPES_DESCRIPTION})`,
  );
}

const EMPTY_REASONS: Record<string, string> = {
  pdf: 'no extractable text — image-only/scanned PDFs need OCR, which is not supported',
  docx: 'the document contains no text',
  spreadsheet: 'every sheet is empty',
};

/** Binary formats that yield nothing are a failure, not a zero-chunk success: the tenant would otherwise see `ingested` for a document the agent can never answer from. */
function requireText(mimeType: string, text: string, kind: string): string {
  if (text.trim().length === 0) {
    throw new TextExtractionError(
      mimeType,
      EMPTY_REASONS[kind] ?? 'no extractable text',
    );
  }
  return text;
}

async function extractPdf(content: Buffer, mimeType: string): Promise<string> {
  const parser = new PDFParse({ data: content });
  try {
    // pageJoiner: '' drops the default `-- 1 of 3 --` page markers, which
    // would otherwise be chunked and embedded as if they were content.
    const result = await parser.getText({ pageJoiner: '' });
    return result.text;
  } catch (error: unknown) {
    throw new TextExtractionError(mimeType, describe(error), { cause: error });
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

async function extractDocx(content: Buffer, mimeType: string): Promise<string> {
  try {
    const result = await mammoth.extractRawText({ buffer: content });
    return result.value;
  } catch (error: unknown) {
    throw new TextExtractionError(mimeType, describe(error), { cause: error });
  }
}

const ZIP_MAGIC = 'PK';
const OLE2_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0]);

function extractSpreadsheet(content: Buffer, mimeType: string): string {
  // SheetJS falls back to guessing (CSV/plain text) for anything it does not
  // recognise, so arbitrary bytes parse "successfully" into a junk sheet.
  // Requiring the container magic up front turns that into a clean failure.
  if (!looksLikeWorkbook(content)) {
    throw new TextExtractionError(
      mimeType,
      'not a valid .xlsx/.xls file (unrecognised file header)',
    );
  }

  try {
    const workbook = XLSX.read(content, { type: 'buffer' });
    return workbook.SheetNames.map((name) => {
      const sheet = workbook.Sheets[name];
      const csv = sheet ? XLSX.utils.sheet_to_csv(sheet).trim() : '';
      return csv.length > 0 ? `# Sheet: ${name}\n${csv}` : '';
    })
      .filter((section) => section.length > 0)
      .join('\n\n');
  } catch (error: unknown) {
    throw new TextExtractionError(mimeType, describe(error), { cause: error });
  }
}

function looksLikeWorkbook(content: Buffer): boolean {
  return (
    content.subarray(0, 2).toString('latin1') === ZIP_MAGIC ||
    content.subarray(0, 4).equals(OLE2_MAGIC)
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unreadable file';
}
