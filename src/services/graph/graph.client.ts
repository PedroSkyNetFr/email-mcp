/**
 * Microsoft Graph HTTP client.
 *
 * Thin transport layer for the Graph-backed mail service: it owns access-token
 * acquisition, paging and throttling, so the service above it deals only in
 * resources.
 *
 * Access tokens are obtained through {@link OAuthService} from the account's
 * `oauth2` block. The refresh exchange deliberately sends no `scope`, so the
 * token comes back for the resource the refresh token was consented for — which
 * means the account must hold a refresh token consented for Graph scopes, not
 * the IMAP/SMTP ones (Microsoft does not let one be redeemed for the other).
 */

import type { AccountConfig } from '../../types/index.js';
import type OAuthService from '../oauth.service.js';

const GRAPH_ROOT = 'https://graph.microsoft.com/v1.0';

/** Graph paging envelope. */
interface GraphPage<T> {
  value: T[];
  '@odata.nextLink'?: string;
}

/** How many pages a single collection walk may fetch before giving up. */
const MAX_PAGES = 50;

export class GraphError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'GraphError';
  }
}

export default class GraphClient {
  constructor(
    private readonly account: AccountConfig,
    private readonly oauthService: OAuthService,
  ) {}

  private async token(): Promise<string> {
    if (!this.account.oauth2) {
      throw new Error(
        `Account "${this.account.name}" is configured with backend "graph" but has no oauth2 ` +
          'block. Run `pnpm oauth:setup` with the microsoft-graph profile and store the refresh ' +
          'token on the account.',
      );
    }
    return this.oauthService.getAccessToken(this.account.oauth2);
  }

  /**
   * Issue a Graph request. Retries once on 429/503 honouring `Retry-After`,
   * which Graph uses liberally; anything else surfaces as a {@link GraphError}
   * carrying the response body, since Graph explains failures in it.
   */
  async request<T>(method: string, pathOrUrl: string, body?: unknown): Promise<T> {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${GRAPH_ROOT}${pathOrUrl}`;

    const send = async (): Promise<Response> => {
      const accessToken = await this.token();
      return fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    };

    let response = await send();

    if (response.status === 429 || response.status === 503) {
      const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '2', 10);
      const waitMs = Math.min(Number.isNaN(retryAfter) ? 2 : retryAfter, 30) * 1000;
      await new Promise((resolve) => {
        setTimeout(resolve, waitMs);
      });
      response = await send();
    }

    if (!response.ok) {
      const text = await response.text();
      // Graph explains the failure in the body — surface it in the message, or
      // the caller only ever sees a bare status code.
      const detail = text.slice(0, 300).replace(/\s+/g, ' ').trim();
      throw new GraphError(
        `Graph ${method} ${url.replace(GRAPH_ROOT, '')} failed (${response.status})` +
          (detail ? `: ${detail}` : ''),
        response.status,
        text,
      );
    }

    // Several Graph writes answer with an empty body — 202 Accepted for
    // sendMail, 204 No Content for deletes — so parsing unconditionally turned
    // a success into "Unexpected end of JSON input". Read the body first and
    // only parse when there is something to parse.
    const text = await response.text();
    return (text.length > 0 ? JSON.parse(text) : undefined) as T;
  }

  /** GET a collection, following `@odata.nextLink` until exhausted or `limit`. */
  async collect<T>(path: string, limit = Number.POSITIVE_INFINITY): Promise<T[]> {
    const out: T[] = [];
    let next: string | undefined = path;

    /* eslint-disable no-await-in-loop -- paging is inherently sequential */
    for (let page = 0; next && page < MAX_PAGES && out.length < limit; page += 1) {
      const chunk: GraphPage<T> = await this.request<GraphPage<T>>('GET', next);
      out.push(...chunk.value);
      next = chunk['@odata.nextLink'];
    }
    /* eslint-enable no-await-in-loop */

    return Number.isFinite(limit) ? out.slice(0, limit) : out;
  }

  /**
   * Attach a file too large to ride inside the message body.
   *
   * Graph refuses an inline `contentBytes` beyond about 3 MB, so anything bigger
   * has to go through an upload session: the message must already exist, and the
   * bytes are PUT in ranged chunks. Chunks must be a multiple of 320 KiB.
   */
  async uploadLargeAttachment(
    messageId: string,
    attachment: { filename: string; contentType: string; content: Buffer; cid?: string },
  ): Promise<void> {
    const session = await this.request<{ uploadUrl: string }>(
      'POST',
      `/me/messages/${messageId}/attachments/createUploadSession`,
      {
        AttachmentItem: {
          attachmentType: 'file',
          name: attachment.filename,
          size: attachment.content.length,
          contentType: attachment.contentType,
          ...(attachment.cid ? { isInline: true, contentId: attachment.cid } : {}),
        },
      },
    );

    const CHUNK = 5 * 320 * 1024; // 1.6 MiB — a multiple of the required 320 KiB
    const total = attachment.content.length;

    /* eslint-disable no-await-in-loop -- ranged upload is inherently sequential */
    for (let start = 0; start < total; start += CHUNK) {
      const end = Math.min(start + CHUNK, total) - 1;
      const slice = attachment.content.subarray(start, end + 1);
      const response = await fetch(session.uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Length': String(slice.length),
          'Content-Range': `bytes ${start}-${end}/${total}`,
        },
        body: new Uint8Array(slice),
      });
      // 200/201 close the session, 202 asks for the next range.
      if (!response.ok) {
        throw new GraphError(
          `Upload of "${attachment.filename}" failed at bytes ${start}-${end} (${response.status})`,
          response.status,
          await response.text(),
        );
      }
    }
    /* eslint-enable no-await-in-loop */
  }

  /** GET raw bytes (attachment content, MIME source). */
  async getBinary(path: string): Promise<Buffer> {
    const accessToken = await this.token();
    const response = await fetch(`${GRAPH_ROOT}${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      throw new GraphError(
        `Graph GET ${path} failed (${response.status})`,
        response.status,
        await response.text(),
      );
    }
    return Buffer.from(await response.arrayBuffer());
  }
}
