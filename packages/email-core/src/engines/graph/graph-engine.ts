/**
 * The Microsoft Graph engine of one account, on the MailEngine contract:
 * reading (graph-reader), search (graph-search), changes (graph-mutator),
 * drafts and sending (graph-sender), synchronisation (graph-sync).
 *
 * No push: Graph change notifications need a public webhook endpoint, which a
 * desktop or LAN host does not have. `waitForChange` answers `unsupported`
 * and `capabilities().realtime` is `poll`: the host calls `listChanges`
 * regularly (a delta query that found nothing is one request).
 */

import type { MailEngine } from '../../contract/engine.types.js';
import type GraphClient from '../../services/graph/graph.client.js';
import type GraphService from '../../services/graph/graph.service.js';
import type GraphSendService from '../../services/graph/graph-send.service.js';
import type { AccountConfig } from '../../types/index.js';
import GraphMutator from './graph-mutator.js';
import GraphReader from './graph-reader.js';
import GraphSearch from './graph-search.js';
import GraphSender from './graph-sender.js';
import GraphSync from './graph-sync.js';

export default function createGraphEngine(
  account: string,
  client: GraphClient,
  graph: GraphService,
  graphSend: GraphSendService,
  config: () => AccountConfig,
): MailEngine {
  const reader = new GraphReader(account, client, graph, config);
  const search = new GraphSearch(client);
  const mutator = new GraphMutator(client, reader);
  const sender = new GraphSender(account, client, graph, graphSend, reader, mutator, config);
  const sync = new GraphSync(client);

  return {
    account,
    capabilities: async () => reader.capabilities(),
    listFolders: async () => reader.listFolders(),
    listMessages: async (folderId, options) => reader.listMessages(folderId, options),
    search: async (query, options) => search.search(query, options),
    getMessage: async (id) => reader.getMessage(id),
    getRaw: async (id) => reader.getRaw(id),
    getAttachment: async (id, partId) => reader.getAttachment(id, partId),
    getThread: async (id) => reader.getThread(id),
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
    waitForChange: async () => 'unsupported',
    close: async () => undefined,
  };
}
