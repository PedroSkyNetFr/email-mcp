/**
 * Préfixes d'objet « Re: » / « Fwd: » — détection insensible à la casse et
 * multilingue.
 *
 * L'ancien test (`subject.startsWith('Re:')`) ne reconnaissait que la graphie
 * exacte « Re: ». Un objet « RE: Devis » (Outlook) ou « AW: Angebot »
 * (Outlook allemand) recevait donc un second préfixe : « Re: RE: Devis », puis
 * « Re: Re: RE: Devis » au tour suivant. Les fonctions ci-dessous reconnaissent
 * les variantes courantes, avec un éventuel compteur (`Re[2]:`, `RE(3):`), des
 * espaces avant les deux-points et le deux-points pleine chasse (`：`).
 */

/** Préfixes de réponse : anglais, allemand, scandinave, néerlandais, italien, etc. */
const REPLY_PREFIXES = [
  're', // anglais, français, espagnol…
  'aw', // allemand (Antwort)
  'sv', // suédois, norvégien, danois (Svar)
  'antw', // néerlandais (Antwoord)
  'vs', // finnois (Vastaus)
  'rif', // italien (Riferimento)
  'odp', // polonais (Odpowiedź)
  'ynt', // turc (Yanıt)
  'res', // portugais (Resposta)
  'atb', // letton
  'σχετ', // grec
  '回复',
  '答复',
];

/** Préfixes de transfert. */
const FORWARD_PREFIXES = [
  'fwd',
  'fw',
  'tr', // français (Outlook : « TR: »)
  'wg', // allemand (Weitergeleitet)
  'enc', // portugais (Encaminhado)
  'rv', // espagnol (Reenviado)
  'doorst', // néerlandais (Doorsturen)
  'vb', // néerlandais / scandinave (Videresendt)
  'vl', // finnois (Välitetty)
  'pd', // polonais (Przekazano dalej)
  '转发',
  // « I: » (Outlook italien) est volontairement absent : un préfixe d'une
  // lettre reconnaîtrait à tort un objet comme « I: retour de congés », et ne
  // pas ajouter « Fwd: » serait pire qu'en ajouter un de trop.
];

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function prefixRegex(prefixes: string[]): RegExp {
  // Les préfixes longs d'abord, pour que « fwd » soit essayé avant « fw ».
  const alternation = [...prefixes]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex)
    .join('|');
  // ^ espaces? PRÉFIXE compteur? espaces? deux-points (ASCII ou pleine chasse)
  return new RegExp(`^\\s*(?:${alternation})\\s*(?:\\[\\d+\\]|\\(\\d+\\))?\\s*[:：]`, 'iu');
}

const REPLY_RE = prefixRegex(REPLY_PREFIXES);
const FORWARD_RE = prefixRegex(FORWARD_PREFIXES);

/** L'objet commence-t-il déjà par un préfixe de réponse (toutes variantes) ? */
export function hasReplyPrefix(subject: string): boolean {
  return REPLY_RE.test(subject);
}

/** L'objet commence-t-il déjà par un préfixe de transfert (toutes variantes) ? */
export function hasForwardPrefix(subject: string): boolean {
  return FORWARD_RE.test(subject);
}

/**
 * Objet d'une réponse : l'objet d'origine tel quel s'il porte déjà un préfixe
 * de réponse (quelle qu'en soit la langue ou la casse), sinon « Re: » + objet.
 * Un objet de transfert (« Fwd: x ») reçoit bien « Re: Fwd: x » : c'est l'usage.
 */
export function replySubject(subject: string): string {
  return hasReplyPrefix(subject) ? subject : `Re: ${subject}`;
}

/** Objet d'un transfert : même règle avec « Fwd: ». « Re: x » devient « Fwd: Re: x ». */
export function forwardSubject(subject: string): string {
  return hasForwardPrefix(subject) ? subject : `Fwd: ${subject}`;
}
