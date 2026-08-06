/**
 * Analyse des en-têtes Internet d'un message (RFC 5322, RFC 5321, RFC 8601).
 *
 * Le champ `Email.headers` construit par `messageToEmail` est un
 * `Record<string, string>` indexé par nom d'en-tête. Cette forme perd
 * précisément l'information qui compte pour tracer un message :
 *
 *   - les en-têtes REPETES sont écrasés — un message réel traverse 5 à 10
 *     relais, donc porte autant de lignes `Received:`, et un Record n'en garde
 *     qu'une seule ;
 *   - les lignes PLIEES (RFC 5322 §2.2.3 — continuation préfixée par une
 *     espace ou une tabulation) sont tronquées à leur première ligne, ce qui
 *     ampute systématiquement `Received:`, `Authentication-Results:` et
 *     `DKIM-Signature:`, tous multi-lignes en pratique ;
 *   - le découpage sur `\r\n` ignore les messages en LF seul, produits par de
 *     nombreux MTA Unix et par la plupart des serveurs de test.
 *
 * Ce module fournit donc un parseur qui préserve l'ordre et la multiplicité,
 * plus une couche d'interprétation : chaîne `Received` remise en ordre
 * chronologique avec le temps passé à chaque saut, et verdicts SPF / DKIM /
 * DMARC extraits de `Authentication-Results`.
 *
 * Aucune I/O ici : l'entrée est le bloc d'en-têtes brut, d'où qu'il vienne
 * (FETCH BODY.PEEK[HEADER] côté IMAP, `internetMessageHeaders` ou le MIME
 * `$value` côté Graph). Les deux backends convergent vers la même
 * représentation.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Un en-tête, nom d'origine préservé, valeur dépliée. */
export interface HeaderEntry {
  /** Nom tel qu'écrit dans le message (`Received`, `DKIM-Signature`, …). */
  name: string;
  /** Nom en minuscules — clé de regroupement. */
  key: string;
  /** Valeur dépliée : les sauts de ligne de pliage deviennent une espace. */
  value: string;
}

/** Un saut de la chaîne `Received`, décodé. */
export interface ReceivedHop {
  /** Rang chronologique : 0 = relais le plus ancien (côté expéditeur). */
  index: number;
  /** Hôte annoncé par l'émetteur du saut (clause `from`). */
  from?: string;
  /** Hôte qui a reçu (clause `by`). */
  by?: string;
  /** Protocole utilisé (clause `with` : ESMTPS, ESMTPSA, LMTP…). */
  with?: string;
  /** Identifiant de file attribué par le relais (clause `id`). */
  id?: string;
  /** Destinataire d'enveloppe si le relais l'a journalisé (clause `for`). */
  for?: string;
  /** Horodatage du saut, normalisé ISO 8601 quand il est analysable. */
  date?: string;
  /** Secondes écoulées depuis le saut daté précédent (absent sur le premier). */
  delaySeconds?: number;
  /** Valeur d'en-tête complète, dépliée — source de vérité en cas de doute. */
  raw: string;
}

/** Verdict d'une méthode d'authentification (`spf=pass`, `dkim=fail`, …). */
export interface AuthMethodResult {
  /** Méthode : spf, dkim, dmarc, compauth, arc… */
  method: string;
  /** Résultat : pass, fail, softfail, neutral, none, temperror, permerror… */
  result: string;
  /** Propriétés `ptype.property=value` (smtp.mailfrom, header.d, header.from…). */
  properties: Record<string, string>;
  /** Commentaire entre parenthèses, quand le relais en fournit un. */
  comment?: string;
  /** Segment brut correspondant. */
  raw: string;
}

/** Un en-tête `Authentication-Results` décodé. */
export interface AuthResultsHeader {
  /** Identité du serveur qui a produit ces résultats (authserv-id). */
  authServId?: string;
  methods: AuthMethodResult[];
  raw: string;
}

/** Une signature `DKIM-Signature`, réduite à ce qui sert au diagnostic. */
export interface DkimSignature {
  /** Domaine signataire (tag `d=`). */
  domain?: string;
  /** Sélecteur (tag `s=`) — désigne la clé publique dans le DNS. */
  selector?: string;
  /** Algorithme (tag `a=`). */
  algorithm?: string;
}

