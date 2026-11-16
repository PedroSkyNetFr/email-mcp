/**
 * OAuth2 : un seul rafraîchissement en vol par compte, conservation du jeton
 * de rafraîchissement renvoyé par le fournisseur, consigne sur invalid_grant.
 */

import type { OAuth2Config } from '../types/index.js';
import OAuthService from './oauth.service.js';

function config(): OAuth2Config {
  return {
    provider: 'microsoft',
    clientId: 'client',
    clientSecret: 'secret',
    refreshToken: 'refresh-1',
  };
}

function tokenResponse(body: Record<string, unknown>) {
  return { ok: true, status: 200, json: async () => body, text: async () => '' };
}

describe('OAuthService.getAccessToken', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shares one in-flight refresh between concurrent callers', async () => {
    let answer: (value: unknown) => void = () => {};
    fetchMock.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const service = new OAuthService();
    const oauth2 = config();

    // IMAP, SMTP, IDLE, Graph… qui arrivent ensemble sur un jeton expiré.
    const calls = Array.from({ length: 5 }, async () => service.getAccessToken(oauth2));
    answer(tokenResponse({ access_token: 'access-1', expires_in: 3600 }));

    await expect(Promise.all(calls)).resolves.toEqual(Array(5).fill('access-1'));
    // Avant : cinq requêtes de rafraîchissement.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not pin a failed refresh: the next call retries', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => 'throttled' })
      .mockResolvedValueOnce(tokenResponse({ access_token: 'access-2', expires_in: 3600 }));
    const service = new OAuthService();
    const oauth2 = config();

    await expect(service.getAccessToken(oauth2)).rejects.toThrow('429');
    await expect(service.getAccessToken(oauth2)).resolves.toBe('access-2');
  });

  it('keeps a rotated refresh token for the rest of the process', async () => {
    fetchMock.mockResolvedValue(
      tokenResponse({ access_token: 'access-1', expires_in: 1, refresh_token: 'refresh-2' }),
    );
    const service = new OAuthService();
    const oauth2 = config();

    await service.getAccessToken(oauth2);
    expect(oauth2.refreshToken).toBe('refresh-2');

    // Jeton d'accès quasi expiré (marge de 5 min) : le rafraîchissement
    // suivant présente le NOUVEAU jeton de rafraîchissement.
    await service.getAccessToken(oauth2);
    const body = String((fetchMock.mock.calls[1] as [string, { body: string }])[1].body);
    expect(new URLSearchParams(body).get('refresh_token')).toBe('refresh-2');
  });

  it('keeps the current refresh token when the provider returns none', async () => {
    fetchMock.mockResolvedValue(tokenResponse({ access_token: 'access-1', expires_in: 3600 }));
    const oauth2 = config();
    await new OAuthService().getAccessToken(oauth2);
    expect(oauth2.refreshToken).toBe('refresh-1');
  });

  it('explains invalid_grant as an expired or revoked refresh token', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"error":"invalid_grant","error_description":"AADSTS70008: expired"}',
    });

    await expect(new OAuthService().getAccessToken(config())).rejects.toThrow(
      /expired or revoked: re-authorize/,
    );
  });
});
