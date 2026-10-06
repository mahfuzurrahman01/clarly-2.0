// T10/D8: "two distinct messages arriving ~1.5s apart... would otherwise
// trigger two concurrent LLM runs, two replies... Fix:... a ~1.5s debounce
// window coalescing consecutive inbound messages into one turn."
//
// Trailing-edge debounce built directly on BullMQ's own delayed-job
// machinery — no separate Redis buffer needed, the job's own `data` IS the
// buffer (`Job.updateData()`), and the job's own delay IS the debounce
// timer (`Job.changeDelay()`). A small Redis string (`QUEUE_REDIS_CONNECTION`,
// already used elsewhere — see WebhookRateLimiterService) tracks "which
// job id is the current window for this conversation," self-expiring so a
// lost/gone job never wedges a conversation into never starting a fresh
// window.
//
// Each debounce window gets a FRESH, unique jobId (`coalesce-<key>-<uuid>`)
// rather than one static jobId reused forever — reusing one static id would
// race BullMQ's own duplicate-jobId handling if a message arrived at the
// exact moment the previous window's job transitioned out of 'delayed'
// (e.g. into 'active'), a narrow but real window this design avoids
// entirely rather than trying to detect.
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import type Redis from 'ioredis';
import { AppConfigService } from '../core';
import {
  QUEUE_REDIS_CONNECTION,
  RESPOND_PATH_QUEUE,
} from '../queue/queue.providers';
import { buildConversationKey } from './conversation-key';
import { type ChannelKind } from '../channel/ports/channel-kind';
import type {
  CoalescedMediaRef,
  CoalescedMessage,
  CoalescedRespondJobData,
} from './coalesced-respond-job.dto';

/** How long past the debounce window the Redis tracker key survives — a safety margin so a slow-to-process job doesn't have its tracker expire while still legitimately "current." */
const TRACKER_SAFETY_MARGIN_SECONDS = 30;

export interface InboundMessage {
  tenantId: string;
  /** Feature 16: the channel this arrived on. Part of the coalescing/lock key — see buildConversationKey. */
  channel: ChannelKind;
  /** The channel account it arrived on: WhatsApp `phone_number_id`, Facebook page id, or Instagram account id. */
  channelAccountId: string;
  from: string;
  providerMessageId: string;
  text: string;
  /** F17: an image/voice message's stored attachment, carried through the debounce window with its message so a burst of "photo, then 'how much?'" is still one turn. */
  media?: CoalescedMediaRef;
}

@Injectable()
export class BurstCoalescingService {
  constructor(
    @InjectQueue(RESPOND_PATH_QUEUE)
    private readonly queue: Queue<CoalescedRespondJobData>,
    @Inject(QUEUE_REDIS_CONNECTION) private readonly redis: Redis,
    private readonly config: AppConfigService,
  ) {}

  async recordMessage(message: InboundMessage): Promise<void> {
    const conversationKey = buildConversationKey(
      message.tenantId,
      message.from,
      message.channel,
    );
    const trackerKey = `coalesce:tracker:${conversationKey}`;
    const debounceMs = this.config.burstCoalesceDebounceMs;

    const currentJobId = await this.redis.get(trackerKey);
    if (currentJobId) {
      const existing = await this.queue.getJob(currentJobId);
      if (existing && (await existing.isDelayed())) {
        await existing.updateData({
          ...existing.data,
          messages: [...existing.data.messages, toCoalescedMessage(message)],
        });
        await existing.changeDelay(debounceMs);
        await this.redis.expire(trackerKey, secondsFor(debounceMs));
        return;
      }
      // Tracked job is no longer delayed (already picked up for
      // processing, or gone) — fall through and start a fresh window.
    }

    // BullMQ rejects custom job ids containing ':' (reserved as its own
    // Redis key delimiter) — the tracker key above is a plain Redis key
    // (colons are idiomatic there) but this jobId is not, hence the
    // different separator.
    const newJobId = `coalesce-${conversationKey.replace(/:/g, '_')}-${randomUUID()}`;
    await this.queue.add(
      'respond',
      {
        tenantId: message.tenantId,
        channel: message.channel,
        channelAccountId: message.channelAccountId,
        from: message.from,
        messages: [toCoalescedMessage(message)],
      },
      { jobId: newJobId, delay: debounceMs },
    );
    await this.redis.set(trackerKey, newJobId, 'EX', secondsFor(debounceMs));
  }
}

/** One place that decides what of an inbound message survives into the coalesced job — so a new field is never carried in one branch and dropped in the other. */
function toCoalescedMessage(message: InboundMessage): CoalescedMessage {
  return {
    providerMessageId: message.providerMessageId,
    text: message.text,
    ...(message.media ? { media: message.media } : {}),
  };
}

function secondsFor(debounceMs: number): number {
  return Math.ceil(debounceMs / 1000) + TRACKER_SAFETY_MARGIN_SECONDS;
}
