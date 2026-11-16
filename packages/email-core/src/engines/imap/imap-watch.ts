/**
 * `waitForChange` for IMAP: a wake-up when a watched folder may have changed.
 *
 * One connection per watched folder, kept open between waits: IMAP IDLE
 * watches the selected folder only, and imapflow enters IDLE by itself once a
 * folder is open and the connection is free, then emits `exists` (new mail),
 * `expunge` (removal) and `flags` (flag change). A wait resolves on the first
 * of them; the host then calls `listChanges`, which says what changed.
 *
 * A wake-up carries no data, so a missed one loses nothing: a change made
 * between a host's `listChanges` and its next wait is caught by the next
 * `listChanges` at the latest when the wait times out — the host must call it
 * after a `timeout` too. `maxMs` bounds that delay.
 */

import type { ImapFlow } from 'imapflow';
import type { IConnectionManager } from '../../connections/types.js';
import type { FolderId, WaitResult } from '../../contract/engine.types.js';
import { MailError } from '../../contract/errors.js';
import { pathOf, toMailError } from './imap-reader.js';

/** Each folder holds a connection: beyond this, poll instead. */
export const MAX_WATCHED_FOLDERS = 10;

const CHANGE_EVENTS = ['exists', 'expunge', 'flags'] as const;

export default class ImapWatch {
  private readonly clients = new Map<string, ImapFlow>();

  /** Connections being opened: two waits at once share one instead of leaking one. */
  private readonly opening = new Map<string, Promise<ImapFlow>>();

  constructor(
    readonly account: string,
    private readonly connections: IConnectionManager,
  ) {}

  /** The open, idling connection of a folder; reopened when the server dropped it. */
  private async watcher(path: string): Promise<ImapFlow> {
    const existing = this.clients.get(path);
    if (existing?.usable) return existing;
    const pending = this.opening.get(path);
    if (pending) return pending;
    const open = (async () => {
      const client = await this.connections.createEphemeralImapClient(this.account);
      try {
        // Opened read-only, and kept open: imapflow idles on the selected folder.
        const lock = await client.getMailboxLock(path, { readOnly: true });
        lock.release();
      } catch (err) {
        await client.logout().catch(() => client.close());
        throw err;
      }
      this.clients.set(path, client);
      return client;
    })();
    this.opening.set(path, open);
    try {
      return await open;
    } finally {
      this.opening.delete(path);
    }
  }

  async waitForChange(options: {
    folderIds: FolderId[];
    maxMs: number;
    signal?: AbortSignal;
  }): Promise<WaitResult> {
    const paths = [...new Set(options.folderIds.map(pathOf))];
    if (paths.length > MAX_WATCHED_FOLDERS) {
      throw new MailError(
        'unsupported',
        `At most ${MAX_WATCHED_FOLDERS} folders can be watched at once (one connection each); ` +
          'poll listChanges for the others',
      );
    }
    if (options.signal?.aborted) return 'aborted';

    let clients: ImapFlow[];
    try {
      clients = await Promise.all(paths.map(async (path) => this.watcher(path)));
    } catch (err) {
      throw toMailError(err);
    }
    if (clients.some((client) => !client.capabilities.has('IDLE'))) return 'unsupported';
    // Aborted while the connections were opening: the listener below would
    // come too late and the wait would run until maxMs.
    if (options.signal?.aborted) return 'aborted';
    // imapflow enters IDLE by itself only after 15 s without commands
    // (AUTO_IDLE_DELAY): a watch connection exists to idle, so start now.
    // Already idling: a no-op. The promise settles when IDLE ends.
    clients.forEach((client) => {
      client.idle().catch(() => undefined);
    });

    return new Promise<WaitResult>((resolve) => {
      const detach: (() => void)[] = [];
      const finish = (result: WaitResult): void => {
        detach.forEach((off) => {
          off();
        });
        resolve(result);
      };
      clients.forEach((client) => {
        const onChange = (): void => finish('changed');
        // A dropped connection may hide a change: wake the host up to look.
        const onClose = (): void => finish('changed');
        CHANGE_EVENTS.forEach((event) => {
          client.on(event, onChange);
        });
        client.on('close', onClose);
        detach.push(() => {
          CHANGE_EVENTS.forEach((event) => {
            client.off(event, onChange);
          });
          client.off('close', onClose);
        });
      });
      const timer = setTimeout(() => finish('timeout'), Math.max(options.maxMs, 0));
      detach.push(() => clearTimeout(timer));
      if (options.signal) {
        const onAbort = (): void => finish('aborted');
        options.signal.addEventListener('abort', onAbort, { once: true });
        detach.push(() => options.signal?.removeEventListener('abort', onAbort));
      }
    });
  }

  async close(): Promise<void> {
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(clients.map(async (client) => client.logout().catch(() => client.close())));
  }
}