/**
 * Alignement au sens DMARC : le domaine authentifié par SPF ou DKIM
 * correspond-il au domaine affiché dans `From:` ?
 */
export interface DomainAlignment {
  /** Domaine de l'en-tête `From:` — ce que voit l'utilisateur. */
  fromDomain?: string;
  /** Domaine du `Return-Path:` (expéditeur d'enveloppe). */
  returnPathDomain?: string;
  /** Domaine validé par SPF (`smtp.mailfrom`, `smtp.helo`, à défaut Return-Path). */
  spfDomain?: string;
  /** Domaines signataires DKIM constatés. */
  dkimDomains: string[];
  /** `spfDomain` aligné avec `fromDomain`. */
  spfAligned?: boolean;
  /** Au moins un domaine DKIM aligné avec `fromDomain`. */
  dkimAligned?: boolean;
  /** `Return-Path` et `From:` sur le même domaine. */
  returnPathMatchesFrom?: boolean;
}

/** Résultat complet de l'analyse. */
export interface HeaderAnalysis {
  /** Chaîne `Received` en ordre chronologique (expéditeur → destinataire). */
  received: ReceivedHop[];
  /** Durée totale de transit en secondes, si au moins deux sauts sont datés. */
  transitSeconds?: number;
  authentication: {
    /** Un élément par en-tête `Authentication-Results`, dans l'ordre du message. */
    headers: AuthResultsHeader[];
    /**
     * Verdict retenu par méthode. Les en-têtes sont parcourus du haut vers le
     * bas et le PREMIER verdict trouvé gagne : le relais le plus haut est le
     * dernier à avoir touché le message, donc le seul dont l'affirmation ne
     * puisse pas avoir été forgée par un relais en amont.
     */
    verdicts: Record<string, AuthMethodResult>;
    /** En-têtes `Received-SPF` bruts, s'il y en a. */
    receivedSpf: string[];
    dkimSignatures: DkimSignature[];
    /** Nombre de sceaux ARC — trace d'un réacheminement (liste, redirection). */
    arcSeals: number;
  };
  alignment: DomainAlignment;
  /** Observations lisibles : ce qui manque, ce qui échoue, ce qui ne s'aligne pas. */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Découpage et dépliage
// ---------------------------------------------------------------------------

/**
 * Isole le bloc d'en-têtes d'une source RFC822 complète : tout ce qui précède
 * la première ligne vide. Un message sans corps (ou une source déjà réduite à
 * ses en-têtes) est retourné tel quel.
 *
 * Gère indifféremment CRLF et LF — un séparateur `\n\n` est aussi courant en
 * pratique qu'un `\r\n\r\n`, et ne pas le reconnaître ferait passer le corps
 * entier pour des en-têtes.
 */
export function splitHeaderBlock(source: string | Buffer): string {
  const text = Buffer.isBuffer(source) ? source.toString('utf-8') : source;
  const crlf = text.indexOf('\r\n\r\n');
  const lf = text.indexOf('\n\n');
  const separators = [crlf, lf].filter((index) => index >= 0);
  return separators.length > 0 ? text.slice(0, Math.min(...separators)) : text;
}

/**
 * Déplie et découpe un bloc d'en-têtes.
 *
 * Le dépliage (RFC 5322 §2.2.3) remplace le saut de ligne ET l'indentation de
 * continuation par une espace unique. La norme autorise à conserver l'espace
 * blanc d'origine, mais le normaliser rend les valeurs comparables et fiabilise
 * le découpage en jetons en aval ; la fidélité octet par octet reste disponible
 * via le bloc brut, que les outils exposent séparément.
 *
 * Une ligne `From ` initiale (séparateur mbox, sans deux-points) est ignorée,
 * comme toute ligne non conforme — mieux vaut la perdre que corrompre l'en-tête
 * précédent en l'y agrégeant.
 */
export function parseHeaderBlock(block: string | Buffer): HeaderEntry[] {
  const text = Buffer.isBuffer(block) ? block.toString('utf-8') : block;
  const entries: HeaderEntry[] = [];

  let currentName: string | null = null;
  let currentValue = '';

  const flush = (): void => {
    if (currentName === null) return;
    entries.push({ name: currentName, key: currentName.toLowerCase(), value: currentValue.trim() });
    currentName = null;
    currentValue = '';
  };

  const lines = text.split(/\r?\n/);
  let reachedBody = false;
  for (let i = 0; i < lines.length && !reachedBody; i += 1) {
    const line = lines[i];
    if (line.length === 0) {
      // Ligne vide : fin du bloc (défensif — l'appelant a normalement déjà
      // tronqué au séparateur).
      reachedBody = true;
    } else if (line.startsWith(' ') || line.startsWith('\t')) {
      // Continuation d'un pliage ; orpheline s'il n'y a pas d'en-tête courant.
      if (currentName !== null) currentValue += ` ${line.trim()}`;
    } else {
      const colon = line.indexOf(':');
      if (colon > 0) {
        flush();
        currentName = line.slice(0, colon).trim();
        currentValue = line.slice(colon + 1).trim();
      }
    }
  }
  flush();

  return entries;
}

/**
 * Regroupe par nom en minuscules, en conservant l'ordre d'apparition et TOUTES
 * les occurrences. C'est la forme qui rend la chaîne `Received` exploitable.
 */
export function groupHeaders(entries: HeaderEntry[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  entries.forEach((entry) => {
    const values = out[entry.key] ?? [];
    values.push(entry.value);
    out[entry.key] = values;
  });
  return out;
}

/**
 * Aplatit en `Record<string, string>` pour les consommateurs qui n'attendent
 * qu'une valeur. La DERNIERE occurrence gagne, ce qui reproduit exactement le
 * comportement historique de `messageToEmail` : les appelants existants
 * (résolution de `references`, filtres d'en-tête) ne changent pas de résultat.
 */
export function flattenHeaders(entries: HeaderEntry[]): Record<string, string> {
  const out: Record<string, string> = {};
  entries.forEach((entry) => {
    out[entry.key] = entry.value;
  });
  return out;
}

/** Première valeur d'un en-tête, ou `undefined`. */
export function firstHeader(entries: HeaderEntry[], name: string): string | undefined {
  const key = name.toLowerCase();
  return entries.find((entry) => entry.key === key)?.value;
}

/** Toutes les valeurs d'un en-tête, dans l'ordre du message. */
export function allHeaders(entries: HeaderEntry[], name: string): string[] {
  const key = name.toLowerCase();
  return entries.filter((entry) => entry.key === key).map((entry) => entry.value);
}

// ---------------------------------------------------------------------------
// Analyse de la chaîne Received
// ---------------------------------------------------------------------------

/** Clauses reconnues dans un `Received:` (RFC 5321 §4.4). */
const RECEIVED_CLAUSES = new Set(['from', 'by', 'via', 'with', 'id', 'for']);

/**
 * Coupe la valeur à son dernier point-virgule de niveau supérieur, qui sépare
 * les clauses de l'horodatage. Les parenthèses sont respectées : un
 * commentaire de relais peut contenir un `;` sans être un séparateur.
 */
function splitAtTimestamp(value: string): { clauses: string; timestamp?: string } {
  let depth = 0;
  let cut = -1;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char === '(') depth += 1;
    else if (char === ')') depth = Math.max(0, depth - 1);
    else if (char === ';' && depth === 0) cut = i;
  }
  if (cut < 0) return { clauses: value };
  return { clauses: value.slice(0, cut), timestamp: value.slice(cut + 1).trim() };
}

