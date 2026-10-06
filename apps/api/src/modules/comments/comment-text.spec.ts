import {
  findKeyword,
  hasMeaningfulText,
  normalizeCommentText,
} from './comment-text';

describe('normalizeCommentText', () => {
  it('lowercases and collapses whitespace', () => {
    expect(normalizeCommentText('  How   MUCH\n?  ')).toBe('how much ?');
  });

  it('folds Arabic spelling variants so a keyword matches however it is typed', () => {
    // Diacritics, tatweel and the alef/ya variants.
    expect(normalizeCommentText('بِكَمْ')).toBe('بكم');
    expect(normalizeCommentText('بكـــم')).toBe('بكم');
    expect(normalizeCommentText('أسعار إكسسوار آخر')).toBe('اسعار اكسسوار اخر');
    expect(normalizeCommentText('على')).toBe('علي');
  });
});

describe('findKeyword', () => {
  it('returns the first configured keyword contained in the comment', () => {
    expect(findKeyword('What is the PRICE please', ['cost', 'price'])).toBe(
      'price',
    );
  });

  it('matches Gulf Arabic keywords across spelling variants', () => {
    expect(findKeyword('بِكَم هذا؟', ['بكم'])).toBe('بكم');
    expect(findKeyword('كم السعر', ['السعر'])).toBe('السعر');
  });

  it('returns null when nothing matches or no keywords are configured', () => {
    expect(findKeyword('nice photo', ['price'])).toBeNull();
    expect(findKeyword('price', [])).toBeNull();
  });

  it('ignores blank keywords instead of matching everything', () => {
    expect(findKeyword('anything', ['  '])).toBeNull();
  });
});

describe('hasMeaningfulText', () => {
  it.each([
    ['', false],
    ['   ', false],
    ['🔥🔥🔥', false],
    ['@sara @ali', false],
    ['!!!', false],
    ['@sara look at this', true],
    ['بكم', true],
    ['5', true],
  ])('%p -> %p', (text, expected) => {
    expect(hasMeaningfulText(text)).toBe(expected);
  });
});
