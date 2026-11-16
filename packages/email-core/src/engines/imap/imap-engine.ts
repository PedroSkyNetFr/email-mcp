/**
 * The IMAP + SMTP engine of one account, on the MailEngine contract.
 *
 * An assembly of the engine's parts, each in its own module: reading
 * (imap-reader), search and threads (imap-search), changes (imap-mutator),
 * drafts and sending (imap-sender), synchronisation (imap-sync) and wake-ups
 * (imap-watch). Shared state is limited to the connections: the reader,
 * search, mutator and sender use the account's cached connection, the sync
 * and the watch their own (see their headers).
 */

import type { IConnectionManager } from '../../connections/types.js';
import type { MailEngine } from '../../contract/engine.types.js';
import type ImapService from '../../services/imap.service.js';
import type SmtpService from '../../services/smtp.service.js';
import ImapMutator from './imap-mutator.js';
import ImapReader from './imap-reader.js';
import ImapSearch from './imap-search.js';
import ImapSender from './imap-sender.js';
import ImapSync from './imap-sync.js';
import ImapWatch from './imap-watch.js';

export default function createImapEngine(
  account: string,
  connections: IConnectionManager,
  imap: ImapService,
  smtp: SmtpService,
): MailEngine {
  const reader = new ImapReader(account, connections, imap);
  const search = new ImapSearch(account, connections, imap, reader);
  const mutator = new ImapMutator(account, connections, reader);
  const sender = new ImapSender(account, connections, imap, smtp, reader, mutator);
  const sync = new ImapSync(account, connections);
  const watch = new ImapWatch(account, connections);

  return {
    account,
    capabilities: async () => reader.capabilities(),
    listFolders: async () => reader.listFolders(),
    listMessages: async (folderId, options) => reader.listMessages(folderId, options),
    search: async (query, options) => search.search(query, options),
    getMessage: async (id) => reader.getMessage(id),
    getRaw: async (id) => reader.getRaw(id),
    getAttachment: async (id, partId) => reader.getAttachment(id, partId),
    getThread: async (id) => search.getThread(id),
    setFlags: async (ids, change) => mutator.setFlags(ids, change),
    move: async (ids, to) => mutator.move(ids, to),
    copy: async (ids, to) => mutator.copy(ids, to),
    delete: async (ids, options) => mutator.delete(ids, options),
    createFolder: async (name, parentId) => mutator.createFolder(name, parentId),
    renameFolder: async (id, name) => mutator.renameFolder(id, name),
    deleteFolder: async (id) => mutator.deleteFolder(id),
    saveDraft: async (draft, replaces) => sender.saveDraft(draft, replaces),
    deleteDraft: async (id) => sender.deleteDraft(id),
    send: async (message) => sender.send(message),
    sendDraft: async (id) => sender.sendDraft(id),
    prepareReply: async (id, options) => sender.prepareReply(id, options),
    prepareForward: async (id, options) => sender.prepareForward(id, options),
    listChanges: async (folderId, cursor, options) => sync.listChanges(folderId, cursor, options),
    waitForChange: async (options) => watch.waitForChange(options),
    close: async () => {
      await Promise.all([sync.close(), watch.close()]);
    },
  };
}
