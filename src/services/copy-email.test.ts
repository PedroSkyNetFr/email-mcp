/**
 * copy_email — copie dans un autre dossier du même compte, original intact,
 * sur IMAP (COPY serveur) et sur Graph (`POST /me/messages/{id}/copy`).
 */

import type { IConnectionManager } from '../connections/types.js';
import { crossAccountCopyRefusal } from '../tools/manage.tool.js';
import type { AccountConfig } from '../types/index.js';
import type GraphClient from './graph/graph.client.js';
import GraphService from './graph/graph.service.js';
import ImapService from './imap.service.js';

function imapSetup() {
  const release = vi.fn();
  const client = {
    usable: true,
    list: vi.fn().mockResolvedValue([{ path: 'INBOX', specialUse: '\\Inbox' }]),
    getMailboxLock: vi.fn().mockResolvedValue({ release }),
    messageCopy: vi.fn().mockResolvedValue({
      path: 'INBOX',
      destination: 'Archive',
      uidMap: new Map([[42, 901]]),
    }),
    messageMove: vi.fn(),
    messageDelete: vi.fn(),
    messageFlagsAdd: vi.fn(),
  };
  const connections = {
    getAccount: vi.fn(),
    getAccountNames: vi.fn().mockReturnValue(['test']),
    getImapClient: vi.fn().mockResolvedValue(client),
    createEphemeralImapClient: vi.fn(),
    getSmtpTransport: vi.fn(),
    closeAll: vi.fn(),
  } satisfies IConnectionManager;
  return { service: new ImapService(connections), client, release };
}

describe('ImapService.copyEmail', () => {
  it('copies server-side and reports the new UID (UIDPLUS), leaving the source alone', async () => {
    const { service, client, release } = imapSetup();

    const result = await service.copyEmail('test', '42', 'INBOX', 'Archive');

    expect(result).toEqual({ newId: '901' });
    expect(client.messageCopy).toHaveBeenCalledWith('42', 'Archive', { uid: true });
    expect(client.messageMove).not.toHaveBeenCalled();
    expect(client.messageDelete).not.toHaveBeenCalled();
    expect(client.messageFlagsAdd).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalled();
  });

  it('succeeds without a new id when the server has no UIDPLUS', async () => {
    const { service, client } = imapSetup();
    client.messageCopy.mockResolvedValue({ path: 'INBOX', destination: 'Archive' });

    await expect(service.copyEmail('test', '42', 'INBOX', 'Archive')).resolves.toEqual({});
  });

  it('throws when the server rejects the COPY', async () => {
    const { service, client, release } = imapSetup();
    client.messageCopy.mockResolvedValue(false);

    await expect(service.copyEmail('test', '42', 'INBOX', 'Nope')).rejects.toThrow(
      /rejected the copy/,
    );
    expect(release).toHaveBeenCalled();
  });

  it('refuses a virtual source folder', async () => {
    const { service, client } = imapSetup();
    client.list.mockResolvedValue([{ path: '[Gmail]/All Mail', specialUse: '\\All' }]);

    await expect(service.copyEmail('test', '42', '[Gmail]/All Mail', 'Archive')).rejects.toThrow(
      /virtual folder/,
    );
    expect(client.messageCopy).not.toHaveBeenCalled();
  });
});

const graphAccount: AccountConfig = {
  name: 'work',
  email: 'me@contoso.com',
  username: 'me@contoso.com',
  backend: 'graph',
  imap: { host: '', port: 993, tls: true, starttls: false, verifySsl: true },
  smtp: { host: '', port: 465, tls: true, starttls: false, verifySsl: true },
};

describe('GraphService.copyEmail', () => {
  function graphSetup() {
    const client = {
      request: vi.fn().mockResolvedValue({ id: 'COPY1' }),
      collect: vi.fn().mockResolvedValue([
        { id: 'F-ARCH', displayName: 'Archive', childFolderCount: 0 },
        { id: 'F-INBOX', displayName: 'Inbox', childFolderCount: 0 },
      ]),
    };
    const service = new GraphService(
      new Map([['work', client as unknown as GraphClient]]),
      () => graphAccount,
    );
    return { client, service };
  }

  it('POSTs /copy with the resolved folder id and returns the copy id', async () => {
    const { client, service } = graphSetup();

    const result = await service.copyEmail('work', 'MSG1', 'INBOX', 'Archive');

    expect(result).toEqual({ newId: 'COPY1' });
    expect(client.request).toHaveBeenCalledTimes(1);
    expect(client.request).toHaveBeenCalledWith('POST', '/me/messages/MSG1/copy', {
      destinationId: 'F-ARCH',
    });
  });

  it('fails clearly on an unknown destination folder, without calling /copy', async () => {
    const { client, service } = graphSetup();

    await expect(service.copyEmail('work', 'MSG1', 'INBOX', 'Nowhere')).rejects.toThrow(
      /Mailbox "Nowhere" not found/,
    );
    expect(client.request).not.toHaveBeenCalled();
  });
});

describe('crossAccountCopyRefusal (copy_email)', () => {
  it('points a cross-account request at cross_account_copy', () => {
    expect(crossAccountCopyRefusal('a', 'b')).toMatch(/use cross_account_copy/);
  });

  it('accepts an absent or identical destination account', () => {
    expect(crossAccountCopyRefusal('a')).toBeNull();
    expect(crossAccountCopyRefusal('a', 'a')).toBeNull();
  });
});
