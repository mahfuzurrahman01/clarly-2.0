# F27 Gulf Arabic corpora — what they measure, and what they do not

Four corpora test the agent's ability to handle Gulf Arabic dialects:
`gulf-arabic-khaleeji`, `gulf-arabic-egyptian`, `gulf-arabic-levantine`,
`gulf-arabic-arabizi`. They exist because the Gulf retail market has large
customer bases that speak these dialects, and the agent must reply in the
customer's register (dialect in → dialect out, MSA only when asked).

## Dialect coverage

| Corpus | Dialect | Region | Key markers |
|---|---|---|---|
| `gulf-arabic-khaleeji` | Gulf Arabic (Khaleeji) | Saudi, UAE, Kuwait, Qatar, Bahrain, Oman | شنو (what), وين (where), دز (send), عندكم (do you have) |
| `gulf-arabic-egyptian` | Egyptian Arabic | Egypt (large expat community in Gulf) | بكام (how much), فين (where), ايه (what), ايوة (yes) |
| `gulf-arabic-levantine` | Levantine Arabic | Syria, Lebanon, Jordan, Palestine (large expat community) | شو (what), وين (where), بدنا (we want), عم (progressive) |
| `gulf-arabic-arabizi` | Arabizi (Latin-script Arabic) | All regions, youth demographic | 3=ع, 7=ح, 9=ق, shnu, wayn, abii |

## What each case tests

Each case in the `cases.json` files follows the same structure as existing
corpora (`language-mix`, `comment-intent`):

- **`question`**: the customer's message in the target dialect
- **`expect`**: `resolve` (KB supports an answer), `escalate` (KB does not), or `any`
- **`mustContain`**: substrings the answer must include (price, warranty period, etc.)
- **`mustNotContain`**: guardrails against hallucination (e.g., inventing store locations)
- **`expectEscalationReason`**: for complaints, the expected escalation reason
- **`note`**: why this case exists, for diagnosing failures

### Case categories

1. **Product questions** (price, material, compatibility) — 5-7 cases per corpus
2. **Service questions** (delivery, warranty, returns, hours) — 4-5 cases per corpus
3. **Purchase flow** (ordering, payment, link request) — 3-4 cases per corpus
4. **Complaints** (damaged, delayed, wrong order) — 4 cases per corpus

Total: 20 cases × 4 corpora = 80 cases.

## What this does NOT establish

- **Arabic reply quality.** These cases measure whether the agent can
  *understand* a dialect question and produce a factually correct answer.
  They do not measure whether the reply *sounds natural* in the dialect —
  that requires human review of the output, or a separate LLM-judge pass.

- **ASR accuracy on Gulf Arabic.** The cases are text-only. Voice notes in
  Gulf Arabic dialects need a separate evaluation (WER per dialect) once
  ASR coverage extends beyond MSA. The current HuggingFace ASR
  (`openai/whisper-large-v3`) has known gaps on Gulf dialects.

- **Code-switching resilience.** Some Arabizi cases mix Arabic and English
  ("fi guarantee?"), but the code-switching depth is shallow. Real Gulf
  conversations often switch mid-sentence. This is a gap for future work.

- **Full dialect coverage.** Each dialect has 20 cases. A production eval
  would need 50-100+ cases per dialect to produce stable accuracy numbers.
  These corpora are a baseline, not a comprehensive benchmark.

## Running the corpora

```bash
# From apps/api/
npx ts-node --files -r tsconfig-paths/register eval/runner.ts \
  --corpus gulf-arabic-khaleeji \
  --corpus gulf-arabic-egyptian \
  --corpus gulf-arabic-levantine \
  --corpus gulf-arabic-arabizi
```

Or use the npm scripts:

```bash
pnpm eval:golden-set  # includes all corpora
```

## Design decisions

- **20 cases per dialect** — enough to catch regressions, small enough to
  author by hand. Scale up with pilot traffic.

- **4 complaint cases per dialect** — complaints are the highest-value
  escalation path; a missed escalation at scale is worse than a false
  escalation.

- **No multi-turn cases yet** — the existing multi-turn corpus covers
  context handling. These dialect corpora focus on single-turn dialect
  comprehension.

- **Arabizi uses standard transliteration** — not every user types the same
  way, but the transliteration follows the most common Gulf pattern (3=ع,
  7=ح, 9=ق). Dialect-specific variations can be added as pilot traffic
  reveals them.
