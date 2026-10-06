import { MediaUnreadable } from '@repo/errors';
import {
  assertUnderstandableMedia,
  classifyDeclaredMedia,
  sniffMediaKind,
} from './media-whitelist';

// Real signatures, not placeholder bytes — the whole point of the check is that
// it reads the payload rather than trusting the label on it.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(8)]);
const PDF = Buffer.from('%PDF-1.7\n%');

describe('T3 escalation matrix (F17) — declared media', () => {
  it('accepts a whatsapp photo for understanding', () => {
    expect(classifyDeclaredMedia('image', 'image/jpeg')).toBe('image');
  });

  it('accepts a whatsapp voice note, mime parameters and all', () => {
    expect(classifyDeclaredMedia('voice', 'audio/ogg; codecs=opus')).toBe(
      'voice',
    );
  });

  it('still hard-escalates a document — the matrix only moved for images and voice', () => {
    expect(classifyDeclaredMedia('document', 'application/pdf')).toBeNull();
  });

  it('still hard-escalates video', () => {
    expect(classifyDeclaredMedia('unsupported', 'video/mp4')).toBeNull();
    expect(classifyDeclaredMedia('unsupported', null)).toBeNull();
    expect(classifyDeclaredMedia('document', null)).toBeNull();
  });

  // Gulf T6 (D9): Messenger/Instagram attachments carry a type and a url, never
  // a mime type. An UNdeclared mime defers to the bytes: the fetched content
  // type and magic bytes are checked by assertUnderstandableMedia before any
  // model sees them. A DECLARED mime outside the whitelist still escalates.
  it('classifies by message type alone when the channel declared no mime type', () => {
    expect(classifyDeclaredMedia('image', null)).toBe('image');
    expect(classifyDeclaredMedia('image', undefined)).toBe('image');
    expect(classifyDeclaredMedia('voice', '')).toBe('voice');
  });

  it('still refuses a declared mime type outside the whitelist', () => {
    expect(classifyDeclaredMedia('image', 'image/svg+xml')).toBeNull();
    expect(classifyDeclaredMedia('voice', 'audio/x-unknown')).toBeNull();
  });

  it('does not accept an image mime type on a voice message, or the reverse', () => {
    expect(classifyDeclaredMedia('voice', 'image/png')).toBeNull();
    expect(classifyDeclaredMedia('image', 'audio/ogg')).toBeNull();
  });
});

describe('sniffMediaKind', () => {
  it.each([
    ['jpeg', JPEG, 'image'],
    ['png', PNG, 'image'],
    ['ogg', OGG, 'voice'],
  ])('recognises %s', (_label, bytes, expected) => {
    expect(sniffMediaKind(bytes as Buffer)).toBe(expected);
  });

  it('recognises nothing in a pdf or in noise', () => {
    expect(sniffMediaKind(PDF)).toBeNull();
    expect(sniffMediaKind(Buffer.from('not a real file'))).toBeNull();
  });
});

describe('assertUnderstandableMedia', () => {
  const LIMIT = 1024;

  it('passes a genuine jpeg', () => {
    expect(() =>
      assertUnderstandableMedia('image', 'image/jpeg', JPEG, LIMIT),
    ).not.toThrow();
  });

  it('rejects a pdf renamed as a photo — the bytes win, not the label', () => {
    expect(() =>
      assertUnderstandableMedia('image', 'image/jpeg', PDF, LIMIT),
    ).toThrow(MediaUnreadable);
  });

  it('rejects a truncated/corrupt payload', () => {
    expect(() =>
      assertUnderstandableMedia(
        'image',
        'image/jpeg',
        Buffer.from([0xff]),
        LIMIT,
      ),
    ).toThrow(MediaUnreadable);
  });

  it('rejects an empty payload', () => {
    expect(() =>
      assertUnderstandableMedia('voice', 'audio/ogg', Buffer.alloc(0), LIMIT),
    ).toThrow(MediaUnreadable);
  });

  it('rejects a payload over the understanding limit', () => {
    const big = Buffer.concat([JPEG, Buffer.alloc(LIMIT)]);
    expect(() =>
      assertUnderstandableMedia('image', 'image/jpeg', big, LIMIT),
    ).toThrow(MediaUnreadable);
  });

  it('rejects a mime type outside the whitelist even when the bytes are readable', () => {
    expect(() =>
      assertUnderstandableMedia('image', 'image/tiff', JPEG, LIMIT),
    ).toThrow(MediaUnreadable);
  });
});
