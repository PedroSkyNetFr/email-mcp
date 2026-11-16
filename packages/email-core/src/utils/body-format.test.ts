import {
  applyBodyFormat,
  bestPlainText,
  countWords,
  htmlToPlainText,
  isStubText,
  nonEmpty,
  RAW_CAP,
  stripHtml,
  stripReplyChain,
} from './body-format.js';

describe('nonEmpty', () => {
  it('treats whitespace-only and non-strings as missing', () => {
    expect(nonEmpty('hello')).toBe('hello');
    expect(nonEmpty('')).toBeUndefined();
    expect(nonEmpty('   \n\t ')).toBeUndefined();
    expect(nonEmpty(undefined)).toBeUndefined();
    expect(nonEmpty(null)).toBeUndefined();
  });
});

describe('stripHtml / stripReplyChain', () => {
  it('strips tags and decodes entities', () => {
    expect(stripHtml('<p>a &amp; b</p>')).toBe('a & b');
  });
  it('drops quoted reply chains and signatures', () => {
    expect(stripReplyChain('keep\n> quoted\n-- \nsig')).toBe('keep');
  });
});

describe('applyBodyFormat', () => {
  it('full prefers decoded text over HTML', () => {
    expect(applyBodyFormat({ bodyText: 'plain', bodyHtml: '<p>html</p>' }, 'full')).toBe('plain');
  });

  it('REGRESSION: empty-string bodyText does NOT win over a real HTML part', () => {
    // The core defect: old code did `bodyText ?? bodyHtml` so a stage that
    // produced "" beat the HTML alternative (── empty multipart bodies).
    const out = applyBodyFormat({ bodyText: '', bodyHtml: '<div>real content</div>' }, 'full');
    expect(out).toContain('real content');
    expect(out).not.toBe('');
  });

  it('whitespace-only bodyText is treated as missing', () => {
    const out = applyBodyFormat({ bodyText: '   \n ', bodyHtml: '<b>hi</b>' }, 'text');
    expect(out).toBe('hi');
  });

  it('text strips HTML when only HTML is present', () => {
    expect(applyBodyFormat({ bodyHtml: '<p>hello <b>world</b></p>' }, 'text')).toBe('hello world');
  });

  it('stripped also removes quoted replies', () => {
    const src = { bodyText: 'reply body\n> old quoted line\n-- \nsignature' };
    expect(applyBodyFormat(src, 'stripped')).toBe('reply body');
  });

  it('nothing decodable → visible marker for every format (never silent)', () => {
    const src = { bodyWarning: 'MIME parse error: boom' };
    expect(applyBodyFormat(src, 'full')).toBe('⚠️ body extraction failed: MIME parse error: boom');
    expect(applyBodyFormat(src, 'text')).toBe('⚠️ body extraction failed: MIME parse error: boom');
    expect(applyBodyFormat(src, 'stripped')).toBe(
      '⚠️ body extraction failed: MIME parse error: boom',
    );
  });

  it('default reason when bodyWarning absent', () => {
    expect(applyBodyFormat({}, 'text')).toBe(
      '⚠️ body extraction failed: no decodable text or HTML part',
    );
  });

  it('full appends capped raw source as the escape hatch; text/stripped do NOT', () => {
    const src = { raw: 'Raw-RFC822-Bytes-Here', bodyWarning: 'no decodable text or HTML part' };
    const full = applyBodyFormat(src, 'full');
    expect(full).toContain('⚠️ body extraction failed');
    expect(full).toContain('--- Raw source ---');
    expect(full).toContain('Raw-RFC822-Bytes-Here');

    const text = applyBodyFormat(src, 'text');
    expect(text).not.toContain('--- Raw source ---');
    expect(text).not.toContain('Raw-RFC822-Bytes-Here');
  });

  it('raw fallback is hard-capped at RAW_CAP regardless of maxLength', () => {
    const src = { raw: 'x'.repeat(RAW_CAP * 2), bodyWarning: 'oversized' };
    // No maxLength → still capped (safety boundary, not ergonomic shaping).
    const out = applyBodyFormat(src, 'full');
    expect(out).toContain('raw source truncated at');
    // marker + header + capped raw + truncation note — bounded well under 2×cap.
    expect(out.length).toBeLessThan(RAW_CAP + 1024);
  });

  it('maxLength truncates after formatting with a remaining-chars hint', () => {
    const out = applyBodyFormat({ bodyText: 'abcdefghij' }, 'full', 4);
    expect(out.startsWith('abcd')).toBe(true);
    expect(out).toContain('6 more characters');
  });

  it('html returns the raw HTML part unmodified, preferring it over text', () => {
    const html = '<table><tr><td>$2,147.32</td></tr></table>';
    expect(applyBodyFormat({ bodyText: 'plain', bodyHtml: html }, 'html')).toBe(html);
  });

  it('html falls back to text when there is no HTML part', () => {
    expect(applyBodyFormat({ bodyText: 'plain only', bodyHtml: '  ' }, 'html')).toBe('plain only');
  });

  it('html on an undecodable message shows the marker, never the raw source', () => {
    const src = { raw: 'RAW', bodyWarning: 'boom' };
    expect(applyBodyFormat(src, 'html')).toBe('⚠️ body extraction failed: boom');
  });
});

