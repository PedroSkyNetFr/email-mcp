/**
 * Webhook : références du message dans le corps, redirections refusées.
 */

import type { AlertsConfig } from '../types/index.js';
import NotifierService from './notifier.service.js';

vi.mock('@pedroskynet/email-core/logging.js', () => ({
  mcpLog: vi.fn().mockResolvedValue(undefined),
}));

function alertsConfig(overrides: Partial<AlertsConfig> = {}): AlertsConfig {
  return {
    desktop: false,
    sound: false,
    urgencyThreshold: 'high',
    webhookUrl: 'https://hooks.example.com/email',
    webhookEvents: ['urgent', 'high'],
    ...overrides,
  };
}

describe('NotifierService webhook dispatch', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let notifier: NotifierService;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    notifier = new NotifierService(alertsConfig());
  });

  afterEach(() => {
    notifier.stop();
    vi.unstubAllGlobals();
  });

  it('carries uid, folder and hasAttachments in the body', async () => {
    await notifier.alert({
      account: 'work',
      sender: { address: 'a@b.example' },
      subject: 'hi',
      priority: 'high',
      uid: '42',
      folder: 'INBOX',
      hasAttachments: true,
    });

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const [, options] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(options.body)).toMatchObject({
      uid: '42',
      folder: 'INBOX',
      hasAttachments: true,
    });
  });

  it('refuses to follow redirects (a 302 to an internal address after validation)', async () => {
    await notifier.alert({
      account: 'work',
      sender: { address: 'a@b.example' },
      subject: 'hi',
      priority: 'urgent',
    });

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://hooks.example.com/email',
      expect.objectContaining({ redirect: 'error' }),
    );
  });

  it('never sends to a private address', async () => {
    notifier.updateConfig({ webhookUrl: 'http://169.254.169.254/latest/meta-data' });
    await notifier.alert({
      account: 'work',
      sender: { address: 'a@b.example' },
      subject: 'hi',
      priority: 'urgent',
    });
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
