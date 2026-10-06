import { parseVisionEnvelope } from './vision-envelope';

describe('parseVisionEnvelope', () => {
  it('parses a fenced envelope', () => {
    const raw =
      '```json\n{"description":"A blender","legible":true,"confidence":0.8}\n```';
    expect(parseVisionEnvelope(raw)).toEqual({
      description: 'A blender',
      confidence: 0.8,
    });
  });

  it('rejects an empty description marked illegible', () => {
    expect(
      parseVisionEnvelope(
        '{"description":"","legible":false,"confidence":0.1}',
      ),
    ).toBeNull();
  });

  it('rejects a low-confidence description marked illegible', () => {
    expect(
      parseVisionEnvelope(
        '{"description":"dark blur","legible":false,"confidence":0.2}',
      ),
    ).toBeNull();
  });

  // Prod 2026-10-05: Qwen read "legible" as "has legible text" and returned
  // legible:false for a clear, unlabeled photo of rice. The description was
  // good and confidence was 0.95 — discarding it escalated a readable photo.
  it('keeps a confident description even when the model sets legible:false', () => {
    const raw =
      '{"description":"Two servings of white rice on a blue plate and bowl","legible":false,"confidence":0.95}';
    expect(parseVisionEnvelope(raw)).toEqual({
      description: 'Two servings of white rice on a blue plate and bowl',
      confidence: 0.95,
    });
  });

  it('returns null for non-JSON', () => {
    expect(parseVisionEnvelope('sorry, cannot see')).toBeNull();
  });
});
