import {
  TemplateBodyError,
  assertWellFormedTemplateBody,
  renderTemplateBody,
  templatePositions,
} from './template-body';

describe('templatePositions()', () => {
  it('finds nothing in a body with no placeholders', () => {
    expect(templatePositions('We are closed on Friday.')).toEqual([]);
  });

  it('returns positions ascending regardless of the order they appear in', () => {
    expect(templatePositions('{{2}} then {{1}}')).toEqual([1, 2]);
  });

  it('counts a repeated placeholder once', () => {
    expect(templatePositions('Hi {{1}}, order {{2}} is out, {{1}}.')).toEqual([
      1, 2,
    ]);
  });

  it("tolerates the inner whitespace Meta's editor allows", () => {
    expect(templatePositions('Hi {{ 1 }}')).toEqual([1]);
  });
});

describe('assertWellFormedTemplateBody()', () => {
  it('accepts a body with no placeholders', () => {
    expect(() => assertWellFormedTemplateBody('Thanks!')).not.toThrow();
  });

  it('accepts consecutive placeholders from 1', () => {
    expect(() =>
      assertWellFormedTemplateBody('Hi {{1}}, your order {{2}} shipped.'),
    ).not.toThrow();
  });

  // The failure this exists to prevent: Meta rejects a gapped template at
  // send time, per message, so without this the tenant finds out from a
  // customer who never got the message.
  it('rejects a gap in the numbering', () => {
    expect(() => assertWellFormedTemplateBody('Hi {{1}}, order {{3}}')).toThrow(
      TemplateBodyError,
    );
  });

  it('rejects a body that starts at {{2}}', () => {
    expect(() => assertWellFormedTemplateBody('Order {{2}}')).toThrow(
      TemplateBodyError,
    );
  });

  it('rejects {{0}}', () => {
    expect(() => assertWellFormedTemplateBody('Order {{0}}')).toThrow(
      TemplateBodyError,
    );
  });
});

describe('renderTemplateBody()', () => {
  it('fills placeholders positionally', () => {
    expect(
      renderTemplateBody('Hi {{1}}, your order {{2}} shipped.', [
        'Rina',
        'A-4471',
      ]),
    ).toBe('Hi Rina, your order A-4471 shipped.');
  });

  it('fills every occurrence of a repeated placeholder', () => {
    expect(renderTemplateBody('{{1}}, see you {{1}}.', ['Rina'])).toBe(
      'Rina, see you Rina.',
    );
  });

  it('returns a body with no placeholders unchanged', () => {
    expect(renderTemplateBody('Thanks!', [])).toBe('Thanks!');
  });

  // A blank substitution would send "your order  shipped" and look correct
  // to the person who sent it — refusing is the only visible failure.
  it('refuses too few values', () => {
    expect(() => renderTemplateBody('Hi {{1}}, order {{2}}', ['Rina'])).toThrow(
      TemplateBodyError,
    );
  });

  it('refuses too many values', () => {
    expect(() =>
      renderTemplateBody('Hi {{1}}', ['Rina', 'unexpected']),
    ).toThrow(TemplateBodyError);
  });
});
