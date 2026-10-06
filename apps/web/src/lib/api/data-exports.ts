import { ApiError, apiFetch, browserApiFetch } from "./client";

export type DataExportStatus = "pending" | "running" | "ready" | "failed";

export type DataExportRecord = {
  id: string;
  status: DataExportStatus;
  requestedBy: string;
  rowCounts: Record<string, number> | null;
  sizeBytes: number | null;
  error: string | null;
  expiresAt: string | null;
  createdAt: string;
  completedAt: string | null;
};

export function requestDataExport() {
  return browserApiFetch<DataExportRecord>("/data-exports", { method: "POST" });
}

export function listDataExports(token?: string) {
  const path = "/data-exports";
  return token
    ? apiFetch<DataExportRecord[]>(path, { token })
    : browserApiFetch<DataExportRecord[]>(path);
}

export function getDataExport(id: string) {
  return browserApiFetch<DataExportRecord>(`/data-exports/${id}`);
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL!;

/** Fetches the bundle as a blob and triggers a browser download — the route needs a bearer token, so a plain <a href> can't reach it. */
export async function downloadDataExport(id: string, filenameFallback: string) {
  const { createClient } = await import("@/lib/supabase/client");
  const {
    data: { session },
  } = await createClient().auth.getSession();
  if (!session) throw new ApiError(401, "Not signed in");

  const res = await fetch(`${API_BASE}/data-exports/${id}/download`, {
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const data = (await res.json()) as { message?: string | string[] };
      message = Array.isArray(data.message) ? data.message.join(", ") : (data.message ?? message);
    } catch {
      // Non-JSON error body — keep the generic message.
    }
    throw new ApiError(res.status, message);
  }

  const disposition = res.headers.get("Content-Disposition");
  const match = disposition?.match(/filename="([^"]+)"/);
  const filename = match?.[1] ?? filenameFallback;

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
