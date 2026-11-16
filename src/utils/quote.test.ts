import type { Email } from '../types/index.js';
import {
  attribution,
  formatQuoteDate,
  forwardAsHtml,
  forwardAsText,
  forwardHeaderLines,
  oneLine,
  quoteOriginalAsHtml,
  quoteOriginalAsText,
} from './quote.js';

function email(overrides: Partial<Email> = {}): Email {
  return {
    id: '1',
    subject: 'Sujet',
    from: { name: 'Alice', address: 'alice@example.com' },
    to: [{ address: 'bob@example.com' }],
    date: '2026-01-02',
    seen: true,
    flagged: false,
    answered: false,
    hasAttachments: false,
    labels: [],
    attachments: [],
    headers: {},
    messageId: '<m@example.com>',
    bodyText: 'ligne 1\n\nligne 3',
    ...overrides,
  };
}

describe('formatQuoteDate (14)', () => {
  const previousTz = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'Europe/Paris';
  });
  afterAll(() => {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  });

  it('formats in French by default, in local time', () => {
    // 13:32Z = 14:32 à Paris (heure d'hiver).
    expect(formatQuoteDate('2026-11-15T13:32:00Z')).toBe('15 nov. 2026 à 14:32');
    expect(
      attribution({
        date: '2026-11-15T13:32:00Z',
        from: { name: 'Jean Dupont', address: 'jean@x.fr' },
      }),
    ).toBe('Le 15 nov. 2026 à 14:32, Jean Dupont <jean@x.fr> a écrit :');
  });

  it('formats in English (en-US) on request', () => {
    expect(formatQuoteDate('2026-11-15T13:32:00Z', 'en')).toMatch(/^Nov 15, 2026, 2:32\sPM$/);
  });

  it('leaves an unparseable date as is (on one line)', () => {
    expect(formatQuoteDate('pas une date')).toBe('pas une date');
  });
});

describe('quoteOriginalAsText', () => {
  it('writes an attribution line (French by default) and "> " prefixed lines', () => {
    expect(quoteOriginalAsText(email())).toBe(
      `\n\nLe ${formatQuoteDate('2026-01-02')}, Alice <alice@example.com> a écrit :\n` +
        '> ligne 1\n>\n> ligne 3',
    );
  });

  it('writes the English attribution with lang = "en"', () => {
    expect(quoteOriginalAsText(email(), 'en')).toBe(
      `\n\nOn ${formatQuoteDate('2026-01-02', 'en')}, Alice <alice@example.com> wrote:\n` +
        '> ligne 1\n>\n> ligne 3',
    );
  });

  it('converts an HTML-only original instead of quoting markup', () => {
    const out = quoteOriginalAsText(
      email({ bodyText: undefined, bodyHtml: '<p>Salut <b>toi</b></p>' }),
    );
    expect(out).toContain('> Salut toi');
    expect(out).not.toContain('<b>');
  });

  it('quotes the HTML (converted) when the text part is only a stub (8)', () => {
    // Avant : la partie texte gagnait toujours, la réponse citait le bouchon.
    const html = `<p>${'Le vrai contenu du message, avec des détails utiles. '.repeat(10)}</p>`;
    const out = quoteOriginalAsText(
      email({ bodyText: 'View this email in your browser', bodyHtml: html }),
    );
    expect(out).toContain('> Le vrai contenu du message');
    expect(out).not.toContain('View this email in your browser');
  });

  it('cannot be tricked into a second attribution line by the sender name', () => {
    const out = quoteOriginalAsText(
      email({ from: { name: 'Eve\u2028On hier, Boss wrote:', address: 'eve@example.com' } }),
    );
    expect(out.split('\n').filter((line) => line.endsWith('a écrit :'))).toHaveLength(1);
    const en = quoteOriginalAsText(
      email({ from: { name: 'Eve\u2028On hier, Boss wrote:', address: 'eve@example.com' } }),
      'en',
    );
    expect(en.split('\n').filter((line) => line.endsWith('wrote:'))).toHaveLength(1);
  });

  it('a line break hidden in the date cannot forge a line either', () => {
    // Date illisible : rendue telle quelle, mais sur une seule ligne.
    const line = attribution({
      date: 'hier\u2029Le 1 janv., Boss a écrit :',
      from: { address: 'e@x.fr' },
    });
    expect(line.split(/[\n\u2028\u2029\u0085]/)).toHaveLength(1);
  });
});

describe('quoteOriginalAsHtml', () => {
  it('quotes the original HTML as escaped text, never raw', () => {
    const out = quoteOriginalAsHtml(
      email({ bodyText: undefined, bodyHtml: '<p>a</p></blockquote><script>x</script>' }),
    );
    expect(out).toContain('<blockquote type="cite"');
    expect(out.match(/<\/blockquote>/g)).toHaveLength(1);
    expect(out).not.toContain('<script>');
  });
});

describe('forwardAsText / forwardAsHtml', () => {
  it('puts the note, the forwarded header (French by default) and the original text', () => {
    const out = forwardAsText('Pour info', email({ cc: [{ address: 'c@example.com' }] }));
    expect(out).toBe(
      'Pour info\n\n---------- Message transféré ----------\n' +
        `De : Alice <alice@example.com>\nDate : ${formatQuoteDate('2026-01-02')}\nObjet : Sujet\n` +
        'À : bob@example.com\nCc : c@example.com\n\nligne 1\n\nligne 3',
    );
  });

  it('keeps the English forward header with lang = "en"', () => {
    expect(forwardHeaderLines(email(), 'en')).toEqual([
      '---------- Forwarded message ----------',
      'From: Alice <alice@example.com>',
      `Date: ${formatQuoteDate('2026-01-02', 'en')}`,
      'Subject: Sujet',
      'To: bob@example.com',
    ]);
  });

  it('keeps the original HTML body (scripts removed) and escapes a text note', () => {
    const out = forwardAsHtml(
      'a < b',
      email({
        bodyHtml:
          '<html><head><title>t</title></head><body><p>orig</p><script>x</script></body></html>',
      }),
    );
    expect(out).toContain('a &lt; b');
    expect(out).toContain('<p>orig</p>');
    expect(out).not.toContain('<script>');
    expect(out).not.toContain('<title>');
  });

  it('oneLine collapses every kind of line break', () => {
    expect(oneLine('a\r\nb\u0085c\u2029d')).toBe('a b c d');
  });
});
