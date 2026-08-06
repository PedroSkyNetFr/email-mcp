import {
  allHeaders,
  analyzeHeaders,
  domainOf,
  flattenHeaders,
  groupHeaders,
  parseAuthenticationResults,
  parseDkimSignature,
  parseHeaderBlock,
  parseReceivedChain,
  splitHeaderBlock,
} from './headers.js';

describe('splitHeaderBlock', () => {
  it('coupe à la première ligne vide en CRLF', () => {
    expect(splitHeaderBlock('Subject: a\r\nFrom: b\r\n\r\ncorps\r\n\r\nsuite')).toBe(
      'Subject: a\r\nFrom: b',
    );
  });

  it('REGRESSION: reconnaît aussi un séparateur LF seul', () => {
    // Les MTA Unix et la plupart des serveurs de test écrivent en LF. Un
    // découpage limité à \r\n\r\n prenait alors le corps entier pour des
    // en-têtes.
    expect(splitHeaderBlock('Subject: a\nFrom: b\n\ncorps')).toBe('Subject: a\nFrom: b');
  });

  it('retourne la source telle quelle quand il n’y a pas de corps', () => {
    expect(splitHeaderBlock('Subject: a\r\nFrom: b')).toBe('Subject: a\r\nFrom: b');
  });

  it('accepte un Buffer', () => {
    expect(splitHeaderBlock(Buffer.from('Subject: a\r\n\r\ncorps'))).toBe('Subject: a');
  });
});

describe('parseHeaderBlock', () => {
  it('REGRESSION: déplie les continuations (espace ET tabulation)', () => {
    // Received / Authentication-Results / DKIM-Signature sont pliés en
    // pratique : sans dépliage, ils étaient tronqués à leur première ligne.
    const entries = parseHeaderBlock(
      'Received: from a.example.com\r\n by b.example.com\r\n\twith ESMTPS\r\nSubject: ok',
    );
    expect(entries).toHaveLength(2);
    expect(entries[0].value).toBe('from a.example.com by b.example.com with ESMTPS');
    expect(entries[1].value).toBe('ok');
  });

  it('REGRESSION: conserve toutes les occurrences d’un en-tête répété', () => {
    const entries = parseHeaderBlock('Received: hop3\r\nReceived: hop2\r\nReceived: hop1');
    expect(allHeaders(entries, 'received')).toEqual(['hop3', 'hop2', 'hop1']);
  });

  it('préserve le nom d’origine et expose une clé en minuscules', () => {
    const [entry] = parseHeaderBlock('DKIM-Signature: v=1');
    expect(entry.name).toBe('DKIM-Signature');
    expect(entry.key).toBe('dkim-signature');
  });

  it('ignore la ligne séparatrice mbox et les lignes non conformes', () => {
    const entries = parseHeaderBlock(
      'From alice@example.com Tue Aug 5\r\nSubject: ok\r\nn’importe',
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].key).toBe('subject');
  });

  it('s’arrête à la ligne vide', () => {
    const entries = parseHeaderBlock('Subject: ok\r\n\r\nSubject: injecté depuis le corps');
    expect(entries).toHaveLength(1);
  });

  it('gère une valeur vide et un nom sans valeur', () => {
    const entries = parseHeaderBlock('X-Vide:\r\nSubject: ok');
    expect(entries[0].value).toBe('');
    expect(entries).toHaveLength(2);
  });
});

describe('groupHeaders / flattenHeaders', () => {
  const entries = parseHeaderBlock('Received: b\r\nReceived: a\r\nSubject: s');

  it('groupHeaders conserve l’ordre et la multiplicité', () => {
    expect(groupHeaders(entries).received).toEqual(['b', 'a']);
  });

  it('flattenHeaders garde la dernière occurrence (comportement historique)', () => {
    expect(flattenHeaders(entries).received).toBe('a');
    expect(flattenHeaders(entries).subject).toBe('s');
  });
});