/**
 * Découpe les clauses d'un `Received:`.
 *
 * Un jeu d'expressions régulières se fait piéger par les commentaires :
 * `from a (helo=b by c)` contient les mots `by` et `for` sans qu'ils soient des
 * clauses. On balaie donc les caractères en suivant la profondeur de
 * parenthèses, et seuls les mots isolés au niveau 0 ouvrent une clause.
 *
 * En cas de clause répétée (relais bavards), la PREMIERE gagne.
 */
function parseReceivedClauses(clauses: string): Record<string, string> {
  const marks: { key: string; keyStart: number; valueStart: number }[] = [];
  let depth = 0;
  let tokenStart = -1;

  const closeToken = (end: number): void => {
    if (tokenStart < 0) return;
    const word = clauses.slice(tokenStart, end).toLowerCase();
    if (RECEIVED_CLAUSES.has(word)) {
      marks.push({ key: word, keyStart: tokenStart, valueStart: end });
    }
    tokenStart = -1;
  };

  for (let i = 0; i < clauses.length; i += 1) {
    const char = clauses[i];
    if (char === '(') {
      closeToken(i);
      depth += 1;
    } else if (char === ')') {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0) {
      if (/\s/.test(char)) closeToken(i);
      else if (tokenStart < 0) tokenStart = i;
    }
  }
  closeToken(clauses.length);

  const out: Record<string, string> = {};
  marks.forEach((mark, position) => {
    const next = marks[position + 1];
    const value = clauses.slice(mark.valueStart, next ? next.keyStart : clauses.length).trim();
    if (value.length > 0 && !(mark.key in out)) out[mark.key] = value;
  });
  return out;
}

