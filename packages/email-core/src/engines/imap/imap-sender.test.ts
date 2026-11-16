import net from 'node:net';
import ConnectionManager from '../../connections/manager.js';
import RateLimiter from '../../safety/rate-limiter.js';
import ImapService from '../../services/imap.service.js';
import SmtpService from '../../services/smtp.service.js';
import type { AccountConfig } from '../../types/index.js';
import ImapMutator from './imap-mutator.js';
import ImapReader from './imap-reader.js';
import ImapSender from './imap-sender.js';

// A real nodemailer transport against a real (tiny) SMTP server on loopback:
// nodemailer's error codes are what is under test, not a fabricated error.

/** Accepts one message, then drops the connection before answering DATA's end. */
async function droppingServer(): Promise<net.Server> {
  const server = net.createServer((socket) => {
    socket.write('220 test ESMTP\r\n');
    let inData = false;
    socket.on('data', (chunk) => {
      const text = chunk.toString();
      if (inData) {
        if (text.includes('\r\n.\r\n')) socket.destroy(); // message received, no answer
        return;
      }
      text
        .split('\r\n')
        .filter(Boolean)
        .forEach((line) => {
          if (/^(EHLO|HELO)/i.test(line)) socket.write('250 test\r\n');
          else if (/^(MAIL|RCPT)/i.test(line)) socket.write('250 OK\r\n');
          else if (/^DATA/i.test(line)) {
            inData = true;
            socket.write('354 go\r\n');
          } else if (/^QUIT/i.test(line)) socket.end('221 bye\r\n');
        });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function senderOn(port: number): { sender: ImapSender; connections: ConnectionManager } {
  const account: AccountConfig = {
    name: 'work',
    email: 'me@example.test',
    username: 'me',
    password: 'x',
    imap: { host: '127.0.0.1', port: 1, tls: false, starttls: false, verifySsl: false },
    smtp: { host: '127.0.0.1', port, tls: false, starttls: false, verifySsl: false },
  };
  const connections = new ConnectionManager([account]);
  const imap = new ImapService(connections);
  const reader = new ImapReader('work', connections, imap);
  const sender = new ImapSender(
    'work',
    connections,
    imap,
    new SmtpService(connections, new RateLimiter(100), imap),
    reader,
    new ImapMutator('work', connections, reader),
  );
  return { sender, connections };
}

const message = { to: ['bob@example.test'], subject: 'Devis', text: 'Bonjour' };

describe('ImapSender: failures after the message may have gone out', () => {
  it('reports a connection dropped after DATA as uncertain, never as a plain error', async () => {
    const server = await droppingServer();
    const { port } = server.address() as net.AddressInfo;
    const { sender, connections } = senderOn(port);

    await expect(sender.send(message)).rejects.toMatchObject({ code: 'uncertain' });
    await connections.closeAll();
    server.close();
  });

  it('does not call a refused connection uncertain: nothing was sent', async () => {
    const server = await droppingServer();
    const { port } = server.address() as net.AddressInfo;
    server.close(); // nobody listens on that port any more
    const { sender, connections } = senderOn(port);

    const error = await sender.send(message).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    expect((error as { code?: string }).code).not.toBe('uncertain');
    await connections.closeAll();
  });
});
