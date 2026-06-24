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

// Minimal 1x1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

// Minimal Word/Outlook signature: VML variant (o:href cid) + <img> tag, both
// pointing at the same local image in the _fichiers folder.
function writeSignature(dir: string, htmName = 'sig.htm'): string {
  const filesDir = join(dir, 'sig_fichiers');
  mkdirSync(filesDir, { recursive: true });
  writeFileSync(join(filesDir, 'image001.png'), PNG);

  const htm = `<html><head><meta http-equiv=Content-Type content="text/html; charset=windows-1252">
<style><!-- p.MsoNormal {font-family:Calibri;} --></style></head>
<body lang=EN>
<table><tr><td>
<!--[if gte vml 1]><v:shape><v:imagedata src="sig_fichiers/image001.png" o:href="cid:image001.png@01D9.ABC"></v:shape><![endif]-->
<![if !vml]><img width=110 height=110 src="sig_fichiers/image001.png" alt="Company logo"><![endif]>
</td><td>
<p class=MsoNormal>Jane Doe</p>
<p><a href="mailto:jane@example.com">jane@example.com</a></p>
<p><a href="http://www.example.com">www.example.com</a></p>
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

  it('rewrites local images to cid: and returns inline attachments', async () => {
    const htmPath = writeSignature(tmp);
    const sig = await loadOutlookSignature(htmPath);

    // A single attachment despite 2 occurrences (VML + <img>).
    expect(sig.attachments).toHaveLength(1);
    const att = sig.attachments[0];
    expect(att.filename).toBe('image001.png');
    expect(att.contentType).toBe('image/png');
    expect(att.contentDisposition).toBe('inline');
    // The VML cid (starting with the basename) is reused.
    expect(att.cid).toBe('image001.png@01D9.ABC');
    expect(att.content.equals(PNG)).toBe(true);

    // No reference to the local path remains; <img> points at cid:.
    expect(sig.html).not.toContain('sig_fichiers/image001.png');
    expect(sig.html).toContain('src="cid:image001.png@01D9.ABC"');
    // Links and name are preserved.
    expect(sig.html).toContain('mailto:jane@example.com');
    expect(sig.html).toContain('http://www.example.com');
    expect(sig.html).toContain('Jane Doe');
  });

  it('returns only the <body> content (+ styles), not the full doctype/head', async () => {
    const sig = await loadOutlookSignature(writeSignature(tmp));
    expect(sig.html).not.toMatch(/<body/i);
    expect(sig.html).not.toMatch(/<html/i);
    // Styles are preserved for Outlook fidelity.
    expect(sig.html).toContain('Calibri');
  });

  it('throws an explicit error when the file is missing', async () => {
    await expect(loadOutlookSignature(join(tmp, 'absent.htm'))).rejects.toThrow(/not found/i);
  });

  it('leaves a missing image untouched (no attachment)', async () => {
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
    name: 'work',
    email: 'jane@example.com',
    username: 'jane@example.com',
    imap: { host: 'imap.example.com', port: 993, tls: true, starttls: false, verifySsl: true },
    smtp: { host: 'smtp.example.com', port: 465, tls: true, starttls: false, verifySsl: true },
  };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'sig-acct-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('loadAccountSignature throws without signature_path', async () => {
    await expect(loadAccountSignature(baseAccount)).rejects.toThrow(/signature_path/);
  });

  it('applyAccountSignature is a no-op when append is falsy', async () => {
    const out = await applyAccountSignature(
      baseAccount,
      { body: 'Hello', html: false, attachments: [] },
      false,
    );
    expect(out).toEqual({ body: 'Hello', html: false, attachments: [] });
  });

  it('applyAccountSignature appends the signature and forces HTML', async () => {
    const htmPath = writeSignature(tmp);
    const account = { ...baseAccount, signaturePath: htmPath };
    const out = await applyAccountSignature(account, { body: '<p>Hello</p>' }, true);

    expect(out.html).toBe(true);
    expect(out.body).toContain('<p>Hello</p>');
    expect(out.body).toContain('Jane Doe');
    expect(out.attachments).toHaveLength(1);
    expect(out.attachments[0].cid).toBe('image001.png@01D9.ABC');
  });
});
