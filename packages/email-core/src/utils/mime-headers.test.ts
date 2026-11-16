import { buildReferences, composeMessage, refoldParamHeaders } from './mime-headers.js';

const CRLF = '\r\n';

function build(lines: string[]): Buffer {
  return Buffer.from(lines.join(CRLF), 'binary');
}

describe('refoldParamHeaders', () => {
  it('moves a fold out of a quoted filename and onto the parameter boundary', () => {
    const raw = build([
      'Content-Type: multipart/mixed; boundary="b1"',
      '',
      '--b1',
      'Content-Type: application/pdf; name="Farmpedals Statement 08-07-2026.pdf"',
      'Content-Disposition: attachment; filename="Farmpedals Statement',
      ' 08-07-2026.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      'JVBERi0xLjQK',
      '--b1--',
      '',
    ]);

    const out = refoldParamHeaders(raw).toString('binary');

    expect(out).toContain('filename="Farmpedals Statement 08-07-2026.pdf"');
    expect(out).not.toContain('filename="Farmpedals Statement\r\n');
    expect(out).toContain(`Content-Disposition: attachment;${CRLF} filename=`);
    expect(out).toContain('JVBERi0xLjQK');
  });

  it('returns the very same buffer when nothing needs refolding', () => {
    const raw = build(['Content-Type: text/plain; charset=utf-8', '', 'hello', '']);
    expect(refoldParamHeaders(raw)).toBe(raw);
  });

  it('does not split on a semicolon inside a quoted value', () => {
    const raw = build([
      'Content-Disposition: attachment; filename="weird;name that is quite long indeed.pdf"; size=100',
      '',
      'body',
      '',
    ]);
    const out = refoldParamHeaders(raw).toString('binary');
    expect(out).toContain('filename="weird;name that is quite long indeed.pdf"; size=100');
    expect(out).toContain(`Content-Disposition: attachment;${CRLF} filename=`);
  });

  it('leaves body lines alone, including a "-- " signature delimiter followed by header-like text', () => {
    // La version d'origine traitait toute ligne « -- » du corps comme un
    // délimiteur de partie, donc la suite comme des en-têtes.
    const body = [
      '-- ',
      'Content-Disposition: attachment; filename="pas un en-tête, juste du',
      ' texte du corps.pdf"',
    ];
    const raw = build(['Content-Type: text/plain', '', ...body, '']);
    expect(refoldParamHeaders(raw).toString('binary')).toContain(body.join(CRLF));
  });

  it('handles LF-only messages', () => {
    const raw = Buffer.from(
      [
        'Content-Disposition: attachment; filename="A rather long attachment',
        ' name goes here.pdf"',
        '',
        'body',
      ].join('\n'),
      'binary',
    );
    const out = refoldParamHeaders(raw).toString('binary');
    expect(out).toContain('filename="A rather long attachment name goes here.pdf"');
    expect(out).not.toContain('\r');
  });

  it('stays linear on a large attachment (no quadratic copy)', () => {
    // ~25 Mo de base64 en lignes de 76 caractères : la version d'origine, qui
    // recopiait le tableau à chaque ligne, ne terminait pas en temps utile.
    const line = 'A'.repeat(76);
    const lines = Array.from({ length: 340_000 }, () => line);
    const raw = build([
      'Content-Type: multipart/mixed; boundary="b"',
      '',
      '--b',
      'Content-Type: application/octet-stream',
      '',
      ...lines,
      '--b--',
    ]);
    const started = Date.now();
    refoldParamHeaders(raw);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('composeMessage', () => {
  it('drops Bcc by default (send) and keeps it with keepBcc (draft)', async () => {
    const options = { from: 'a@example.com', to: 'b@example.com', bcc: 'k@example.com', text: 'x' };
    expect((await composeMessage(options)).toString()).not.toMatch(/^Bcc:/m);
    expect((await composeMessage(options, { keepBcc: true })).toString()).toMatch(
      /^Bcc: k@example\.com/m,
    );
  });
});

describe('buildReferences', () => {
  it('appends In-Reply-To to the chain when missing', () => {
    expect(buildReferences('<b@x>', ['<a@x>'])).toBe('<a@x> <b@x>');
    expect(buildReferences('<b@x>', '<a@x> <b@x>')).toBe('<a@x> <b@x>');
  });

  it('uses In-Reply-To alone without a chain, and nothing without either', () => {
    expect(buildReferences('<b@x>', undefined)).toBe('<b@x>');
    expect(buildReferences(undefined, undefined)).toBeUndefined();
  });
});
