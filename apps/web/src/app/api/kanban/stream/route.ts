import { createClient } from "@/lib/supabase/server";

// The browser's EventSource can't attach an Authorization header, so the board
// subscribes to this same-origin route instead; here we inject the bearer token
// server-side and pipe the API's SSE stream straight back.
export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  const upstream = await fetch(
    `${process.env.NEXT_PUBLIC_API_URL}/kanban/tickets/stream`,
    {
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        Accept: "text/event-stream",
      },
      cache: "no-store",
    },
  );

  if (!upstream.ok || !upstream.body) {
    return new Response("Upstream stream unavailable", { status: 502 });
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
