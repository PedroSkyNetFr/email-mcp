import type { AccountConfig } from '../types/index.js';
import {
  assertMessageSize,
  base64EncodedSize,
  estimateEncodedMessageSize,
  explainSmtpSizeRejection,
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
  it('no local limit on SMTP by default, 35 MB on Graph, overridable per account', () => {
    expect(maxMessageBytes(account)).toBeUndefined();
    expect(maxMessageBytes({ ...account, backend: 'graph' })).toBe(35 * MB);
    expect(maxMessageBytes({ ...account, maxMessageMb: 50 })).toBe(50 * MB);
    expect(maxMessageBytes({ ...account, backend: 'graph', maxMessageMb: 20 })).toBe(20 * MB);
  });

  it('counts the base64 expansion (a 20 MB file is ~27 MB on the wire)', () => {
    expect(base64EncodedSize(20 * MB)).toBeGreaterThan(27 * MB);
    expect(estimateEncodedMessageSize('', [{ content: Buffer.alloc(3) }])).toBe(6); // 4 car. + CRLF
  });

  it('SMTP without max_message_mb: nothing is refused locally', () => {
    expect(() => assertMessageSize(account, 200 * MB)).not.toThrow();
  });

  it('accepts a message at the limit and refuses one above, listing the attachments', () => {
    const limited = { ...account, maxMessageMb: 25 };
    expect(() => assertMessageSize(limited, 25 * MB)).not.toThrow();
    expect(() =>
      assertMessageSize(limited, 25 * MB + 1, [
        { filename: 'plan.pdf', content: Buffer.alloc(10) },
      ]),
    ).toThrow(/too large.*Nothing was sent.*plan\.pdf.*max_message_mb/s);
  });

  it('explains SMTP size rejections and passes other errors through', () => {
    const sized = explainSmtpSizeRejection(
      Object.assign(new Error('Message size larger than allowed 26214400'), { code: 'EMESSAGE' }),
      account,
      30 * MB,
    ) as Error;
    expect(sized.message).toMatch(/too large.*30\.0 MB.*server limit 25\.0 MB.*Nothing was sent/s);

    const bounced = explainSmtpSizeRejection(
      Object.assign(new Error('Message failed: 552 5.3.4 Message size exceeds fixed limit'), {
        responseCode: 552,
      }),
      account,
      30 * MB,
    ) as Error;
    expect(bounced.message).toMatch(/too large for the SMTP server/);

    const other = new Error('Invalid login');
    expect(explainSmtpSizeRejection(other, account, 1)).toBe(other);
  });
});
