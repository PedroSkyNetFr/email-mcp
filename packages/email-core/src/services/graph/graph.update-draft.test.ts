/* eslint-disable n/no-sync -- tests use sync fs helpers for setup/teardown */
/**
 * update_draft côté Graph : même contrat de signature que sur IMAP.
 * Jamais implicite, ajoutée sous le nouveau corps sur demande seulement, et les
 * images inline (cid) suivent le corps (pas d'orphelines, pas de doublons).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccountConfig } from '../../types/index.js';
import type GraphClient from './graph.client.js';
import GraphService from './graph.service.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const SIG_CID = 'image001.png@01D9.ABC';

function writeSignature(dir: string): string {
  const filesDir = join(dir, 'sig_fichiers');
  mkdirSync(filesDir, { recursive: true });
  writeFileSync(join(filesDir, 'image001.png'), PNG);
  const htmPath = join(dir, 'sig.htm');
  writeFileSync(
    htmPath,
    `<html><body><!--[if gte vml 1]><v:imagedata src="sig_fichiers/image001.png" o:href="cid:${SIG_CID}"><![endif]-->
<img src="sig_fichiers/image001.png"><p>Jane Doe</p></body></html>`,
  );
  return htmPath;
}

describe('GraphService.updateDraft — signature du compte', () => {
  let tmp: string;
  let request: ReturnType<typeof vi.fn>;
  let collect: ReturnType<typeof vi.fn>;
  let service: GraphService;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'graph-upd-sig-'));
    const account = {
      name: 'work',
      email: 'you@example.com',
      username: 'you@example.com',
      backend: 'graph',
      signaturePath: writeSignature(tmp),
      signatureDefault: true,
      imap: { host: '', port: 993, tls: true, starttls: false, verifySsl: true },
      smtp: { host: '', port: 465, tls: true, starttls: false, verifySsl: true },
    } as AccountConfig;
    request = vi
      .fn()
      .mockImplementation(async (method: string) =>
        method === 'GET' ? { body: { contentType: 'html' } } : {},
      );
    // Le brouillon porte déjà l'image inline de sa signature.
    collect = vi
      .fn()
      .mockResolvedValue([
        { id: 'att-1', name: 'image001.png', contentId: SIG_CID, isInline: true },
      ]);
    const client = { request, collect } as unknown as GraphClient;
    service = new GraphService(new Map([['work', client]]), () => account);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const patchBody = () =>
    request.mock.calls.find(([method]) => method === 'PATCH')?.[2] as
      | { subject?: string; body?: { contentType: string; content: string } }
      | undefined;

  it("sujet seul : le corps n'est pas touché et aucune signature n'est ajoutée", async () => {
    await service.updateDraft('work', 'msg-1', { subject: '[TEST] sujet' });

    expect(patchBody()).toEqual({ subject: '[TEST] sujet' });
    expect(request.mock.calls.some(([m]) => m === 'POST' || m === 'DELETE')).toBe(false);
  });

  it("nouveau corps : signature_default n'est pas appliqué, le type HTML est hérité", async () => {
    await service.updateDraft('work', 'msg-1', { body: 'Version 2' });

    expect(patchBody()?.body).toEqual({ contentType: 'HTML', content: 'Version 2' });
    // L'image de l'ancienne signature n'est plus référencée : retirée.
    expect(request).toHaveBeenCalledWith('DELETE', '/me/messages/msg-1/attachments/att-1');
    expect(request.mock.calls.some(([m]) => m === 'POST')).toBe(false);
  });

  it('nouveau corps + append_signature:true : signature une fois, image remplacée sans doublon', async () => {
    await service.updateDraft('work', 'msg-1', { body: 'Version 2', appendSignature: true });

    const content = patchBody()?.body?.content ?? '';
    expect(content.split('Jane Doe')).toHaveLength(2);
    expect(content).toContain(`cid:${SIG_CID}`);
    expect(request).toHaveBeenCalledWith('DELETE', '/me/messages/msg-1/attachments/att-1');
    const posts = request.mock.calls.filter(([m]) => m === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0][2]).toMatchObject({ isInline: true, contentId: SIG_CID });
  });

  it('append_signature:true sans corps : ignoré avec avertissement', async () => {
    const result = await service.updateDraft('work', 'msg-1', {
      subject: '[TEST] x',
      appendSignature: true,
    });

    expect(patchBody()).toEqual({ subject: '[TEST] x' });
    expect(result.warnings.join(' ')).toMatch(/append_signature ignored/);
  });
});
