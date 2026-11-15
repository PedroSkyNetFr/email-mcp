/** Input validation and sanitization utilities. */

import { BlockList, isIP } from 'node:net';

/**
 * Plages vers lesquelles un webhook ne doit jamais partir (SSRF).
 *
 * Une liste écrite à la main (regex, comparaison d'octets) est exactement le
 * genre de contrôle qui dérive en silence : l'ancienne oubliait 169.254.0.0/16
 * — dont 169.254.169.254, l'adresse de métadonnées des clouds qui distribue
 * des identifiants à tout processus qui la joint —, la plage CGNAT, tout
 * 0.0.0.0/8 (seul « 0.0.0.0 » littéral était refusé), « :: » et les plages
 * privées IPv6. `net.BlockList` est le comparateur CIDR de Node ; il confronte
 * aussi une adresse IPv4 encapsulée en IPv6 (`::ffff:a.b.c.d`) aux plages IPv4,
 * forme que l'analyseur d'URL réécrit d'ailleurs en hexadécimal.
 */
const PRIVATE_WEBHOOK_RANGES = new BlockList();
// 0.0.0.0/8 : « ce réseau » — non routable, même esprit que « :: ».
PRIVATE_WEBHOOK_RANGES.addSubnet('0.0.0.0', 8, 'ipv4');
PRIVATE_WEBHOOK_RANGES.addSubnet('10.0.0.0', 8, 'ipv4');
// 100.64.0.0/10 : espace partagé du NAT des opérateurs (CGNAT).
PRIVATE_WEBHOOK_RANGES.addSubnet('100.64.0.0', 10, 'ipv4');
PRIVATE_WEBHOOK_RANGES.addSubnet('127.0.0.0', 8, 'ipv4');
// 169.254.0.0/16 : lien local, dont le point de métadonnées cloud.
PRIVATE_WEBHOOK_RANGES.addSubnet('169.254.0.0', 16, 'ipv4');
PRIVATE_WEBHOOK_RANGES.addSubnet('172.16.0.0', 12, 'ipv4');
PRIVATE_WEBHOOK_RANGES.addSubnet('192.168.0.0', 16, 'ipv4');
PRIVATE_WEBHOOK_RANGES.addSubnet('::', 128, 'ipv6'); // adresse non spécifiée
PRIVATE_WEBHOOK_RANGES.addSubnet('::1', 128, 'ipv6'); // boucle locale
PRIVATE_WEBHOOK_RANGES.addSubnet('fe80::', 10, 'ipv6'); // lien local
PRIVATE_WEBHOOK_RANGES.addSubnet('fc00::', 7, 'ipv6'); // adresses uniques locales (fc00::/fd00::)

/**
 * Validate and sanitize an IMAP mailbox name.
 * Rejects names containing IMAP wildcard characters (`*`, `%`) or empty strings.
 * @param name - The mailbox name to validate.
 * @returns The trimmed mailbox name.
 */
export function sanitizeMailboxName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error('Mailbox name must not be empty');
  }
  if (trimmed.includes('*') || trimmed.includes('%')) {
    throw new Error('Mailbox name must not contain IMAP wildcard characters (* or %)');
  }
  return trimmed;
}

/**
 * Strip control characters from an IMAP search query.
 * Removes ASCII 0-31 except tab (0x09) and newline (0x0A).
 * @param query - The raw search query.
 * @returns The sanitized query string.
 */
export function sanitizeSearchQuery(query: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — sanitize control chars from user input
  const cleaned = query.replace(/[\x00-\x08\x0B-\x1F]/g, '').trim(); // eslint-disable-line no-control-regex
  if (cleaned.length === 0) {
    throw new Error('Search query must not be empty after sanitization');
  }
  return cleaned;
}

/**
 * Validate a webhook URL.
 * Ensures the URL uses http(s) and does not point to a private or loopback address.
 * @param url - The webhook URL to validate.
 */
export function validateWebhookUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid webhook URL: ${url}`);
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Webhook URL must use http or https protocol, got ${parsed.protocol}`);
  }

  const hostname = parsed.hostname.toLowerCase();

  // new URL('https://[::1]') stores hostname as '[::1]'
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (bare === 'localhost' || bare.endsWith('.localhost')) {
    throw new Error(`Webhook URL must not point to a loopback or private address: ${bare}`);
  }

  // L'analyseur WHATWG a déjà normalisé les écritures exotiques d'une IPv4
  // (`0x7f.1`, `2130706433` → `127.0.0.1`) : seule la forme canonique arrive ici.
  const family = isIP(bare);
  if (family !== 0 && PRIVATE_WEBHOOK_RANGES.check(bare, family === 4 ? 'ipv4' : 'ipv6')) {
    throw new Error(`Webhook URL must not point to a loopback or private address: ${bare}`);
  }
  // Un nom d'hôte (et non une IP littérale) se résout au moment de la requête,
  // hors de portée de ce contrôle : le contournement par DNS est un angle mort
  // assumé. `webhook_url` vient de la configuration locale de l'utilisateur,
  // pas d'une entrée réseau contrôlée par un attaquant.
}

/**
 * Sanitize a value for use in a template.
 * When `html` is true, HTML-special characters are escaped.
 * @param value - The template variable value.
 * @param html - Whether to apply HTML escaping.
 * @returns The sanitized value.
 */
export function sanitizeTemplateVariable(value: string, html: boolean): string {
  if (!html) {
    return value;
  }
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Validate an email label name.
 * Rejects labels with control characters or that exceed 200 characters.
 * @param name - The label name to validate.
 * @returns The trimmed label name.
 */
export function validateLabelName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error('Label name must not be empty');
  }
  if (trimmed.length > 200) {
    throw new Error('Label name must not exceed 200 characters');
  }
  /* eslint-disable no-control-regex */
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — reject control chars in label names
  if (/[\x00-\x1F]/.test(trimmed)) {
    throw new Error('Label name must not contain control characters');
  }
  /* eslint-enable no-control-regex */
  return trimmed;
}

/**
 * Validate that an input string does not exceed a maximum length.
 * @param input - The input string to check.
 * @param maxLength - The maximum allowed length.
 * @param fieldName - The field name for the error message.
 */
export function validateInputLength(input: string, maxLength: number, fieldName: string): void {
  if (input.length > maxLength) {
    throw new Error(`${fieldName} exceeds maximum length of ${maxLength} characters`);
  }
}
