/**
 * Court-circuit du test du bouchon : une partie texte longue ne fait plus
 * convertir tout le HTML (html-to-text) pour rien.
 */

import { convert } from 'html-to-text';

import {
  applyBodyFormat,
  bestPlainText,
  cannotBeStub,
  STUB_TEXT_MAX_CHARS,
  STUB_TEXT_MAX_WORDS,
} from './body-format.js';

vi.mock('html-to-text', async (importOriginal) => {
  const actual = await importOriginal<{ convert: typeof convert }>();
  return { ...actual, convert: vi.fn(actual.convert) };
});

const convertSpy = vi.mocked(convert);

const longText = 'Contenu réel du message. '.repeat(120); // > 2 000 car.
const richHtml = `<html><body>${'<p>Paragraphe riche en mots variés.</p>'.repeat(400)}</body></html>`;

beforeEach(() => {
  convertSpy.mockClear();
});

describe('stub test short-circuit (9)', () => {
  it('a long text part is never a stub candidate', () => {
    expect(longText.length).toBeGreaterThan(STUB_TEXT_MAX_CHARS);
    expect(cannotBeStub(longText)).toBe(true);
    expect(cannotBeStub('mot '.repeat(STUB_TEXT_MAX_WORDS))).toBe(true);
    expect(cannotBeStub('View this email in your browser')).toBe(false);
  });

  it.each(['full', 'text', 'stripped'] as const)(
    'format %s with a long text part: html-to-text is not run, the text part wins',
    (format) => {
      // Avant : le HTML entier était converti à chaque lecture pour le seul test.
      const body = applyBodyFormat({ bodyText: longText, bodyHtml: richHtml }, format);
      expect(convertSpy).not.toHaveBeenCalled();
      expect(body).toContain('Contenu réel du message.');
    },
  );

  it('format html never converts', () => {
    applyBodyFormat({ bodyText: 'court', bodyHtml: richHtml }, 'html');
    expect(convertSpy).not.toHaveBeenCalled();
  });

  it('a short text part is still tested, and loses to a rich HTML (stub)', () => {
    const body = applyBodyFormat(
      { bodyText: 'View this email in your browser', bodyHtml: richHtml },
      'text',
    );
    expect(convertSpy).toHaveBeenCalledTimes(1);
    expect(body).toContain('Paragraphe riche en mots variés.');
  });

  it('bestPlainText applies the same short-circuit', () => {
    expect(bestPlainText({ bodyText: longText, bodyHtml: richHtml })).toBe(longText);
    expect(convertSpy).not.toHaveBeenCalled();
  });
});
