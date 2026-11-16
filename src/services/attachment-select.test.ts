/**
 * Désignation des pièces jointes par partId, refus des noms ambigus, noms
 * uniques à l'envoi — logique commune aux backends IMAP et Graph.
 */

import type { AttachmentMeta } from '../types/index.js';
import {
  describeAttachments,
  realAttachments,
  selectAttachment,
  uniqueAttachmentNames,
} from './attachment-select.js';
import { extractAttachmentMeta, hasAttachments } from './imap.service.js';

const outlook: AttachmentMeta[] = [
  { filename: 'image001.png', mimeType: 'image/png', size: 1000, partId: '2' },
  { filename: 'image001.png', mimeType: 'image/png', size: 2000, partId: '3' },
  { filename: 'devis.pdf', mimeType: 'application/pdf', size: 5000, partId: '4' },
  {
    filename: 'logo.png',
    mimeType: 'image/png',
    size: 300,
    partId: '1.2',
    contentId: 'logo.png@01D9',
    inline: true,
  },
];

describe('selectAttachment', () => {
  it('prefers partId over filename', () => {
    expect(selectAttachment(outlook, { partId: '3', filename: 'devis.pdf' }).size).toBe(2000);
  });

  it('accepts a unique filename (backward compatible bare string)', () => {
    expect(selectAttachment(outlook, 'devis.pdf').partId).toBe('4');
  });

  it('refuses an ambiguous filename and lists name, type, size and partId of each candidate', () => {
    expect(() => selectAttachment(outlook, 'image001.png')).toThrow(
      /Ambiguous attachment name "image001\.png": 2 attachments carry it — image001\.png \(image\/png, 1000B, partId 2\); image001\.png \(image\/png, 2\.0KB, partId 3\)/,
    );
  });

  it('reports an unknown partId with the available ones', () => {
    expect(() => selectAttachment(outlook, { partId: '9' })).toThrow(
      /No attachment with partId "9". Available: .*partId 2/,
    );
  });

  it('reports an unknown filename', () => {
    expect(() => selectAttachment(outlook, 'absent.pdf')).toThrow(
      /Attachment "absent\.pdf" not found/,
    );
  });

  it('requires one of partId / filename', () => {
    expect(() => selectAttachment(outlook, {})).toThrow(/Provide a partId or a filename/);
  });

  it('reaches an inline cid image by partId', () => {
    expect(selectAttachment(outlook, { partId: '1.2' }).inline).toBe(true);
  });
});

describe('uniqueAttachmentNames', () => {
  it('renames the second and third duplicates "name (2).ext", "name (3).ext"', () => {
    const renamed = uniqueAttachmentNames([
      { filename: 'image001.png' },
      { filename: 'image001.png' },
      { filename: 'IMAGE001.PNG' },
      { filename: 'devis.pdf' },
    ]);
    expect(renamed.map((a) => a.filename)).toEqual([
      'image001.png',
      'image001 (2).png',
      'IMAGE001 (3).PNG',
      'devis.pdf',
    ]);
  });

  it('skips a candidate already taken by another attachment', () => {
    const renamed = uniqueAttachmentNames([
      { filename: 'a.pdf' },
      { filename: 'a (2).pdf' },
      { filename: 'a.pdf' },
    ]);
    expect(renamed.map((a) => a.filename)).toEqual(['a.pdf', 'a (2).pdf', 'a (3).pdf']);
  });

  it('leaves inline cid attachments and extension-less names alone or suffixed correctly', () => {
    const renamed = uniqueAttachmentNames([
      { filename: 'logo.png', cid: 'logo' },
      { filename: 'logo.png', cid: 'logo2' },
      { filename: 'README' },
      { filename: 'README' },
    ]);
    expect(renamed.map((a) => a.filename)).toEqual([
      'logo.png',
      'logo.png',
      'README',
      'README (2)',
    ]);
  });
});

describe('describeAttachments / realAttachments', () => {
  it('shows the partId of each part and marks inline images with their cid', () => {
    expect(describeAttachments(outlook.slice(2))).toBe(
      'devis.pdf (application/pdf, 4.9KB, partId 4), ' +
        'logo.png (image/png, 300B, partId 1.2, inline cid:logo.png@01D9)',
    );
  });

  it('drops inline cid images from the "real" attachments', () => {
    expect(realAttachments(outlook).map((a) => a.partId)).toEqual(['2', '3', '4']);
  });
});

describe('extractAttachmentMeta — partId', () => {
  it('gives two same-named Outlook parts distinct partIds', () => {
    const metas = extractAttachmentMeta({
      type: 'multipart/mixed',
      childNodes: [
        { type: 'text/html', size: 10 },
        {
          type: 'image/png',
          size: 1,
          disposition: 'attachment',
          dispositionParameters: { filename: 'image001.png' },
        },
        {
          type: 'image/png',
          size: 2,
          disposition: 'attachment',
          dispositionParameters: { filename: 'image001.png' },
        },
      ],
    });
    expect(metas.map((m) => [m.filename, m.partId])).toEqual([
      ['image001.png', '2'],
      ['image001.png', '3'],
    ]);
  });

  it('numbers a single-part message "1"', () => {
    const metas = extractAttachmentMeta({
      type: 'application/pdf',
      size: 10,
      disposition: 'attachment',
      dispositionParameters: { filename: 'only.pdf' },
    });
    expect(metas[0].partId).toBe('1');
  });

  it('does not count an inline-only message as having attachments', () => {
    const struct = {
      type: 'multipart/related',
      childNodes: [
        { type: 'text/html', size: 10 },
        { type: 'image/png', size: 5, id: '<a@b>', disposition: 'inline' },
      ],
    };
    expect(extractAttachmentMeta(struct)).toHaveLength(1);
    expect(hasAttachments(struct)).toBe(false);
  });

  it('keeps an inline TEXT part with a cid out of the list (it is the body)', () => {
    const struct = {
      type: 'multipart/related',
      childNodes: [{ type: 'text/html', size: 10, id: '<body@x>', disposition: 'inline' }],
    };
    expect(extractAttachmentMeta(struct)).toEqual([]);
  });
});