describe('parseReceivedChain', () => {
  // Ordre du message : le relais le plus récent est en tête.
  const values = [
    'from mx.destinataire.fr (mx.destinataire.fr [10.0.0.9]) by store.destinataire.fr with LMTP ' +
      'id ABC123 for <moi@destinataire.fr>; Tue, 05 Aug 2026 10:00:30 +0000 (UTC)',
    'from relay.exemple.com (relay.exemple.com [192.0.2.5]) by mx.destinataire.fr with ESMTPS ' +
      'id DEF456; Tue, 05 Aug 2026 10:00:20 +0000',
    'from poste-client (unknown [198.51.100.7]) by relay.exemple.com with ESMTPSA id GHI789; ' +
      'Tue, 05 Aug 2026 10:00:00 +0000',
  ];

  it('remet la chaîne en ordre chronologique', () => {
    const hops = parseReceivedChain(values);
    expect(hops.map((hop) => hop.by)).toEqual([
      'relay.exemple.com',
      'mx.destinataire.fr',
      'store.destinataire.fr',
    ]);
    expect(hops[0].index).toBe(0);
  });

  it('décode les clauses from / by / with / id / for', () => {
    const hops = parseReceivedChain(values);
    const last = hops[2];
    expect(last.from).toBe('mx.destinataire.fr (mx.destinataire.fr [10.0.0.9])');
    expect(last.with).toBe('LMTP');
    expect(last.id).toBe('ABC123');
    expect(last.for).toBe('<moi@destinataire.fr>');
  });

  it('normalise la date et calcule le délai entre sauts', () => {
    const hops = parseReceivedChain(values);
    expect(hops[0].date).toBe('2026-08-05T10:00:00.000Z');
    expect(hops[0].delaySeconds).toBeUndefined();
    expect(hops[1].delaySeconds).toBe(20);
    expect(hops[2].delaySeconds).toBe(10);
  });

  it('ne se laisse pas piéger par un mot-clé à l’intérieur d’un commentaire', () => {
    // « by » et « for » apparaissent dans le commentaire de parenthèse : ce ne
    // sont pas des clauses, et un découpage par regex les prendrait pour telles.
    const [hop] = parseReceivedChain([
      'from a.example (helo=b.example by proxy for tests) by reel.example with ESMTP; ' +
        'Tue, 05 Aug 2026 10:00:00 +0000',
    ]);
    expect(hop.from).toBe('a.example (helo=b.example by proxy for tests)');
    expect(hop.by).toBe('reel.example');
    expect(hop.for).toBeUndefined();
  });

  it('ne coupe pas sur un point-virgule situé dans un commentaire', () => {
    const [hop] = parseReceivedChain([
      'from a.example (TLS; cipher=X) by b.example; Tue, 05 Aug 2026 10:00:00 +0000',
    ]);
    expect(hop.by).toBe('b.example');
    expect(hop.date).toBe('2026-08-05T10:00:00.000Z');
  });

  it('tolère un saut sans date ou non analysable', () => {
    const hops = parseReceivedChain(['by a.example', 'by b.example; date-illisible']);
    expect(hops).toHaveLength(2);
    expect(hops[0].date).toBeUndefined();
    expect(hops[1].date).toBeUndefined();
  });

  it('retourne une liste vide sans Received', () => {
    expect(parseReceivedChain([])).toEqual([]);
  });
});

describe('parseAuthenticationResults', () => {
  const value =
    'mx.google.com; dkim=pass header.i=@exemple.fr header.s=sel1 header.b=Ab12; ' +
    'spf=pass (google.com: domain of contact@exemple.fr designates 192.0.2.5 as permitted ' +
    'sender) smtp.mailfrom=contact@exemple.fr; dmarc=pass (p=REJECT sp=REJECT dis=NONE) ' +
    'header.from=exemple.fr';

  it('extrait l’authserv-id, les méthodes et les résultats', () => {
    const parsed = parseAuthenticationResults(value);
    expect(parsed.authServId).toBe('mx.google.com');
    expect(parsed.methods.map((m) => `${m.method}=${m.result}`)).toEqual([
      'dkim=pass',
      'spf=pass',
      'dmarc=pass',
    ]);
  });

  it('extrait les propriétés ptype.prop et isole le commentaire', () => {
    const parsed = parseAuthenticationResults(value);
    const spf = parsed.methods.find((m) => m.method === 'spf');
    expect(spf?.properties['smtp.mailfrom']).toBe('contact@exemple.fr');
    expect(spf?.comment).toContain('designates 192.0.2.5');
    expect(parsed.methods.find((m) => m.method === 'dmarc')?.properties['header.from']).toBe(
      'exemple.fr',
    );
  });

  it('ne coupe pas sur un point-virgule interne au commentaire', () => {
    const parsed = parseAuthenticationResults('mx.a.com; spf=fail (raison; détaillée) x.y=z');
    expect(parsed.methods).toHaveLength(1);
    expect(parsed.methods[0].result).toBe('fail');
  });

  it('gère une valeur sans méthode exploitable', () => {
    expect(parseAuthenticationResults('mx.a.com; none').methods).toEqual([]);
  });
});

describe('parseDkimSignature', () => {
  it('extrait le domaine, le sélecteur et l’algorithme', () => {
    const sig = parseDkimSignature('v=1; a=rsa-sha256; d=Exemple.FR; s=sel1; bh=xx; b=yy');
    expect(sig).toEqual({ domain: 'exemple.fr', selector: 'sel1', algorithm: 'rsa-sha256' });
  });
});

describe('domainOf', () => {
  it('accepte les trois formes usuelles', () => {
    expect(domainOf('Alice <alice@Exemple.FR>')).toBe('exemple.fr');
    expect(domainOf('<alice@exemple.fr>')).toBe('exemple.fr');
    expect(domainOf('alice@exemple.fr')).toBe('exemple.fr');
  });

  it('retourne undefined sans adresse reconnaissable', () => {
    expect(domainOf('Alice')).toBeUndefined();
    expect(domainOf(undefined)).toBeUndefined();
  });
});

