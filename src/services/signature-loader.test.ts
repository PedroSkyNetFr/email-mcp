/* eslint-disable n/no-sync -- tests use sync fs helpers for setup/teardown */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AccountConfig } from '../types/index.js';
import {
  applyAccountSignature,
  loadAccountSignature,
  loadOutlookSignature,
} from './signature-loader.js';

// PNG 1x1 minimal.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

// Signature Word/Outlook minimale : variante VML (o:href cid) + balise <img>
// pointant la même image locale dans le sous-dossier _fichiers.
function writeSignature(dir: string, htmName = 'sig.htm'): string {
  const filesDir = join(dir, 'sig_fichiers');
  mkdirSync(filesDir, { recursive: true });
  writeFileSync(join(filesDir, 'image001.png'), PNG);

  const htm = `<html><head><meta http-equiv=Content-Type content="text/html; charset=windows-1252">
<style><!-- p.MsoNormal {font-family:Calibri;} --></style></head>
<body lang=FR>
<table><tr><td>
<!--[if gte vml 1]><v:shape><v:imagedata src="sig_fichiers/image001.png" o:href="cid:image001.png@01D9.ABC"></v:shape><![endif]-->
<![if !vml]><img width=110 height=110 src="sig_fichiers/image001.png" alt="CANET CONSTRUCTION"><![endif]>
</td><td>
<p class=MsoNormal>Pierre CANET</p>
<p><a href="mailto:contact@pierrecanet.fr">contact@pierrecanet.fr</a></p>
<p><a href="http://www.pierrecanet.fr">www.pierrecanet.fr</a></p>
</td></tr></table>
</body></html>`;
  const htmPath = join(dir, htmName);
  writeFileSync(htmPath, htm, 'latin1');
  return htmPath;
}

describe('loadOutlookSignature', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'sig-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('réécrit les images locales en cid: et renvoie les pièces inline', async () => {
    const htmPath = writeSignature(tmp);
    const sig = await loadOutlookSignature(htmPath);

    // Une seule pièce malgré 2 occurrences (VML + <img>).
    expect(sig.attachments).toHaveLength(1);
    const att = sig.attachments[0];
    expect(att.filename).toBe('image001.png');
    expect(att.contentType).toBe('image/png');
    expect(att.contentDisposition).toBe('inline');
    // Le cid VML (commençant par le basename) est réutilisé.
    expect(att.cid).toBe('image001.png@01D9.ABC');
    expect(att.content.equals(PNG)).toBe(true);

    // Plus aucune référence au chemin local ; <img> pointe vers cid:.
    expect(sig.html).not.toContain('sig_fichiers/image001.png');
    expect(sig.html).toContain('src="cid:image001.png@01D9.ABC"');
    // Liens et nom conservés.
    expect(sig.html).toContain('mailto:contact@pierrecanet.fr');
    expect(sig.html).toContain('http://www.pierrecanet.fr');
    expect(sig.html).toContain('Pierre CANET');
  });

  it('ne renvoie que le contenu du <body> (+ styles), pas le doctype/head complet', async () => {
    const sig = await loadOutlookSignature(writeSignature(tmp));
    expect(sig.html).not.toMatch(/<body/i);
    expect(sig.html).not.toMatch(/<html/i);
    // Les styles sont préservés pour la fidélité Outlook.
    expect(sig.html).toContain('Calibri');
  });

  it('lève une erreur explicite si le fichier est introuvable', async () => {
    await expect(loadOutlookSignature(join(tmp, 'absent.htm'))).rejects.toThrow(/introuvable/i);
  });

  it('laisse une image manquante telle quelle (pas de pièce)', async () => {
    const htmPath = join(tmp, 'sig.htm');
    writeFileSync(htmPath, '<html><body><img src="sig_fichiers/nope.png"></body></html>', 'latin1');
    const sig = await loadOutlookSignature(htmPath);
    expect(sig.attachments).toHaveLength(0);
    expect(sig.html).toContain('sig_fichiers/nope.png');
  });
});

describe('loadAccountSignature / applyAccountSignature', () => {
  let tmp: string;
  const baseAccount: AccountConfig = {
    name: 'contact',
    email: 'contact@pierrecanet.fr',
    username: 'contact@pierrecanet.fr',
    imap: { host: 'ssl0.ovh.net', port: 993, tls: true, starttls: false, verifySsl: true },
    smtp: { host: 'ssl0.ovh.net', port: 465, tls: true, starttls: false, verifySsl: true },
  };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'sig-acct-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('loadAccountSignature lève une erreur sans signature_path', async () => {
    await expect(loadAccountSignature(baseAccount)).rejects.toThrow(/signature_path/);
  });

  it('applyAccountSignature est un no-op quand append est falsy', async () => {
    const out = await applyAccountSignature(
      baseAccount,
      { body: 'Bonjour', html: false, attachments: [] },
      false,
    );
    expect(out).toEqual({ body: 'Bonjour', html: false, attachments: [] });
  });

  it('applyAccountSignature ajoute la signature et force le HTML', async () => {
    const htmPath = writeSignature(tmp);
    const account = { ...baseAccount, signaturePath: htmPath };
    const out = await applyAccountSignature(account, { body: '<p>Bonjour</p>' }, true);

    expect(out.html).toBe(true);
    expect(out.body).toContain('<p>Bonjour</p>');
    expect(out.body).toContain('Pierre CANET');
    expect(out.attachments).toHaveLength(1);
    expect(out.attachments[0].cid).toBe('image001.png@01D9.ABC');
  });
});