describe('applyBodyFormat — reading window (offset / maxLength)', () => {
  const body = 'x'.repeat(25);

  it('a cut body says what is shown, what remains and how to continue', () => {
    const out = applyBodyFormat({ bodyText: body }, 'text', {
      maxLength: 10,
      continuation: (next) => `call get_email again with offset=${next}`,
    });
    expect(out.startsWith('x'.repeat(10))).toBe(true);
    expect(out).toContain('✂️');
    expect(out).toContain('15 more characters');
    expect(out).toContain('showing 0–10 of 25');
    expect(out).toContain('call get_email again with offset=10');
  });

  it('offset reads the continuation, announced as such', () => {
    const src = { bodyText: 'abcdefghijklmnop' };
    const out = applyBodyFormat(src, 'text', { offset: 10, maxLength: 3 });
    expect(out).toContain('characters 10–13 of 16');
    expect(out).toContain('klm');
    expect(out).toContain('3 more characters');
    // Dernière tranche : plus de marqueur de coupe.
    const last = applyBodyFormat(src, 'text', { offset: 13, maxLength: 10 });
    expect(last).toContain('nop');
    expect(last).not.toContain('✂️');
  });

  it('maxLength 0 means unlimited; offset past the end says so', () => {
    expect(applyBodyFormat({ bodyText: body }, 'text', { maxLength: 0 })).toBe(body);
    expect(applyBodyFormat({ bodyText: body }, 'text', { offset: 99 })).toMatch(
      /past the end of the body — it has 25 characters/,
    );
  });
});

describe('htmlToPlainText', () => {
  it('keeps links as "label [url]", hiding the URL when it repeats the label', () => {
    const out = htmlToPlainText(
      '<p>See <a href="https://ex.com/a">the invoice</a> or <a href="https://ex.com">https://ex.com</a>.</p>',
    );
    expect(out).toBe('See the invoice [https://ex.com/a] or https://ex.com.');
  });

  it('renders tables as aligned columns instead of glued cells', () => {
    const out = htmlToPlainText(
      '<table><tr><th>Item</th><th>Price</th></tr><tr><td>Apple</td><td>1.20</td></tr></table>',
    );
    const lines = out.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^Item\s+Price$/);
    expect(lines[1]).toMatch(/^Apple\s+1\.20$/);
    // L'ancien stripHtml rendait « ItemPriceApple1.20 ».
    expect(out).not.toContain('ItemPrice');
  });

  it('decodes every entity form — named, decimal, hex — without crashing on forged ones', () => {
    const out = htmlToPlainText(
      '<p>&eacute;t&eacute; &mdash; caf&#233; &#x1F600; &hellip; a &amp; b &lt;c&gt; &#99999999; &#xD800;</p>',
    );
    expect(out).toContain('été — café 😀 … a & b <c>');
    // Code point hors plage / demi-substitut : remplacé, pas d'exception.
    expect(out).toContain('�');
  });

  it('separates block elements and drops style, script and images', () => {
    const out = htmlToPlainText(
      '<html><head><style>p{color:red}</style></head><body><div>Bloc 1</div><div>Bloc 2</div>' +
        '<p>Para</p><img src="pixel.gif" alt="tracker"><script>alert(1)</script></body></html>',
    );
    expect(out).toBe('Bloc 1\nBloc 2\n\nPara');
  });

  it('keeps heading case and list bullets', () => {
    expect(htmlToPlainText('<h1>Monthly report</h1><ul><li>one</li><li>two</li></ul>')).toBe(
      'Monthly report\n\n- one\n- two',
    );
  });

  it('aligns every list item when the list opens the body', () => {
    // Régression : avec le préfixe « • », le trim final retirait l'espace du
    // seul premier élément (« • un » puis «  • deux »).
    expect(htmlToPlainText('<ul><li>un</li><li>deux</li></ul>')).toBe('- un\n- deux');
  });

  it('stripHtml is kept as an alias for existing callers', () => {
    expect(stripHtml('<p>a &eacute; b</p>')).toBe(htmlToPlainText('<p>a &eacute; b</p>'));
  });
});

describe('stub text part (multipart/alternative, codefuturist #66)', () => {
  const richHtml = `<p>${'Our autumn collection has arrived with new colours and fabrics. '.repeat(6)}</p>`;

  it('counts words without URLs', () => {
    expect(countWords('View it here: https://news.example.com/abc?x=1 now')).toBe(4);
  });

  it('a one-line "view in browser" text part yields to the HTML part', () => {
    const src = {
      bodyText: 'View this email in your browser: https://news.example.com/v/123',
      bodyHtml: richHtml,
    };
    expect(applyBodyFormat(src, 'text')).toContain('Our autumn collection has arrived');
    expect(applyBodyFormat(src, 'stripped')).toContain('Our autumn collection has arrived');
    // full renvoie la partie d'origine : ici le HTML brut.
    expect(applyBodyFormat(src, 'full')).toBe(richHtml);
    expect(bestPlainText(src)).toContain('Our autumn collection');
  });

  it('a markedly poorer (truncated) text part yields to the HTML part', () => {
    const longHtml = `<p>${'word '.repeat(400)}</p>`;
    expect(isStubText('word '.repeat(100), htmlToPlainText(longHtml))).toBe(true);
  });

  it('a genuinely short message keeps its text part', () => {
    // 3 mots contre 10 : ratio atteint mais écart < 25 mots — juste un message court.
    const src = {
      bodyText: 'Thanks, see you',
      bodyHtml: '<p>Thanks, see you tomorrow at the office around noon</p>',
    };
    expect(applyBodyFormat(src, 'text')).toBe('Thanks, see you');
  });

  it('ordinary differences (footer added to HTML only) keep the text part', () => {
    const text = 'Hello team, '.repeat(30);
    const html = `<p>${text}</p><p>Unsubscribe · Privacy policy · 12 rue de Paris, 75001 Paris</p>`;
    expect(applyBodyFormat({ bodyText: text, bodyHtml: html }, 'text')).toBe(text);
  });
});