/**
 * Normalise l'horodatage d'un `Received:` en ISO 8601. Le commentaire de fuseau
 * (« (CEST) ») est retiré : il est décoratif, et certaines combinaisons
 * date/commentaire mettent `Date` en échec.
 */
function parseHopDate(timestamp: string | undefined): string | undefined {
  if (!timestamp) return undefined;
  const parsed = new Date(timestamp.replace(/\s*\([^)]*\)\s*$/, '').trim());
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/**
 * Reconstitue la chaîne de transport.
 *
 * `values` arrive dans l'ordre du message : chaque relais AJOUTE son `Received:`
 * en tête, donc le premier élément est le dernier saut. La liste est retournée
 * en ordre chronologique, le seul dans lequel « d'où vient ce message et où
 * a-t-il traîné » se lit sans effort.
 */
export function parseReceivedChain(values: string[]): ReceivedHop[] {
  let previous: number | undefined;

  return [...values].reverse().map((raw, index) => {
    const { clauses, timestamp } = splitAtTimestamp(raw);
    const parsed = parseReceivedClauses(clauses);
    const date = parseHopDate(timestamp);

    // Écart avec le saut daté précédent. Un relais sans date ne casse pas la
    // chaîne : on se réfère au dernier horodatage connu.
    const current = date ? Date.parse(date) : undefined;
    const delaySeconds =
      current !== undefined && previous !== undefined
        ? Math.round((current - previous) / 1000)
        : undefined;
    if (current !== undefined) previous = current;

    return {
      index,
      ...(parsed.from ? { from: parsed.from } : {}),
      ...(parsed.by ? { by: parsed.by } : {}),
      ...(parsed.with ? { with: parsed.with } : {}),
      ...(parsed.id ? { id: parsed.id } : {}),
      ...(parsed.for ? { for: parsed.for } : {}),
      ...(date ? { date } : {}),
      ...(delaySeconds !== undefined ? { delaySeconds } : {}),
      raw,
    };
  });
}

// ---------------------------------------------------------------------------
// Analyse de l'authentification
// ---------------------------------------------------------------------------

/** Découpe sur un séparateur de niveau supérieur (parenthèses respectées). */
function splitTopLevel(value: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char === '(') depth += 1;
    else if (char === ')') depth = Math.max(0, depth - 1);
    else if (char === separator && depth === 0) {
      parts.push(value.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(value.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/**
 * Sépare le texte des commentaires entre parenthèses. Les commentaires sont
 * retirés avant l'extraction des propriétés, sans quoi un texte explicatif
 * (« domain of x@y designates … ») viendrait polluer les paires `ptype.prop=`.
 */
function stripComments(value: string): { text: string; comment?: string } {
  const comments: string[] = [];
  let out = '';
  let depth = 0;

  // Parcours par unité UTF-16 : les délimiteurs recherchés sont ASCII, donc
  // itérer par point de code n'apporterait rien et coûterait une allocation.
  // eslint-disable-next-line @typescript-eslint/prefer-for-of -- for-of est interdit par ailleurs (no-restricted-syntax)
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char === '(') {
      if (depth === 0) comments.push('');
      depth += 1;
    } else if (char === ')') {
      depth = Math.max(0, depth - 1);
    } else if (depth > 0) {
      comments[comments.length - 1] += char;
    } else {
      out += char;
    }
  }

  const comment = comments
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .join(' | ');
  return { text: out.replace(/\s+/g, ' ').trim(), ...(comment ? { comment } : {}) };
}

/**
 * Décode un en-tête `Authentication-Results` (RFC 8601).
 *
 * Forme : `authserv-id; method=result (commentaire) ptype.prop=valeur; …`
 */
export function parseAuthenticationResults(value: string): AuthResultsHeader {
  const [first, ...rest] = splitTopLevel(value, ';');
  // L'identité du serveur peut être suivie d'un numéro de version (« mx.a.com 1 »).
  const authServId = first ? first.split(/\s+/)[0] : undefined;

  const methods: AuthMethodResult[] = [];
  rest.forEach((segment) => {
    const { text, comment } = stripComments(segment);
    const head = /^([A-Za-z][\w-]*)\s*=\s*([A-Za-z][\w-]*)/.exec(text);
    if (!head) return;

    const properties: Record<string, string> = {};
    const propertyRe = /([A-Za-z]+\.[A-Za-z-]+)\s*=\s*(?:"([^"]*)"|([^\s;]+))/g;
    let match = propertyRe.exec(text);
    while (match !== null) {
      properties[match[1].toLowerCase()] = match[2] ?? match[3] ?? '';
      match = propertyRe.exec(text);
    }

    methods.push({
      method: head[1].toLowerCase(),
      result: head[2].toLowerCase(),
      properties,
      ...(comment ? { comment } : {}),
      raw: segment,
    });
  });

  return { ...(authServId ? { authServId } : {}), methods, raw: value };
}

