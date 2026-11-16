/* eslint-disable n/no-sync -- tests use sync fs helpers for setup/teardown */
/**
 * update_draft côté IMAP et signature du compte.
 *
 * Contrat vérifié ici : une mise à jour de brouillon n'ajoute JAMAIS
 * implicitement la signature du compte (même avec `signature_default`), ne la
 * duplique pas quand le corps hérité la contient déjà, et conserve les images
 * inline (cid) que ce corps référence.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleParser } from 'mailparser';
import MailComposer from 'nodemailer/lib/mail-composer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IConnectionManager } from '../connections/types.js';
import type { AccountConfig } from '../types/index.js';
import ImapService from './imap.service.js';
import { applyAccountSignature } from './signature-loader.js';

// PNG 1x1 minimal.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const SIG_CID = 'image001.png@01D9.ABC';
const SIG_NAME = 'Jane Doe';

// Signature Word/Outlook minimale : variante VML (o:href cid) + balise <img>.
function writeSignature(dir: string): string {
  const filesDir = join(dir, 'sig_fichiers');
  mkdirSync(filesDir, { recursive: true });
  writeFileSync(join(filesDir, 'image001.png'), PNG);
  const htm = `<html><head><meta http-equiv=Content-Type content="text/html; charset=windows-1252">
<style><!-- v\\:* {behavior:url(#default#VML);} --></style></head>
<body lang=FR>
<!--[if gte vml 1]><v:imagedata src="sig_fichiers/image001.png" o:href="cid:${SIG_CID}"><![endif]-->
<![if !vml]><img width=110 height=110 src="sig_fichiers/image001.png" alt="Logo"><![endif]>
<p class=MsoNormal>${SIG_NAME}</p>
</body></html>`;
  const htmPath = join(dir, 'sig.htm');
  writeFileSync(htmPath, htm);
  return htmPath;
}

/** Compile un message comme le fait saveDraft (même MailComposer). */
async function compose(options: Record<string, unknown>): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    new MailComposer(options).compile().build((err: Error | null, buf: Buffer) => {
      if (err) reject(err);
      else resolve(buf);
    });
  });
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('ImapService.updateDraft — signature du compte', () => {
  let tmp: string;
  let account: AccountConfig;
  let client: {
    list: ReturnType<typeof vi.fn>;
    getMailboxLock: ReturnType<typeof vi.fn>;
    fetchOne: ReturnType<typeof vi.fn>;
    append: ReturnType<typeof vi.fn>;
    messageDelete: ReturnType<typeof vi.fn>;
  };
  let service: ImapService;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'upd-draft-sig-'));
    account = {
      name: 'test',
      email: 'test@example.com',
      username: 'test@example.com',
      imap: { host: 'imap.example.com', port: 993, tls: true, starttls: false, verifySsl: true },
      smtp: { host: 'smtp.example.com', port: 465, tls: true, starttls: false, verifySsl: true },
      // Le cas du défaut constaté : signature configurée ET ajoutée par défaut.
      signaturePath: writeSignature(tmp),
      signatureDefault: true,
    };
    client = {
      list: vi.fn().mockResolvedValue([{ path: 'Drafts', specialUse: '\\Drafts' }]),
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      fetchOne: vi.fn().mockResolvedValue(null),
      append: vi.fn().mockResolvedValue({ uid: 99 }),
      messageDelete: vi.fn().mockResolvedValue(true),
    };
    const connections = {
      getAccount: vi.fn().mockReturnValue(account),
      getAccountNames: vi.fn().mockReturnValue(['test']),
      getImapClient: vi.fn().mockResolvedValue(client),
      createEphemeralImapClient: vi.fn().mockResolvedValue(client),
      getSmtpTransport: vi.fn(),
      closeAll: vi.fn(),
    } satisfies IConnectionManager;
    service = new ImapService(connections);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Amorce le brouillon existant (UID 7) renvoyé par fetchOne. */
  function primeDraft(source: Buffer): void {
    client.fetchOne.mockResolvedValue({
      uid: 7,
      envelope: { subject: '[TEST] brouillon', from: [], to: [] },
      flags: ['\\Draft'],
      source,
    });
  }

  /** Analyse le message réellement APPENDé (sans remplacer les liens cid:). */
  async function appended() {
    expect(client.append).toHaveBeenCalledTimes(1);
    const raw = client.append.mock.calls[0][1] as Buffer;
    const parsed = await simpleParser(raw, { keepCidLinks: true });
    const html = typeof parsed.html === 'string' ? parsed.html : '';
    const inline = parsed.attachments.filter((a) => a.cid === SIG_CID);
    return { html, inline, parsed };
  }

  /** Brouillon déjà signé, tel que save_draft append_signature:true le produit. */
  async function signedDraftSource(body: string): Promise<Buffer> {
    const signed = await applyAccountSignature(account, { body, html: true }, true);
    return compose({
      from: account.email,
      subject: '[TEST] brouillon',
      html: signed.body,
      attachments: signed.attachments,
    });
  }

  it("n'ajoute pas la signature par défaut du compte à un brouillon qui n'en a pas", async () => {
    primeDraft(await compose({ from: account.email, subject: '[TEST] brouillon', html: 'V1' }));

    await service.updateDraft('test', 7, { body: 'Version 2 modifiée' });

    const { html, inline } = await appended();
    expect(html).toContain('Version 2 modifiée');
    expect(html).not.toContain(SIG_NAME);
    expect(inline).toHaveLength(0);
  });

  it('mise à jour du sujet seul : signature héritée présente une fois, image cid conservée', async () => {
    primeDraft(await signedDraftSource('Version 1'));

    const result = await service.updateDraft('test', 7, { subject: '[TEST] nouveau sujet' });

    const { html, inline, parsed } = await appended();
    expect(parsed.subject).toBe('[TEST] nouveau sujet');
    expect(countOccurrences(html, SIG_NAME)).toBe(1);
    // Le corps hérité garde sa référence cid: et l'image voyage avec lui.
    expect(html).toContain(`cid:${SIG_CID}`);
    expect(html).not.toContain('data:image');
    expect(inline).toHaveLength(1);
    expect(result.warnings.join(' ')).not.toMatch(/inline image/);
  });

  it('nouveau corps sans append_signature : contenu demandé, sans signature ni image orpheline', async () => {
    primeDraft(await signedDraftSource('Version 1'));

    await service.updateDraft('test', 7, { body: 'Version 2' });

    const { html, inline } = await appended();
    expect(html).toContain('Version 2');
    expect(html).not.toContain(SIG_NAME);
    expect(inline).toHaveLength(0);
  });

  it('nouveau corps avec append_signature:true : signature une seule fois, image cid une seule fois', async () => {
    primeDraft(await signedDraftSource('Version 1'));

    await service.updateDraft('test', 7, { body: 'Version 2', appendSignature: true });

    const { html, inline } = await appended();
    expect(html).toContain('Version 2');
    expect(countOccurrences(html, SIG_NAME)).toBe(1);
    expect(inline).toHaveLength(1);
  });

  it('append_signature:true sans corps : ignoré avec avertissement, pas de doublon', async () => {
    primeDraft(await signedDraftSource('Version 1'));

    const result = await service.updateDraft('test', 7, {
      subject: '[TEST] autre',
      appendSignature: true,
    });

    const { html, inline } = await appended();
    expect(countOccurrences(html, SIG_NAME)).toBe(1);
    expect(inline).toHaveLength(1);
    expect(result.warnings.join(' ')).toMatch(/append_signature/);
  });
});
