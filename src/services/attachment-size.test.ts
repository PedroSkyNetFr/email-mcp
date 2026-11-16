import { describe, expect, it } from 'vitest';

import { decodedPartSize, extractAttachmentMeta } from './imap.service.js';

// Régression constatée en conditions réelles (2026-11-16) : une image de
// 5 797 octets était annoncée « 7.8KB », soit sa taille encodée en base64
// donnée par BODYSTRUCTURE — et Graph, lui, affiche la taille réelle.
describe('decodedPartSize', () => {
  it('estimates the decoded size of a base64 part', () => {
    // 7 987 octets encodés ≈ 5 836 octets réels (5 797 mesurés : à 1 % près).
    expect(decodedPartSize({ size: 7987, encoding: 'base64' })).toBe(5836);
    expect(decodedPartSize({ size: 7987, encoding: 'BASE64' })).toBe(5836);
  });

  it('keeps the size of non-base64 parts as is', () => {
    expect(decodedPartSize({ size: 1200, encoding: '7bit' })).toBe(1200);
    expect(decodedPartSize({ size: 1200, encoding: 'quoted-printable' })).toBe(1200);
    expect(decodedPartSize({ size: 1200 })).toBe(1200);
    expect(decodedPartSize({})).toBe(0);
  });

  it('is the size listed for an attachment', () => {
    const structure = {
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain', size: 10, encoding: '7bit' },
        {
          part: '2',
          type: 'image/png',
          size: 7987,
          encoding: 'base64',
          disposition: 'attachment',
          dispositionParameters: { filename: 'image001.png' },
        },
      ],
    };
    const [meta] = extractAttachmentMeta(structure);
    expect(meta?.size).toBe(5836);
  });
});
