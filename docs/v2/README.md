# Clarly 2.0 docs

**Picking this up? Start with [HANDOVER.md](./HANDOVER.md).**

Clarly 2.0 merges **Autologic** (TellMore AI, the feature base) onto **Clarly v1** (the engine
and the UI). Start here:

| Doc | What it answers |
|---|---|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | How the system is built and why Clarly is the engine |
| [FEATURE_MATRIX.md](./FEATURE_MATRIX.md) | Every feature from both products: kept, ported, merged or deferred, plus build stages |
| [CONFLICTS.md](./CONFLICTS.md) | Where the products disagreed, what was decided, what the owner must decide |
| [AUTOLOGIC_AUDIT.md](./AUTOLOGIC_AUDIT.md) | Production weaknesses found in Autologic |
| [CLARLY_AUDIT.md](./CLARLY_AUDIT.md) | Production weaknesses found in Clarly v1 |
| [SCALING_1K.md](./SCALING_1K.md) | Load model, infrastructure, ordered steps and budget for 1,000 subscribers |
| [MANUAL_STEPS.md](./MANUAL_STEPS.md) | Environment variables and the tasks only the owner can do |
| [BUILD_LOG.md](./BUILD_LOG.md) | What each v2 stage shipped and how it was verified |

v1 history: `docs/HANDOFF.md` (every backend contract), `docs/PRODUCT_GOALS.md`,
`docs/PRODUCT_OVERVIEW.md`. v1 plans deleted in `834c0b6` are recoverable with
`git show 834c0b6^:docs/GULF_PARITY_PLAN.md`.
