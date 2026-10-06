# Project Instructions

Clarly 2.0 — AI customer-service and sales agent SaaS (WhatsApp, Messenger, Instagram, website widget). Turborepo monorepo: `apps/api` (NestJS backend + workers), `apps/web` (Next.js console + public site), `packages/*` shared.

## Clarly 2.0 (read first)

v2 merges Autologic (TellMore AI) features onto this engine. The v2 source of truth for architecture, decisions and build order is [docs/v2/](./docs/v2/README.md): ARCHITECTURE.md, FEATURE_MATRIX.md (stages S0-S9), CONFLICTS.md, BUILD_LOG.md. Every v2 stage appends to BUILD_LOG.md AND to docs/HANDOFF.md. The v1 plan files referenced below were deleted in `834c0b6`; read them from git history when a D#/F#/T# reference needs its spec.

## Product Goals (read first)

[docs/PRODUCT_GOALS.md](./docs/PRODUCT_GOALS.md) defines what Clarly must achieve: 12 goals, each with a measurable **done-when** bar and current status. Measure work against it:

- A goal counts as achieved only when its bar is met with real calls (evals, live channels) — code being written or unit tests passing does not count. Never report a feature as "done" or "working" without that evidence.
- When work moves a goal (new eval results, a live test, a fix that changes a bar), update that goal's "Where we are" and status marker in the same change.
- How each bar is tested lives in [docs/AGENT_LIVE_TEST_PLAN.md](./docs/AGENT_LIVE_TEST_PLAN.md) (layers L0-L8).

Plans: [docs/GULF_PARITY_PLAN.md](./docs/GULF_PARITY_PLAN.md) is the sole source of truth for build sequencing and architecture decisions (D1-D16), phase-by-phase (it replaced the former FEATURE_PLAN.md and LAUNCH_PLAN.md on 2026-09-19, and superseded BACKEND_PLAN.md/AI_PIPELINE_PLAN.md/FRONTEND_PLAN.md, removed 2026-09-21). [TODOS.md](./TODOS.md) tracks deferred work with unblock gates — check it before assuming something is missing rather than deliberately deferred. [docs/HANDOFF.md](./docs/HANDOFF.md) is the shipped-work log with endpoints/contracts/env vars. Login credentials for the seeded demo tenant (`admin@zenith.test`, `agent@zenith.test`) are in [docs/SEED_CREDENTIALS.md](./docs/SEED_CREDENTIALS.md) — committed deliberately, test accounts only.

## Backend → Frontend Handoff (MANDATORY)

Frontend and backend are worked on separately. The frontend team does not read backend task lists or source to learn what's ready — they read [docs/HANDOFF.md](./docs/HANDOFF.md).

**Every time a backend task (T0-T20, AI pipeline A0-A10, or any ad-hoc backend change) is completed, before marking it done:**

1. Append an entry to `docs/HANDOFF.md` following the format at the top of that file — endpoints shipped, request/response shapes, auth requirements, env vars, and what's still stubbed/mocked.
2. If the change breaks or alters a contract from a prior entry, call that out explicitly under "Breaking changes" in the new entry — don't silently edit the old one away.
3. Keep entries scoped to one backend task each; don't batch multiple tasks into one entry.

This applies whether the backend work was done in this session or delegated to a subagent — the handoff entry is part of the task, not a follow-up.

## Engineering Principles

- Always follow best practice for the language/framework in use — don't cut corners for expedience.
- Read the relevant documentation (library docs, API references, the D1-D16/T#/F# specs in GULF_PARITY_PLAN.md) before implementing — don't guess at behavior or contracts.
- Follow SOLID and DRY: single-responsibility modules, no duplicated logic across modules — extract and share instead.
