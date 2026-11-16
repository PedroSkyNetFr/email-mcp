/**
 * Petits outils sur les noms d'hôte et adresses IP, partagés par la sécurité
 * des connexions (STARTTLS) et le contrôle SSRF des webhooks.
 */

import { isIP } from 'node:net';

/**
 * Forme canonique d'un hôte : minuscules, sans crochets IPv6 et sans le point
 * final d'un nom pleinement qualifié (`localhost.` désigne le même hôte que
 * `localhost`, et l'analyseur d'URL conserve ce point).
 */
export function normalizeHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '');
}

/**
 * Développe une adresse IPv6 (y compris `::` et une IPv4 finale en notation
 * pointée) en ses huit groupes de 16 bits. `undefined` si ce n'est pas une IPv6.
 */
export function ipv6Groups(address: string): number[] | undefined {
  if (isIP(address) !== 6) return undefined;
  let text = address.split('%')[0]; // zone d'interface (fe80::1%eth0)
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const bytes = dotted[1].split('.').map(Number);
    const hi = (bytes[0] * 256 + bytes[1]).toString(16);
    const lo = (bytes[2] * 256 + bytes[3]).toString(16);
    text = `${text.slice(0, -dotted[1].length)}${hi}:${lo}`;
  }
  const [head, tail] = text.includes('::') ? text.split('::') : [text, undefined];
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const missing = 8 - left.length - right.length;
  const groups = [...left, ...Array<string>(tail === undefined ? 0 : missing).fill('0'), ...right];
  if (groups.length !== 8) return undefined;
  return groups.map((g) => Number.parseInt(g, 16));
}

/**
 * IPv4 encapsulée dans une adresse NAT64 du préfixe bien connu 64:ff9b::/96
 * (RFC 6052) : `64:ff9b::7f00:1` joint 127.0.0.1 à travers une passerelle
 * NAT64. `undefined` hors de ce préfixe.
 */
export function nat64EmbeddedIpv4(address: string): string | undefined {
  const groups = ipv6Groups(address);
  if (!groups) return undefined;
  const prefix = [0x64, 0xff9b, 0, 0, 0, 0];
  if (!prefix.every((value, i) => groups[i] === value)) return undefined;
  // Chaque groupe de 16 bits porte deux octets de l'IPv4 (poids fort, faible).
  const bytes = [groups[6], groups[7]].flatMap((g) => [Math.floor(g / 256), g % 256]);
  return bytes.join('.');
}

/**
 * Hôte de bouclage : `localhost` (avec ou sans point final), 127.0.0.0/8 et
 * `::1` (ainsi que `::ffff:127.x.y.z`). Le trafic vers ces adresses ne quitte
 * pas la machine.
 */
export function isLoopbackHost(host: string): boolean {
  const bare = normalizeHost(host);
  if (bare === 'localhost') return true;
  if (isIP(bare) === 4) return bare.split('.')[0] === '127';
  const groups = ipv6Groups(bare);
  if (!groups) return false;
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1
  // ::ffff:127.x.y.z (IPv4 encapsulée)
  return (
    groups.slice(0, 5).every((g) => g === 0) &&
    groups[5] === 0xffff &&
    Math.floor(groups[6] / 256) === 127
  );
}
