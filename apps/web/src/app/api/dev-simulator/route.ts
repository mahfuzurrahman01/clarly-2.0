import { createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

// P5 demo loop: posts a correctly signed inbound WhatsApp webhook to the API
// so the full agent pipeline (ingest -> agent run -> reply/escalation ->
// ticket) is observable without a live WhatsApp number. Server-only route:
// DEV_SIMULATOR_APP_SECRET must never reach the browser bundle, and this is
// the one place that signs with it. Disabled outright in production builds,
// and admin-only even in dev, since it fires a real inbound message into the
// signed-off tenant pipeline (agent run, possible ticket, real outbound send).
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  customerPhone: z.string().min(6).max(20),
  message: z.string().min(1).max(2000),
});

export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const enabled = process.env.DEV_SIMULATOR_ENABLED === "true";
  const secret = process.env.DEV_SIMULATOR_APP_SECRET;
  const phoneNumberId = process.env.DEV_SIMULATOR_PHONE_NUMBER_ID;
  if (!enabled || !secret || !phoneNumberId) {
    return Response.json(
      { error: "Simulator disabled or misconfigured" },
      { status: 404 },
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const role = user.app_metadata?.app_role;
  if (role !== "admin") {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const parsed = bodySchema.safeParse(await request.json());
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { customerPhone, message } = parsed.data;

  const envelope = {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: phoneNumberId },
              messages: [
                {
                  from: customerPhone,
                  id: `wamid.sim-${randomUUID()}`,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body: message },
                },
              ],
            },
          },
        ],
      },
    ],
  };
  const rawBody = JSON.stringify(envelope);
  const signature = createHmac("sha256", secret).update(rawBody).digest("hex");

  const upstream = await fetch(
    `${process.env.NEXT_PUBLIC_API_URL}/webhooks/whatsapp`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": `sha256=${signature}`,
      },
      body: rawBody,
      cache: "no-store",
    },
  );

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => "");
    return Response.json(
      { error: "Webhook rejected", status: upstream.status, detail },
      { status: 502 },
    );
  }

  return Response.json({ received: true });
}
