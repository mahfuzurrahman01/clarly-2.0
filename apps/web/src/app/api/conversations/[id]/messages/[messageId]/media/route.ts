import { createClient } from "@/lib/supabase/server";

// Same-origin proxy for inbound media bytes. The API requires a bearer token
// and deliberately serves attachments with `Content-Disposition: attachment` +
// `nosniff`; we inject the token and preserve those headers. The console fetches
// this as a blob and decides itself whether to render — never points <img src>
// straight at attacker-influenced bytes.
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; messageId: string }> },
) {
  const { id, messageId } = await params;

  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  const upstream = await fetch(
    `${process.env.NEXT_PUBLIC_API_URL}/conversations/${id}/messages/${messageId}/media`,
    {
      headers: { Authorization: `Bearer ${session.access_token}` },
      cache: "no-store",
    },
  );

  if (!upstream.ok || !upstream.body) {
    return new Response("Media not available", { status: upstream.status });
  }

  const headers = new Headers();
  const contentType = upstream.headers.get("content-type");
  const disposition = upstream.headers.get("content-disposition");
  if (contentType) headers.set("Content-Type", contentType);
  if (disposition) headers.set("Content-Disposition", disposition);
  headers.set("X-Content-Type-Options", "nosniff");

  return new Response(upstream.body, { status: 200, headers });
}
