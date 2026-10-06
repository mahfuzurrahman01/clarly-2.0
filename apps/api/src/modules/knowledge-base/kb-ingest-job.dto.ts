// Feature 2.5's "KB ingest job contract" architect deliverable — shared
// with Feature 3's A1 pipeline (the real consumer) and Feature 6's later
// UI wrapper (docs/decisions/F2.5-kb-foundation.md). Whatever chunking/embedding A1 builds
// reads a job of exactly this shape from the `kb-ingest` queue.
export interface KbIngestJobData {
  tenantId: string;
  kbDocumentId: string;
  storageKey: string;
  filename: string;
  mimeType: string;
}
