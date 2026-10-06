import type { ChannelKind } from '../channel/ports/channel-kind';
import type { CoalescedMediaRef } from '../conversation/coalesced-respond-job.dto';

/** T11's async job boundary payload — enough for an AgentModule worker to run a turn; nothing more. */
export interface RespondPathJobData {
  tenantId: string;
  /** Feature 16: which channel this arrived on. Carried so the reply goes back out the same one. Data for a registry lookup, never a branch. */
  channel: ChannelKind;
  /** The account it arrived on — WhatsApp `phone_number_id`, Facebook page id, or Instagram account id. Carried through so the reply leaves from the same account (WhatsApp: it also selects the per-number access token). */
  channelAccountId: string;
  /** The provider's message id — WhatsApp `wamid.*`, Messenger/Instagram `mid.*`. */
  providerMessageId: string;
  from: string;
  text: string;
  /** F17: set when this message carried an image or voice note the agent is expected to answer. */
  media?: CoalescedMediaRef;
}
