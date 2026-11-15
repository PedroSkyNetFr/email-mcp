import type { AccountConfig } from '../types/index.js';
import {
  assertMessageSize,
  base64EncodedSize,
  estimateEncodedMessageSize,
  maxMessageBytes,
} from './send-limit.js';

const account = {
  name: 'perso',
  email: 'a@example.com',
  username: 'a',
  imap: { host: 'i', port: 993, tls: true, starttls: false, verifySsl: true },
  smtp: { host: 's', port: 465, tls: true, starttls: false, verifySsl: true },
} as AccountConfig;

const MB = 1024 * 1024;

describe('send-limit', () => {
  it('defaults to 25 MB on SMTP and 35 MB on Graph, overridable per account', () => {
    expect(maxMessageBytes(account)).toBe(25 * MB);
    expect(maxMessageBytes({ ...account, backend: 'graph' })).toBe(35 * MB);
    expect(maxMessageBytes({ ...account, maxMessageMb: 50 })).toBe(50 * MB);
  });

  it('counts the base64 expansion (a 20 MB file is ~27 MB on the wire)', () => {
    expect(base64EncodedSize(20 * MB)).toBeGreaterThan(27 * MB);
    expect(estimateEncodedMessageSize('', [{ content: Buffer.alloc(3) }])).toBe(6); // 4 car. + CRLF
  });

  it('accepts a message at the limit and refuses one above, listing the attachments', () => {
    expect(() => assertMessageSize(account, 25 * MB)).not.toThrow();
    expect(() =>
      assertMessageSize(account, 25 * MB + 1, [
        { filename: 'plan.pdf', content: Buffer.alloc(10) },
      ]),
    ).toThrow(/too large.*Nothing was sent.*plan\.pdf.*max_message_mb/s);
  });
});
