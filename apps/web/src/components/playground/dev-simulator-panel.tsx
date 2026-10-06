"use client";

import { useState } from "react";
import { FlaskConical, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useTranslations } from "@/lib/i18n/provider";

type SimulatorState =
  | { status: "idle" }
  | { status: "sending" }
  | { status: "sent" }
  | { status: "error"; message: string };

const ENV_VAR = "DEV_SIMULATOR_PHONE_NUMBER_ID";

/**
 * Dev-only (P5 demo loop): posts a message through the real signed webhook
 * path (POST /api/dev-simulator -> API's POST /webhooks/whatsapp), not the
 * Playground's direct sandbox call. Proves signature verification, tenant
 * resolution by phone_number_id, and ticket creation on escalation — none of
 * which the sandbox path exercises. Only rendered when the server confirmed
 * DEV_SIMULATOR_ENABLED, so no extra runtime gating is needed here.
 */
export function DevSimulatorPanel() {
  const t = useTranslations();
  const [customerPhone, setCustomerPhone] = useState("15550001234");
  const [message, setMessage] = useState(t.playground.simulatorDefaultMessage);
  const [state, setState] = useState<SimulatorState>({ status: "idle" });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setState({ status: "sending" });
    try {
      const res = await fetch("/api/dev-simulator", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerPhone, message }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          body.error ??
            t.playground.simulatorFailedTemplate.replace("{status}", String(res.status)),
        );
      }
      setState({ status: "sent" });
    } catch (err) {
      setState({
        status: "error",
        message: err instanceof Error ? err.message : t.playground.simulatorFailed,
      });
    }
  }

  const [before, after = ""] = t.playground.simulatorBody.split("{envVar}");

  return (
    <Card className="mt-8 border-dashed">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <FlaskConical className="size-4 text-muted-foreground" aria-hidden="true" />
          {t.playground.simulatorTitle}
        </CardTitle>
        <CardDescription>
          {before}
          <code className="text-xs" dir="ltr">
            {ENV_VAR}
          </code>
          {after}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-[200px_1fr]">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sim-phone">{t.playground.simulatorPhone}</Label>
              <Input
                id="sim-phone"
                dir="ltr"
                inputMode="tel"
                value={customerPhone}
                onChange={(e) => setCustomerPhone(e.target.value)}
                required
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sim-message">{t.playground.simulatorMessage}</Label>
              <Input
                id="sim-message"
                dir="auto"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                required
              />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Button type="submit" size="sm" disabled={state.status === "sending"}>
              {state.status === "sending" ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  {t.playground.simulatorSending}
                </>
              ) : (
                t.playground.simulatorSend
              )}
            </Button>
            {state.status === "sent" && (
              <span role="status" className="text-sm text-muted-foreground">
                {t.playground.simulatorSent}
              </span>
            )}
            {state.status === "error" && (
              <span role="alert" className="text-sm text-destructive">
                {state.message}
              </span>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
