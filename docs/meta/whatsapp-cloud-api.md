# WhatsApp Cloud API — Overview

> Source: https://developers.facebook.com/documentation/business-messaging/whatsapp/about-the-platform , https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started , https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/message-api — fetched 2026-09-26

## What it is

Cloud API is Meta-hosted (no self-hosted On-Premises servers needed). It replaced the On-Premises API entirely — **the On-Premises API's final client expired 2025-10-23 and can no longer send messages.** Any legacy on-prem integration in this codebase must already be gone or must be migrated.

Cloud API throughput: up to 1,000 msg/sec, 99.9% uptime, <5s p99 latency.

## Current API version

The example endpoints in the current docs use **Graph API v23.0**. Always check `apps/api/src/modules/meta-graph/` for the pinned version constant and bump deliberately — Meta deprecates old Graph API versions on a rolling ~2-year schedule (check the WhatsApp changelog: https://developers.facebook.com/documentation/business-messaging/whatsapp/changelog).

## Core concepts

- **WABA (WhatsApp Business Account) ID** — the account container that owns phone numbers, templates, and quality/messaging-limit state.
- **Phone Number ID** — the specific business number sending/receiving; this, not the raw MSISDN, is what you address in API calls.
- **System User access token** — for production, use a permanent token issued to a system user (not a short-lived user token from the App Dashboard "temporary token" flow, which is for testing only).
- **Customer Service Window (24h)** — opens when a customer messages you; only inside this window can you send free-form (non-template) messages. Outside it, you must use an approved template message.

## Setup steps

1. Create a Meta app with the WhatsApp use case in App Dashboard.
2. Connect/create a WABA (directly, or via Embedded Signup for multi-tenant SaaS — see `embedded-signup.md`).
3. Generate a system-user permanent access token.
4. Configure and verify the webhook endpoint (see `webhooks.md`).
5. Send a test message, confirm delivery/status webhooks arrive.

## Required permissions (system user / app)

- `whatsapp_business_messaging` — send/receive messages, subscribe to `messages` webhook field.
- `whatsapp_business_management` — manage WABA settings, phone numbers, message templates; required for all webhook fields other than `messages`.
- `business_management` — needed to manage the underlying Business Portfolio / system users.

## Sending messages

Endpoint: `POST https://graph.facebook.com/v23.0/<PHONE_NUMBER_ID>/messages`

Two message classes:
- **Template messages** — pre-approved, required outside the 24h window and for any proactive/marketing send. See `message-templates.md`.
- **Session (non-template) messages** — free-form text/media/interactive messages, only within the 24h customer service window.

## Media handling

Media (images, documents, audio, video, stickers) is uploaded to Meta first via the `/media` endpoint, returning a `media_id`; you then reference that `media_id` in the message payload rather than sending raw bytes inline. Media URLs from Meta are time-limited and require the access token to fetch — don't persist them as permanent links; download and store in your own storage if you need durability.

## Gotchas / implementation notes

- Message delivery order across concurrent API calls is **not guaranteed** — don't assume in-order arrival for status tracking.
- Rate limits and messaging limits (per-day unique-recipient tiers) scale with phone number quality rating and are separate from template quality rating — check both when diagnosing throttling.
- Groups and Calling are newer Cloud API capabilities (calling docs: https://developers.facebook.com/documentation/business-messaging/whatsapp/calling) — not required for baseline messaging but worth knowing exist if scope expands.

## Sources

- https://developers.facebook.com/documentation/business-messaging/whatsapp/about-the-platform
- https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started
- https://developers.facebook.com/documentation/business-messaging/whatsapp/reference/whatsapp-business-phone-number/message-api
- https://developers.facebook.com/documentation/business-messaging/whatsapp/changelog
- https://developers.facebook.com/docs/whatsapp/on-premises/sunset
