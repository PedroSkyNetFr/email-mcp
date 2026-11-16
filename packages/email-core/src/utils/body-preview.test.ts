import {
  buildPreview,
  decodeCharset,
  decodeTransferEncoding,
  findPreviewPart,
  PREVIEW_LENGTH,
} from './body-preview.js';

describe('findPreviewPart', () => {
  it('single-part message: section 1 with its encoding and charset', () => {
    expect(
      findPreviewPart({
        type: 'text/plain',
        encoding: 'quoted-printable',
        parameters: { charset: 'iso-8859-1' },
      }),
    ).toEqual({
      key: '1',
      type: 'text/plain',
      encoding: 'quoted-printable',
      charset: 'iso-8859-1',
    });
  });

  it('multipart/alternative: prefers text/plain over text/html', () => {
    const part = findPreviewPart({
      type: 'multipart/alternative',
      childNodes: [
        { part: '1', type: 'text/html' },
        { part: '2', type: 'text/plain' },
      ],
    });
    expect(part?.key).toBe('2');
  });

  it('nested multipart (mixed > alternative): finds section 1.1', () => {
    const part = findPreviewPart({
      type: 'multipart/mixed',
      childNodes: [
        {
          part: '1',
          type: 'multipart/alternative',
          childNodes: [
            { part: '1.1', type: 'text/plain' },
            { part: '1.2', type: 'text/html' },
          ],
        },
        { part: '2', type: 'application/pdf', disposition: 'attachment' },
      ],
    });
    expect(part?.key).toBe('1.1');
  });

  it('skips attachments and forwarded messages; HTML-only falls back to text/html', () => {
    const part = findPreviewPart({
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/html' },
        { part: '2', type: 'text/plain', disposition: 'attachment' },
        { part: '3', type: 'message/rfc822', childNodes: [{ part: '3.1', type: 'text/plain' }] },
      ],
    });
    expect(part).toMatchObject({ key: '1', type: 'text/html' });
  });

  it('no text part, or no structure: undefined', () => {
    expect(findPreviewPart({ type: 'image/png' })).toBeUndefined();
    expect(findPreviewPart(undefined)).toBeUndefined();
  });
});

describe('transfer / charset decoding of a truncated fetch', () => {
  it('base64 cut mid-group decodes the whole groups only', () => {
    const full = Buffer.from('Hello world, this is a preview').toString('base64');
    const cut = Buffer.from(full.slice(0, 15)); // 15 = 3 groupes complets + 3
    expect(decodeTransferEncoding(cut, 'base64').toString()).toBe('Hello wor');
  });

  it('quoted-printable: a half escape at the end is dropped', () => {
    const out = decodeTransferEncoding(
      Buffer.from('caf=C3=A9 ici=\r\nsuite =C'),
      'quoted-printable',
    );
    expect(out.toString('utf-8')).toBe('café icisuite ');
  });

  it('declared charset is honoured; unknown label falls back to utf-8', () => {
    expect(decodeCharset(Buffer.from([0x52, 0xe9, 0x75]), 'iso-8859-1')).toBe('Réu');
    expect(decodeCharset(Buffer.from('ok'), 'x-unknown-charset')).toBe('ok');
  });
});

describe('buildPreview', () => {
  const plain = { key: '1', type: 'text/plain' };
  const html = { key: '1', type: 'text/html' };

  it('collapses whitespace and caps at PREVIEW_LENGTH with an ellipsis', () => {
    const out = buildPreview(Buffer.from(`Bonjour,\r\n\r\n${'texte '.repeat(80)}`), plain);
    expect(out?.startsWith('Bonjour, texte texte')).toBe(true);
    expect(out?.endsWith('…')).toBe(true);
    expect(out?.length).toBeLessThanOrEqual(PREVIEW_LENGTH + 1);
  });

  it('HTML cut inside <style> or a tag leaves no markup residue', () => {
    const out = buildPreview(
      Buffer.from(
        '<html><head><style>p{color:red}</style></head><body><p>Votre facture est disponible</p><div cla',
      ),
      html,
    );
    expect(out).toBe('Votre facture est disponible');
  });

  it('markup in a part declared text/plain is still stripped', () => {
    const out = buildPreview(
      Buffer.from('<div><p>Newsletter de novembre : les nouveautés du mois</p></div>'),
      plain,
    );
    expect(out).toBe('Newsletter de novembre : les nouveautés du mois');
  });

  it('a preview reduced to markup residue is omitted (none beats a misleading one)', () => {
    expect(buildPreview(Buffer.from('<html><head><title>x</title><style>a{}'), html)).toBe(
      undefined,
    );
  });

  it('a severed UTF-8 sequence at the end is not shown as U+FFFD', () => {
    const bytes = Buffer.concat([Buffer.from('Merci beaucoup caf'), Buffer.from([0xc3])]);
    expect(buildPreview(bytes, plain)).toBe('Merci beaucoup caf');
  });

  it('REGRESSION (cf ec5330a): forged numeric entities never throw', () => {
    const forged = Buffer.from(
      `<p>Promo &#99999999999; &#x110000; &#xD800; ${'contenu lisible '.repeat(3)}</p>`,
    );
    expect(() => buildPreview(forged, html)).not.toThrow();
    expect(buildPreview(forged, html)).toContain('contenu lisible');
  });

  it('FETCH BINARY content is not transfer-decoded twice', () => {
    const out = buildPreview(Buffer.from('déjà décodé'), { ...plain, encoding: 'base64' }, true);
    expect(out).toBe('déjà décodé');
  });
});
