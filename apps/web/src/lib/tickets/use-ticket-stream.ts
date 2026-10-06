"use client";

import { useEffect, useRef, useState } from "react";
import type { TicketBase } from "@/lib/api/kanban";

/**
 * Subscribes to the board's SSE feed (via the same-origin proxy that injects
 * the bearer token). Each event is a base ticket record — patch it onto board
 * state, don't treat it as a full ticket. EventSource auto-reconnects, so the
 * `connected` flag drives the "stream offline" badge.
 */
export function useTicketStream(onTicket: (ticket: TicketBase) => void) {
  const [connected, setConnected] = useState(false);
  const handler = useRef(onTicket);

  useEffect(() => {
    handler.current = onTicket;
  }, [onTicket]);

  useEffect(() => {
    const source = new EventSource("/api/kanban/stream");

    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (event) => {
      try {
        handler.current(JSON.parse(event.data) as TicketBase);
      } catch {
        // Ignore malformed frames; the next good one recovers state.
      }
    };

    return () => source.close();
  }, []);

  return connected;
}
