/**
 * Hooks : ordre des arguments de setFlags, lecture seule, désabonnement ciblé,
 * références du message transmises aux alertes.
 */

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { EmailMeta, HooksConfig } from '../types/index.js';
import eventBus from './event-bus.js';
import HooksService from './hooks.service.js';
import type ImapService from './imap.service.js';
import NotifierService from './notifier.service.js';

vi.mock('../logging.js', () => ({
  mcpLog: vi.fn().mockResolvedValue(undefined),
}));

function hooksConfig(overrides: Partial<HooksConfig> = {}): HooksConfig {
  return {
    onNewEmail: 'notify',
    preset: 'priority-focus',
    autoLabel: true,
    autoFlag: true,
    batchDelay: 1,
    rules: [
      {
        name: 'VIP',
        match: { from: '*@vip.example' },
        actions: { labels: ['VIP'], flag: true, markRead: true },
      },
    ],
    alerts: {
      desktop: false,
      sound: false,
      urgencyThreshold: 'high',
      webhookUrl: '',
      webhookEvents: ['urgent', 'high'],
    },
    autoCalendar: false,
    calendarName: '',
    calendarAlarmMinutes: 15,
    calendarConfirm: true,
    ...overrides,
  };
}

const meta: EmailMeta = {
  id: '4242',
  subject: 'Hello',
  from: { address: 'boss@vip.example' },
  to: [{ address: 'me@example.com' }],
  date: new Date().toISOString(),
  seen: false,
  flagged: false,
  answered: false,
  hasAttachments: true,
  labels: [],
};

function fakeImap() {
  return {
    addLabel: vi.fn().mockResolvedValue(undefined),
    setFlags: vi.fn().mockResolvedValue(undefined),
  };
}

const fakeServer = {
  sendResourceUpdated: vi.fn().mockResolvedValue(undefined),
} as unknown as Server;

/** Émet un nouveau message et laisse passer le délai de regroupement. */
async function deliver(): Promise<void> {
  eventBus.emit('email:new', { account: 'work', mailbox: 'INBOX', emails: [meta] });
  await vi.advanceTimersByTimeAsync(1_000);
}

describe('HooksService static rules', () => {
  let alertSpy: ReturnType<typeof vi.spyOn>;
  let hooks: HooksService | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    alertSpy = vi.spyOn(NotifierService.prototype, 'alert').mockResolvedValue(undefined);
  });

  afterEach(() => {
    hooks?.stop();
    hooks = undefined;
    alertSpy.mockRestore();
    vi.useRealTimers();
  });

  it('calls setFlags(account, emailId, mailbox, action) in that order', async () => {
    const imap = fakeImap();
    hooks = new HooksService(hooksConfig(), imap as unknown as ImapService);
    hooks.start(fakeServer, { sampling: false });

    await deliver();

    // Avant : setFlags('work', 'INBOX', '4242', …) — dossier et UID inversés.
    expect(imap.setFlags).toHaveBeenCalledWith('work', '4242', 'INBOX', 'flag');
    expect(imap.setFlags).toHaveBeenCalledWith('work', '4242', 'INBOX', 'read');
    expect(imap.addLabel).toHaveBeenCalledWith('work', '4242', 'INBOX', 'VIP');
  });

  it('logs the cause when a flag action fails instead of swallowing it', async () => {
    const { mcpLog } = await import('../logging.js');
    const imap = fakeImap();
    imap.setFlags.mockRejectedValue(new Error('NO [CANNOT] read-only folder'));
    hooks = new HooksService(hooksConfig(), imap as unknown as ImapService);
    hooks.start(fakeServer, { sampling: false });

    await deliver();

    expect(mcpLog).toHaveBeenCalledWith(
      'warning',
      'hooks',
      expect.stringContaining('NO [CANNOT] read-only folder'),
    );
  });

  it('read_only: no mailbox change, but the alert still goes out', async () => {
    const imap = fakeImap();
    hooks = new HooksService(hooksConfig(), imap as unknown as ImapService, { readOnly: true });
    hooks.start(fakeServer, { sampling: false });

    await deliver();

    expect(imap.addLabel).not.toHaveBeenCalled();
    expect(imap.setFlags).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledTimes(1);
  });

  it('passes uid, folder and hasAttachments to the alert', async () => {
    hooks = new HooksService(hooksConfig(), fakeImap() as unknown as ImapService);
    hooks.start(fakeServer, { sampling: false });

    await deliver();

    expect(alertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ uid: '4242', folder: 'INBOX', hasAttachments: true }),
      false,
    );
  });

  it('stop() detaches only its own email:new listener', () => {
    const other = vi.fn();
    eventBus.on('email:new', other);
    hooks = new HooksService(hooksConfig(), fakeImap() as unknown as ImapService);
    hooks.start(fakeServer, { sampling: false });

    hooks.stop();
    eventBus.emit('email:new', { account: 'work', mailbox: 'INBOX', emails: [] });

    // Avant : removeAllListeners désabonnait aussi les autres consommateurs.
    expect(other).toHaveBeenCalledTimes(1);
    eventBus.off('email:new', other);
  });
});
