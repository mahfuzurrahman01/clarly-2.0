// Shared: the schema every timestamp field in an HTTP response contract uses.
//
// `z.date()` is the obvious spelling, but nestjs-zod's zod-v3 conversion path
// has no `ZodDate` branch — it emits `{}`, an untyped hole, which silently
// erased the type of every timestamp in the generated OpenAPI document
// (`createdAt`, `claimedAt`, `periodStart`, `trialEndsAt`, ...).
//
// This spelling describes the same value truthfully from both sides: an ISO-8601
// string is what actually crosses the wire (Nest serializes Dates with
// `JSON.stringify`), and the transform means `z.infer` still yields `Date`, which
// is what the service layer hands back. The converter unwraps `ZodEffects` to its
// inner schema, so the document gets `{ type: 'string', format: 'date-time' }`.
//
// Response contracts only — these schemas are never `.parse()`d at runtime, so
// the string-shaped *input* side is never exercised.
import { z } from 'zod';

export const isoTimestamp = () =>
  z
    .string()
    .datetime()
    .transform((value) => new Date(value));
