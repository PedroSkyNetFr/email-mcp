import { classifyFromHeaders, formatClassification } from './mail-classification.js';

describe('classifyFromHeaders', () => {
  it('a newsletter: List-Id + List-Unsubscribe, https preferred, RFC 8058 one-click', () => {
    const c = classifyFromHeaders({
      'list-id': 'Nouveautés <news.example.com>',
      'list-unsubscribe': '<mailto:unsub@example.com>, <https://example.com/u/42>',
      'list-unsubscribe-post': 'List-Unsubscribe=One-Click',
      precedence: 'bulk',
    });
    expect(c).toEqual({
      kind: 'list',
      signals: ['List-Id: Nouveautés <news.example.com>', 'List-Unsubscribe', 'Precedence: bulk'],
      unsubscribe: 'https://example.com/u/42',
      oneClickUnsubscribe: true,
    });
  });

  it('an automated message: Auto-Submitted (RFC 3834), Exchange suppress header', () => {
    expect(classifyFromHeaders({ 'auto-submitted': 'auto-replied' })).toMatchObject({
      kind: 'automated',
      signals: ['Auto-Submitted: auto-replied'],
    });
    expect(classifyFromHeaders({ 'x-auto-response-suppress': 'All' })?.kind).toBe('automated');
    expect(classifyFromHeaders({ precedence: 'junk' })?.kind).toBe('automated');
  });

  it('Auto-Submitted: no means written by a human — no hint', () => {
    expect(classifyFromHeaders({ 'auto-submitted': 'no' })).toBeUndefined();
  });

  it('no relevant header (or no headers): undefined', () => {
    expect(classifyFromHeaders({ subject: 'Hi', from: 'a@b.c' })).toBeUndefined();
    expect(classifyFromHeaders(undefined)).toBeUndefined();
  });

  it('header names are matched case-insensitively', () => {
    expect(classifyFromHeaders({ 'List-Id': '<x.example>' })?.kind).toBe('list');
  });
});

describe('formatClassification', () => {
  it('always says the hint comes from unverified sender-set headers', () => {
    const c = classifyFromHeaders({ 'list-unsubscribe': '<https://e.x/u>' });
    if (!c) throw new Error('expected a classification');
    const line = formatClassification(c);
    expect(line).toMatch(/hint/);
    expect(line).toMatch(/sender-set headers, not verified/);
    expect(formatClassification(c, true)).toContain('Unsubscribe: https://e.x/u');
  });
});
