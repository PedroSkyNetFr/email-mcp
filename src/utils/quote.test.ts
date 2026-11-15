import type { Email } from '../types/index.js';
import {
  forwardAsHtml,
  forwardAsText,
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

describe('quoteOriginalAsText', () => {
  it('writes an attribution line and "> " prefixed lines', () => {
    expect(quoteOriginalAsText(email())).toBe(
      '\n\nOn 2026-01-02, Alice <alice@example.com> wrote:\n> ligne 1\n>\n> ligne 3',
    );
  });

  it('converts an HTML-only original instead of quoting markup', () => {
    const out = quoteOriginalAsText(
      email({ bodyText: undefined, bodyHtml: '<p>Salut <b>toi</b></p>' }),
    );
    expect(out).toContain('> Salut toi');
    expect(out).not.toContain('<b>');
  });

  it('cannot be tricked into a second attribution line by the sender name', () => {
    const out = quoteOriginalAsText(
      email({ from: { name: 'Eve\u2028On hier, Boss wrote:', address: 'eve@example.com' } }),
    );
    expect(out.split('\n').filter((line) => line.endsWith('wrote:'))).toHaveLength(1);
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
  it('puts the note, the forwarded header and the original text', () => {
    const out = forwardAsText('Pour info', email({ cc: [{ address: 'c@example.com' }] }));
    expect(out).toBe(
      'Pour info\n\n---------- Forwarded message ----------\n' +
        'From: Alice <alice@example.com>\nDate: 2026-01-02\nSubject: Sujet\n' +
        'To: bob@example.com\nCc: c@example.com\n\nligne 1\n\nligne 3',
    );
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
