import type { EmailHeaderDump } from '../types/index.js';
import { analyzeHeaders, groupHeaders, parseHeaderBlock } from '../utils/headers.js';
import { formatHeaderDump } from './headers.tool.js';

/** Construit un relevé complet à partir d'un bloc d'en-têtes brut. */
function dumpOf(block: string, overrides: Partial<EmailHeaderDump> = {}): EmailHeaderDump {
  const entries = parseHeaderBlock(block);
  return {
    emailId: '1234',
    account: 'perso',
    mailbox: 'INBOX',
    raw: block,
    entries,
    grouped: groupHeaders(entries),
    analysis: analyzeHeaders(entries),
    ...overrides,
  };
}

const AUTHENTIC = [
  'Return-Path: <contact@exemple.fr>',
  'Authentication-Results: mx.destinataire.fr; spf=pass smtp.mailfrom=contact@exemple.fr;',
  ' dkim=pass header.d=exemple.fr; dmarc=pass header.from=exemple.fr',
  'DKIM-Signature: v=1; a=rsa-sha256; d=exemple.fr; s=sel1; b=xx',
  'Received: from relay.exemple.com by mx.destinataire.fr with ESMTPS;',
  ' Tue, 05 Aug 2026 10:00:20 +0000',
  'Received: from poste by relay.exemple.com with ESMTPSA;',
  ' Tue, 05 Aug 2026 10:00:00 +0000',
  'From: Contact <contact@exemple.fr>',
  'Subject: Facture de juillet',
].join('\r\n');

describe('formatHeaderDump', () => {
  const options = { includeAllHeaders: false, includeRaw: false };

  it('affiche l’identification du message', () => {
    const out = formatHeaderDump(dumpOf(AUTHENTIC), options);
    expect(out).toContain('account "perso", mailbox INBOX, id 1234');
    expect(out).toContain('Subject: Facture de juillet');
    expect(out).toContain('From: Contact <contact@exemple.fr>');
  });

  it('rend les verdicts et l’alignement', () => {
    const out = formatHeaderDump(dumpOf(AUTHENTIC), options);
    expect(out).toContain('spf=pass (smtp.mailfrom=contact@exemple.fr)');
    expect(out).toContain('dmarc=pass');
    expect(out).toContain('SPF=exemple.fr ✅');
    expect(out).toContain('DKIM=exemple.fr ✅');
    expect(out).toContain('DKIM signatures: exemple.fr (s=sel1, rsa-sha256)');
  });

  it('rend la chaîne Received en ordre chronologique avec les délais', () => {
    const out = formatHeaderDump(dumpOf(AUTHENTIC), options);
    expect(out).toContain('--- Received chain (2 hops, transit 20s) ---');
    expect(out).toContain('1. poste → relay.exemple.com  [ESMTPSA]');
    expect(out).toContain('2. relay.exemple.com → mx.destinataire.fr  [ESMTPS]');
    expect(out).toContain('(+20s)');
    // L'ordre du rendu doit être l'ordre chronologique, pas l'ordre du message.
    expect(out.indexOf('1. poste')).toBeLessThan(out.indexOf('2. relay.exemple.com'));
  });

  it('convertit les longs délais en minutes', () => {
    const out = formatHeaderDump(
      dumpOf(
        [
          'Received: by b.fr; Tue, 05 Aug 2026 10:05:30 +0000',
          'Received: by a.fr; Tue, 05 Aug 2026 10:00:00 +0000',
        ].join('\r\n'),
      ),
      options,
    );
    expect(out).toContain('(+5m 30s)');
  });

  it('signale l’absence de Received et d’Authentication-Results', () => {
    const out = formatHeaderDump(dumpOf('From: <a@b.fr>\r\nSubject: brouillon'), options);
    expect(out).toContain('(no Authentication-Results header)');
    expect(out).toContain('(no Received header)');
    expect(out).toContain('--- Notes ---');
  });

  it('liste tous les en-têtes à la demande, y compris les répétitions', () => {
    const out = formatHeaderDump(dumpOf(AUTHENTIC), { ...options, includeAllHeaders: true });
    expect(out).toContain('--- All headers (7) ---');
    // Les deux Received doivent apparaître : c'est ce que l'aplatissement perdait.
    expect(out.match(/^Received: /gm)).toHaveLength(2);
  });

  it('joint le bloc brut à la demande', () => {
    const out = formatHeaderDump(dumpOf(AUTHENTIC), { ...options, includeRaw: true });
    expect(out).toContain('--- Raw header block (verbatim) ---');
    expect(out).toContain('Return-Path: <contact@exemple.fr>');
  });

  it('avertit quand le bloc brut a été reconstruit (Graph)', () => {
    const out = formatHeaderDump(dumpOf(AUTHENTIC, { rawReconstructed: true }), {
      ...options,
      includeRaw: true,
    });
    expect(out).toContain('REBUILT from the API header list');
  });

  it('marque un désalignement plutôt que de le taire', () => {
    const out = formatHeaderDump(
      dumpOf(
        [
          'Return-Path: <bounce@ailleurs.tld>',
          'Authentication-Results: mx.a.fr; spf=fail smtp.mailfrom=bounce@ailleurs.tld',
          'From: Banque <contact@banque.fr>',
        ].join('\r\n'),
      ),
      options,
    );
    expect(out).toContain('SPF=ailleurs.tld ❌');
    expect(out).toContain('Return-Path ❌');
    expect(out).toContain('• spf=fail');
  });
});
