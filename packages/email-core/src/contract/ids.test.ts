import { MailError } from './errors.js';
import { decodeId, encodeId } from './ids.js';

describe('contract ids', () => {
  it('round-trips any folder name, accents and separators included', () => {
    const parts = ['Éléments envoyés/2026 "Q1"', 1, 314775];
    const id = encodeId('message', 'imap1', parts);

    expect(id.startsWith('m.imap1.')).toBe(true);
    expect(decodeId(id, 'message', 'imap1')).toEqual(parts);
  });

  it('rejects a folder id passed as a message id, and says so', () => {
    const folderId = encodeId('folder', 'imap1', ['INBOX']);

    expect(() => decodeId(folderId, 'message', 'imap1')).toThrow(MailError);
    expect(() => decodeId(folderId, 'message', 'imap1')).toThrow(/got a folder id/);
  });

  it('rejects an id made by another engine or format version', () => {
    const graphId = encodeId('message', 'graph1', ['AAMk']);

    expect(() => decodeId(graphId, 'message', 'imap1')).toThrow(/made by "graph1"/);
  });

  it('rejects a bare IMAP UID from the old contract', () => {
    expect(() => decodeId('42', 'message', 'imap1')).toThrow(/malformed/);
    expect(() => decodeId(42, 'message', 'imap1')).toThrow(/not a string/);
  });

  it('carries the not-found code, so hosts handle it like a vanished message', () => {
    try {
      decodeId('m.imap1.%%%', 'message', 'imap1');
    } catch (err) {
      expect(err).toBeInstanceOf(MailError);
      expect((err as MailError).code).toBe('not-found');
    }
    expect.assertions(2);
  });
});