/** Décode les tags utiles d'un `DKIM-Signature` (`v=1; a=…; d=…; s=…`). */
export function parseDkimSignature(value: string): DkimSignature {
  const tags: Record<string, string> = {};
  value.split(';').forEach((part) => {
    const equals = part.indexOf('=');
    if (equals > 0) {
      tags[part.slice(0, equals).trim().toLowerCase()] = part.slice(equals + 1).trim();
    }
  });
  return {
    ...(tags.d ? { domain: tags.d.toLowerCase() } : {}),
    ...(tags.s ? { selector: tags.s } : {}),
    ...(tags.a ? { algorithm: tags.a } : {}),
  };
}

// ---------------------------------------------------------------------------
// Alignement des domaines
// ---------------------------------------------------------------------------

/**
 * Domaine d'une valeur d'en-tête d'adresse (`Nom <a@b.com>`, `<a@b.com>`,
 * `a@b.com`). Retourne `undefined` si aucune adresse n'est reconnaissable.
 */
export function domainOf(addressHeader: string | undefined): string | undefined {
  if (!addressHeader) return undefined;
  const angle = /<([^>]*)>/.exec(addressHeader);
  const candidate = (angle ? angle[1] : addressHeader).trim();
  const at = candidate.lastIndexOf('@');
  if (at < 0) return undefined;
  const domain = candidate
    .slice(at + 1)
    .replace(/[>,;\s].*$/, '')
    .toLowerCase();
  return domain.length > 0 ? domain : undefined;
}

/**
 * Alignement « relâché » au sens DMARC : égalité, ou l'un est sous-domaine de
 * l'autre.
 *
 * DMARC raisonne en réalité sur le domaine ORGANISATIONNEL, ce qui exige la
 * Public Suffix List. La charger pour une aide au diagnostic serait
 * disproportionné, et l'approximation ne diverge que sur des cas tordus
 * (`a.co.uk` vs `b.co.uk`, jugés non alignés — c'est aussi le verdict DMARC).
 * Le verdict `dmarc=` de `Authentication-Results` reste faisant foi et est
 * rapporté tel quel.
 */
