import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AccountConfig } from '../../types/index.js';
import type OAuthService from '../oauth.service.js';
import GraphClient, { GraphError } from './graph.client.js';

const account: AccountConfig = {
  name: 'work',
  email: 'you@example.com',
  username: 'you@example.com',
  backend: 'graph',
  oauth2: {
    provider: 'custom',
    clientId: 'id',
    clientSecret: 'secret',
    refreshToken: 'refresh',
  },
  imap: { host: '', port: 993, tls: true, starttls: false, verifySsl: true },
  smtp: { host: '', port: 465, tls: true, starttls: false, verifySsl: true },
};

const oauthService = {
  getAccessToken: async () => 'access-token',
} as unknown as OAuthService;

function client(): GraphClient {
  return new GraphClient(account, oauthService);
}

/** Minimal Response stand-in — only what GraphClient touches. */
function response(status: number, body: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GraphClient.request', () => {
  // Regression: sendMail answers 202 with an empty body, and parsing it
  // unconditionally reported "Unexpected end of JSON input" for a mail that had
  // in fact been sent — the worst kind of failure, since it invites a resend.
  it('accepts an empty 202 body without throwing (sendMail)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(202, '')));
    await expect(client().request('POST', '/me/sendMail', { message: {} })).resolves.toBeUndefined();
  });

  it('accepts an empty 204 body without throwing (delete)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(204, '')));
    await expect(client().request('DELETE', '/me/messages/abc')).resolves.toBeUndefined();
  });

  it('parses a JSON body when there is one', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(200, '{"id":"abc"}')));
    await expect(client().request('GET', '/me/messages/abc')).resolves.toEqual({ id: 'abc' });
  });

  it('surfaces the response body on failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(403, '{"error":"forbidden"}')));
    await expect(client().request('GET', '/me/messages')).rejects.toThrow(GraphError);
    await expect(client().request('GET', '/me/messages')).rejects.toThrow(/403/);
  });

  it('sends the bearer token and serializes the body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(200, '{}'));
    vi.stubGlobal('fetch', fetchMock);

    await client().request('POST', '/me/sendMail', { message: { subject: 'hi' } });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://graph.microsoft.com/v1.0/me/sendMail');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer access-token');
    expect(init.body).toBe('{"message":{"subject":"hi"}}');
  });
});