describe('analyzeHeaders', () => {
  const authentic = parseHeaderBlock(
    [
      'Return-Path: <contact@exemple.fr>',
      'Authentication-Results: mx.destinataire.fr; spf=pass smtp.mailfrom=contact@exemple.fr;',
      ' dkim=pass header.d=exemple.fr; dmarc=pass header.from=exemple.fr',
      'DKIM-Signature: v=1; a=rsa-sha256; d=exemple.fr; s=sel1; b=xx',
      'Received: from relay.exemple.com by mx.destinataire.fr with ESMTPS;',
      ' Tue, 05 Aug 2026 10:00:20 +0000',
      'Received: from poste by relay.exemple.com with ESMTPSA;',
      ' Tue, 05 Aug 2026 10:00:00 +0000',
      'From: Contact <contact@exemple.fr>',
      'Subject: Facture',
    ].join('\r\n'),
  );

  it('assemble la chaîne, les verdicts et le transit total', () => {
    const analysis = analyzeHeaders(authentic);
    expect(analysis.received).toHaveLength(2);
    expect(analysis.transitSeconds).toBe(20);
    expect(analysis.authentication.verdicts.spf.result).toBe('pass');
    expect(analysis.authentication.dkimSignatures[0].domain).toBe('exemple.fr');
  });

  it('conclut à l’alignement quand SPF, DKIM et From concordent', () => {
    const { alignment } = analyzeHeaders(authentic);
    expect(alignment.fromDomain).toBe('exemple.fr');
    expect(alignment.spfDomain).toBe('exemple.fr');
    expect(alignment.spfAligned).toBe(true);
    expect(alignment.dkimAligned).toBe(true);
    expect(alignment.returnPathMatchesFrom).toBe(true);
  });

  it('ne signale rien d’anormal sur un message authentifié', () => {
    expect(analyzeHeaders(authentic).notes).toEqual([]);
  });

  it('retient le verdict du relais le plus haut (le dernier intervenu)', () => {
    // Un relais en amont peut écrire ce qu'il veut ; seul l'en-tête ajouté par
    // le serveur de réception ne peut pas avoir été forgé.
    const entries = parseHeaderBlock(
      [
        'Authentication-Results: mx.destinataire.fr; spf=fail smtp.mailfrom=pirate@ailleurs.tld',
        'Authentication-Results: relay.douteux.tld; spf=pass smtp.mailfrom=pirate@ailleurs.tld',
        'From: Banque <contact@banque.fr>',
      ].join('\r\n'),
    );
    const analysis = analyzeHeaders(entries);
    expect(analysis.authentication.verdicts.spf.result).toBe('fail');
    expect(analysis.authentication.verdicts.spf.properties['smtp.mailfrom']).toBe(
      'pirate@ailleurs.tld',
    );
  });

  it('relève un échec SPF, un désalignement et une absence de DKIM', () => {
    const entries = parseHeaderBlock(
      [
        'Return-Path: <bounce@ailleurs.tld>',
        'Authentication-Results: mx.destinataire.fr; spf=fail (mauvaise IP) ' +
          'smtp.mailfrom=bounce@ailleurs.tld',
        'From: Banque <contact@banque.fr>',
      ].join('\r\n'),
    );
    const analysis = analyzeHeaders(entries);
    expect(analysis.alignment.spfAligned).toBe(false);
    expect(analysis.alignment.returnPathMatchesFrom).toBe(false);
    expect(analysis.notes.some((note) => note.startsWith('spf=fail'))).toBe(true);
    expect(analysis.notes).toContain('Message non signé en DKIM.');
  });

  it('aligne un sous-domaine sur son domaine parent', () => {
    const entries = parseHeaderBlock(
      [
        'Authentication-Results: mx.a.fr; spf=pass smtp.mailfrom=envoi@mail.exemple.fr',
        'DKIM-Signature: v=1; d=mail.exemple.fr; s=s1; b=xx',
        'From: <contact@exemple.fr>',
      ].join('\r\n'),
    );
    const { alignment } = analyzeHeaders(entries);
    expect(alignment.spfAligned).toBe(true);
    expect(alignment.dkimAligned).toBe(true);
  });

  it('signale l’absence de Received et d’Authentication-Results', () => {
    const analysis = analyzeHeaders(parseHeaderBlock('From: <a@b.fr>\r\nSubject: brouillon'));
    expect(analysis.received).toEqual([]);
    expect(analysis.notes.some((note) => note.includes('Aucun en-tête Received'))).toBe(true);
    expect(
      analysis.notes.some((note) => note.includes('Aucun en-tête Authentication-Results')),
    ).toBe(true);
  });

  it('compte les sceaux ARC d’un message réexpédié', () => {
    const analysis = analyzeHeaders(
      parseHeaderBlock('ARC-Seal: i=1; a=rsa\r\nARC-Seal: i=2; a=rsa\r\nFrom: <a@b.fr>'),
    );
    expect(analysis.authentication.arcSeals).toBe(2);
    expect(analysis.notes.some((note) => note.includes('2 sceau(x) ARC'))).toBe(true);
  });
});
