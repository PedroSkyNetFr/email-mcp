/**
 * OAuth2 token management service.
 *
 * Handles token refresh and caching for Google and Microsoft OAuth2/XOAUTH2.
 * Uses native fetch (Node 22+) — no external HTTP dependencies.
 */

import type { OAuth2Config } from '../types/index.js';

// ---------------------------------------------------------------------------
// Provider endpoint configs
// ---------------------------------------------------------------------------

interface ProviderEndpoints {
  tokenUrl: string;
  authUrl: string;
  scopes: string[];
}

const PROVIDER_ENDPOINTS: Record<string, ProviderEndpoints> = {
  google: {
    tokenUrl: 'https://oauth2.googleapis.com/token',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    scopes: ['https://mail.google.com/'],
  },
  microsoft: {
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    scopes: [
      'https://outlook.office.com/IMAP.AccessAsUser.All',
      'https://outlook.office.com/SMTP.Send',
      'offline_access',
    ],
  },
};

/** 5-minute safety buffer before token expiry */
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

export default class OAuthService {
  /**
   * Rafraîchissements en cours, indexés par l'objet de configuration OAuth2
   * qu'ils concernent.
   *
   * Plusieurs appelants partagent un même compte : client IMAP, transport SMTP,
   * veille IDLE, client Graph. À l'expiration du jeton, ils arrivent ensemble
   * et lançaient chacun leur propre rafraîchissement. Ce n'est pas qu'une
   * requête gaspillée : un fournisseur qui fait tourner le jeton de
   * rafraîchissement à chaque usage invalide la copie des perdants, et
   * Microsoft limite le débit des rafraîchissements — le compte pouvait finir
   * incapable de s'authentifier. Les appelants concurrents reçoivent désormais
   * la même promesse. `WeakMap` : une configuration abandonnée n'est pas
   * retenue en mémoire.
   */
  private pendingRefreshes = new WeakMap<OAuth2Config, Promise<string>>();

  /**
   * Get a valid access token, refreshing if expired.
   */
  async getAccessToken(oauth2: OAuth2Config): Promise<string> {
    if (!OAuthService.isTokenExpired(oauth2) && oauth2.accessToken) {
      return oauth2.accessToken;
    }

    const inFlight = this.pendingRefreshes.get(oauth2);
    if (inFlight) return inFlight;

    const refresh = (async () => {
      const result = await OAuthService.refreshAccessToken(oauth2);

      // Cache on the config object (in-memory only). Les appelants partagent
      // cet objet : un rafraîchissement sert tous les détenteurs du compte.
      Object.assign(oauth2, {
        accessToken: result.accessToken,
        tokenExpiry: Date.now() + result.expiresIn * 1000,
        // Rotation du jeton de rafraîchissement (Microsoft en renvoie souvent
        // un nouveau) : le garder pour la suite du processus. L'ancien reste
        // en général valable jusqu'à son expiration, mais le nouveau est celui
        // que le fournisseur attend. Il n'est PAS réécrit dans config.toml —
        // aucun mécanisme de stockage de jetons n'existe ; après redémarrage,
        // le jeton du fichier (ou de la *_command) est relu.
        ...(result.refreshToken ? { refreshToken: result.refreshToken } : {}),
      });

      return result.accessToken;
    })();

    this.pendingRefreshes.set(oauth2, refresh);
    try {
      return await refresh;
    } finally {
      // Retirée sur échec aussi : un rafraîchissement refusé une fois (débit
      // limité, coupure) ne doit pas faire échouer toutes les tentatives
      // suivantes jusqu'au redémarrage.
      this.pendingRefreshes.delete(oauth2);
    }
  }

  /**
   * Check if the cached access token is expired or missing.
   */
  static isTokenExpired(oauth2: OAuth2Config): boolean {
    if (!oauth2.accessToken || !oauth2.tokenExpiry) return true;
    return Date.now() >= oauth2.tokenExpiry - TOKEN_EXPIRY_BUFFER_MS;
  }

  /**
   * Exchange refresh token for a new access token.
   */
  static async refreshAccessToken(
    oauth2: OAuth2Config,
  ): Promise<{ accessToken: string; expiresIn: number; refreshToken?: string }> {
    const endpoints = OAuthService.getProviderEndpoints(oauth2);

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: oauth2.clientId,
      client_secret: oauth2.clientSecret,
      refresh_token: oauth2.refreshToken,
    });

    const response = await fetch(endpoints.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      // `invalid_grant` : jeton de rafraîchissement expiré, révoqué, ou
      // consentement retiré — le seul remède est une nouvelle autorisation.
      // Le dire évite de chercher du côté du mot de passe ou du réseau.
      const hint = /invalid_grant/i.test(text)
        ? ' — the refresh token is expired or revoked: re-authorize (pnpm oauth:setup) ' +
          'and store the new refresh token on the account.'
        : '';
      throw new Error(`OAuth2 token refresh failed (${response.status}): ${text}${hint}`);
    }

    const data = (await response.json()) as {
      access_token: string;
      expires_in: number;
      refresh_token?: string;
    };

    return {
      accessToken: data.access_token,
      expiresIn: data.expires_in,
      ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}),
    };
  }

  /**
   * Get provider endpoints for token exchange and authorization.
   */
  static getProviderEndpoints(oauth2: OAuth2Config): ProviderEndpoints {
    if (oauth2.provider === 'custom') {
      if (!oauth2.tokenUrl || !oauth2.authUrl) {
        throw new Error('Custom OAuth2 provider requires tokenUrl and authUrl');
      }
      return {
        tokenUrl: oauth2.tokenUrl,
        authUrl: oauth2.authUrl,
        scopes: oauth2.scopes ?? [],
      };
    }

    const endpoints = PROVIDER_ENDPOINTS[oauth2.provider];
    if (!endpoints) {
      throw new Error(`Unknown OAuth2 provider: ${oauth2.provider}`);
    }
    return endpoints;
  }

  /**
   * Generate an OAuth2 authorization URL for the CLI setup wizard.
   */
  static generateAuthUrl(oauth2: OAuth2Config, redirectUri: string): string {
    const endpoints = OAuthService.getProviderEndpoints(oauth2);
    const params = new URLSearchParams({
      client_id: oauth2.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: endpoints.scopes.join(' '),
      access_type: 'offline',
      prompt: 'consent',
    });
    return `${endpoints.authUrl}?${params.toString()}`;
  }

  /**
   * Exchange an authorization code for tokens (initial setup).
   */
  static async exchangeCode(
    oauth2: OAuth2Config,
    code: string,
    redirectUri: string,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const endpoints = OAuthService.getProviderEndpoints(oauth2);

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: oauth2.clientId,
      client_secret: oauth2.clientSecret,
      code,
      redirect_uri: redirectUri,
    });

    const response = await fetch(endpoints.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OAuth2 code exchange failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
    };
  }
}
