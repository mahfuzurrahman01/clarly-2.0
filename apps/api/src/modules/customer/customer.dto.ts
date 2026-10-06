import type { ChannelKind } from '../channel/ports/channel-kind';

export interface CustomerRecord {
  id: string;
  tenantId: string;
  /** Feature 16: which channel this identity belongs to. */
  channel: ChannelKind;
  /** The channel-scoped identity — a phone number on WhatsApp, a PSID/IGSID on the Meta social channels. */
  phone: string;
  name: string | null;
  tags: string[];
  notes: string | null;
}

export interface UpdateCustomerInput {
  name?: string | null;
  tags?: string[];
  notes?: string | null;
}