function domainsAligned(a: string | undefined, b: string | undefined): boolean | undefined {
  if (!a || !b) return undefined;
  if (a === b) return true;
  return a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

// ---------------------------------------------------------------------------
// Analyse complète
// ---------------------------------------------------------------------------

/** Résultats traités comme un échec lors de la rédaction des notes. */
const FAILING_RESULTS = new Set(['fail', 'softfail', 'permerror', 'temperror']);

/**
 * Assemble l'analyse complète à partir des en-têtes déjà découpés.
 *
 * Rien n'est inventé : chaque conclusion provient d'un en-tête présent, et la
 * valeur brute reste jointe (`raw`) pour que l'appelant puisse vérifier.
 */
export function analyzeHeaders(entries: HeaderEntry[]): HeaderAnalysis {
  const received = parseReceivedChain(allHeaders(entries, 'received'));

  const authHeaders = allHeaders(entries, 'authentication-results').map(parseAuthenticationResults);
  const verdicts: Record<string, AuthMethodResult> = {};
  authHeaders.forEach((header) => {
    header.methods.forEach((method) => {
      if (!(method.method in verdicts)) verdicts[method.method] = method;
    });
  });

  const dkimSignatures = allHeaders(entries, 'dkim-signature').map(parseDkimSignature);
  const receivedSpf = allHeaders(entries, 'received-spf');
  const arcSeals = allHeaders(entries, 'arc-seal').length;

  const fromDomain = domainOf(firstHeader(entries, 'from'));
  const returnPathDomain = domainOf(firstHeader(entries, 'return-path'));
  const spfVerdict = verdicts.spf;
  const spfDomain =
    domainOf(spfVerdict?.properties['smtp.mailfrom']) ??
    spfVerdict?.properties['smtp.helo']?.toLowerCase() ??
    returnPathDomain;

  const dkimDomains = [
    ...new Set(
      [
        ...dkimSignatures.map((signature) => signature.domain),
        verdicts.dkim?.properties['header.d'],
        domainOf(verdicts.dkim?.properties['header.i']),
      ]
        .filter((domain): domain is string => typeof domain === 'string' && domain.length > 0)
        .map((domain) => domain.toLowerCase()),
    ),
  ];

  const spfAligned = domainsAligned(spfDomain, fromDomain);
  const dkimAligned =
    dkimDomains.length > 0 && fromDomain
      ? dkimDomains.some((domain) => domainsAligned(domain, fromDomain) === true)
      : undefined;
  const returnPathMatchesFrom = domainsAligned(returnPathDomain, fromDomain);

  const alignment: DomainAlignment = {
    ...(fromDomain ? { fromDomain } : {}),
    ...(returnPathDomain ? { returnPathDomain } : {}),
    ...(spfDomain ? { spfDomain } : {}),
    dkimDomains,
    ...(spfAligned !== undefined ? { spfAligned } : {}),
    ...(dkimAligned !== undefined ? { dkimAligned } : {}),
    ...(returnPathMatchesFrom !== undefined ? { returnPathMatchesFrom } : {}),
  };

  // Observations — uniquement ce qui est constaté, jamais un verdict inventé.
  const notes: string[] = [];
  if (received.length === 0) {
    notes.push(
      'Aucun en-tête Received : message local, brouillon, ou en-têtes non fournis par le serveur.',
    );
  }
  if (authHeaders.length === 0) {
    notes.push(
      'Aucun en-tête Authentication-Results : le serveur de réception ne publie pas ses ' +
        'vérifications, SPF/DKIM/DMARC ne peuvent donc pas être confirmés depuis le message seul.',
    );
  }
  Object.entries(verdicts).forEach(([method, verdict]) => {
    if (FAILING_RESULTS.has(verdict.result)) {
      notes.push(`${method}=${verdict.result}${verdict.comment ? ` — ${verdict.comment}` : ''}`);
    }
  });
  if (dkimSignatures.length === 0) notes.push('Message non signé en DKIM.');
  if (dkimAligned === false) {
    notes.push(
      `Domaine DKIM (${dkimDomains.join(', ')}) non aligné avec le From (${fromDomain}) : ` +
        'signature valide pour un autre domaine — routine sur les listes de diffusion et les ' +
        "plateformes d'envoi, à regarder de près sinon.",
    );
  }
  if (returnPathMatchesFrom === false) {
    notes.push(
      `Return-Path (${returnPathDomain}) et From (${fromDomain}) sur des domaines différents.`,
    );
  }
  if (arcSeals > 0) {
    notes.push(`${arcSeals} sceau(x) ARC : le message a été réexpédié (liste ou redirection).`);
  }

  const datedHops = received.filter((hop) => hop.date);
  const firstDate = datedHops[0]?.date;
  const lastDate = datedHops[datedHops.length - 1]?.date;
  const transitSeconds =
    datedHops.length > 1 && firstDate && lastDate
      ? Math.round((Date.parse(lastDate) - Date.parse(firstDate)) / 1000)
      : undefined;

  return {
    received,
    ...(transitSeconds !== undefined ? { transitSeconds } : {}),
    authentication: { headers: authHeaders, verdicts, receivedSpf, dkimSignatures, arcSeals },
    alignment,
    notes,
  };
}
