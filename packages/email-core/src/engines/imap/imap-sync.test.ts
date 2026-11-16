import type { IConnectionManager } from '../../connections/types.js';
import { folderIdOf } from './imap-reader.js';
import ImapSync from './imap-sync.js';

describe('ImapSync.close', () => {
  it('refuses calls after close instead of reopening a connection nobody closes', async () => {
    const createEphemeralImapClient = vi.fn();
    const sync = new ImapSync('work', {
      createEphemeralImapClient,
    } as unknown as IConnectionManager);

    await sync.close();

    await expect(sync.listChanges(folderIdOf('INBOX'), null)).rejects.toMatchObject({
      code: 'invalid',
    });
    expect(createEphemeralImapClient).not.toHaveBeenCalled();
  });
});
