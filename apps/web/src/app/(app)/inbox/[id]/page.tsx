import { notFound } from "next/navigation";
import { getConsoleSession } from "@/lib/session";
import { getConversation, getMessages } from "@/lib/api/inbox";
import { ApiError } from "@/lib/api/client";
import { ConversationThread } from "@/components/inbox/conversation-thread";
import { getServerNow } from "@/lib/time";
import type { ConversationDetail, ConversationMessage, Page } from "@/lib/api/inbox";

export const dynamic = "force-dynamic";

async function loadConversationData(
  id: string,
  token: string,
): Promise<{
  detail: ConversationDetail;
  messages: Page<ConversationMessage>;
  now: number;
} | null> {
  try {
    const [detail, messages] = await Promise.all([
      getConversation(id, token),
      getMessages(id, { limit: 30 }, token),
    ]);
    return { detail, messages, now: getServerNow() };
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

export default async function ConversationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await getConsoleSession();
  const data = await loadConversationData(id, session.token);

  if (!data) notFound();

  return (
    <ConversationThread
      conversationId={id}
      detail={data.detail}
      initialMessages={data.messages}
      currentUserId={session.userId}
      isAdmin={session.role === "admin"}
      now={data.now}
    />
  );
}
