// A11 (Feature 17): parsing the vision pre-pass's reply.
//
// The pre-pass exists so an image turn can be RETRIEVED for. Retrieval is
// text-in/text-out (A1), and a photo with no caption gives it nothing to search
// with — so the image is first turned into a short factual description, which
// becomes part of the retrieval query, the D12 forbidden-topic embedding, and
// the prompt. The ANSWER is still produced by the one bounded loop with the
// image attached; this is a stage in front of the pipeline, not a second
// pipeline (A11: "routed through the same prompt/confidence/citation pipeline
// as text rather than a separate path").
//
// Everything the model can get wrong ends at `null`, which the caller turns
// into a clean MediaUnreadable escalation — never into an invented description.
export interface VisionDescription {
  description: string;
  /** D10's modality term for an image: how clearly the picture could be read. */
  confidence: number;
}

/** Below this, `legible: false` is believed even when a description came back. */
const ILLEGIBLE_CONFIDENCE_CEILING = 0.5;

export function parseVisionEnvelope(raw: string): VisionDescription | null {
  const withoutFences = raw
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(withoutFences);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const envelope = parsed as {
    description?: unknown;
    legible?: unknown;
    confidence?: unknown;
  };
  if (typeof envelope.description !== 'string') return null;
  const description = envelope.description.trim();
  if (!description) return null;

  const rawConfidence =
    typeof envelope.confidence === 'number' &&
    Number.isFinite(envelope.confidence)
      ? envelope.confidence
      : 0.5;
  const confidence = Math.min(1, Math.max(0, rawConfidence));
  // The self-hosted model sometimes reads "legible" as "contains legible
  // text" and flags a clear, unlabeled product photo false while describing
  // it well. A real illegible image comes back with no description or low
  // confidence, so `legible: false` alone is not grounds to discard one.
  if (envelope.legible === false && confidence < ILLEGIBLE_CONFIDENCE_CEILING) {
    return null;
  }
  return { description, confidence };
}
