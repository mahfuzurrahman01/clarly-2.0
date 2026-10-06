import { apiFetch, ApiError, browserApiFetch } from "./client";

export const KB_DOCUMENT_STATUSES = [
  "uploaded",
  "ingest_queued",
  "ingested",
  "failed",
] as const;
export type KbDocumentStatus = (typeof KB_DOCUMENT_STATUSES)[number];

export type KbDocument = {
  id: string;
  tenantId: string;
  filename: string;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  status: KbDocumentStatus;
};

/** Upload constraints mirror the backend (text/*, PDF, DOCX, XLSX/XLS, 10MB) so we fail fast. */
export const KB_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * Browsers report an empty `file.type` for `.md`/`.csv`/etc, and FormData then
 * sends the part as `application/octet-stream` — which the backend's `text/*`
 * check rejects. Resolve a concrete type from the extension (falling back to
 * the browser's type when it's already text/* or a supported binary type), so
 * we can both validate correctly and stamp the multipart part's Content-Type.
 * Returns null when the file isn't a supported format. Keep in sync with
 * apps/api/src/modules/retrieval/text-extraction.ts's SUPPORTED_MIME_TYPES.
 */
const TEXT_EXTENSIONS: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "text/plain",
  log: "text/plain",
  html: "text/html",
  htm: "text/html",
  xml: "text/xml",
  yaml: "text/plain",
  yml: "text/plain",
};

const BINARY_EXTENSIONS: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
};

const SUPPORTED_BINARY_MIME_TYPES = new Set(Object.values(BINARY_EXTENSIONS));

export function resolveKbMime(file: File): string | null {
  if (file.type.startsWith("text/")) return file.type;
  if (SUPPORTED_BINARY_MIME_TYPES.has(file.type)) return file.type;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return TEXT_EXTENSIONS[ext] ?? BINARY_EXTENSIONS[ext] ?? null;
}

export function listKbDocuments(token?: string) {
  const path = "/knowledge-base/documents";
  return token
    ? apiFetch<KbDocument[]>(path, { token })
    : browserApiFetch<KbDocument[]>(path);
}

export function deleteKbDocument(id: string) {
  return browserApiFetch<{ ok: true }>(`/knowledge-base/documents/${id}`, {
    method: "DELETE",
  });
}

/**
 * Multipart upload — can't go through `apiFetch` (json-only). Pulls the browser
 * session token and posts a FormData with a single `file` part. Lets the browser
 * set the multipart boundary; setting Content-Type manually would break it.
 */
export async function uploadKbDocument(file: File): Promise<KbDocument> {
  const { createClient } = await import("@/lib/supabase/client");
  const {
    data: { session },
  } = await createClient().auth.getSession();
  if (!session) throw new ApiError(401, "Not signed in");

  // Stamp a concrete text/* type on the part — the browser sends octet-stream
  // for .md/.csv otherwise, which the backend rejects.
  const mime = resolveKbMime(file);
  const part = mime ? new File([file], file.name, { type: mime }) : file;

  const form = new FormData();
  form.append("file", part);

  const base = process.env.NEXT_PUBLIC_API_URL!;
  const res = await fetch(`${base}/knowledge-base/documents`, {
    method: "POST",
    headers: { Authorization: `Bearer ${session.access_token}` },
    body: form,
  });

  if (!res.ok) {
    let message = `Upload failed (${res.status})`;
    try {
      const data = (await res.json()) as { message?: string | string[] };
      const m = Array.isArray(data.message) ? data.message.join(", ") : data.message;
      if (m) message = m;
    } catch {
      // keep the fallback
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as KbDocument;
}
