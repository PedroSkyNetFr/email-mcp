import { ipv6Groups, isLoopbackHost, nat64EmbeddedIpv4, normalizeHost } from './host.js';

describe('host utils', () => {
  it('normalizes case, IPv6 brackets and the FQDN trailing dot', () => {
    expect(normalizeHost('LocalHost.')).toBe('localhost');
    expect(normalizeHost('[::1]')).toBe('::1');
  });

  it('expands IPv6 addresses, including an embedded dotted IPv4', () => {
    expect(ipv6Groups('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(ipv6Groups('64:ff9b::127.0.0.1')).toEqual([0x64, 0xff9b, 0, 0, 0, 0, 0x7f00, 1]);
    expect(ipv6Groups('example.com')).toBeUndefined();
  });

  it('decodes the IPv4 of a NAT64 well-known-prefix address only', () => {
    expect(nat64EmbeddedIpv4('64:ff9b::7f00:1')).toBe('127.0.0.1');
    expect(nat64EmbeddedIpv4('64:ff9b::a9fe:a9fe')).toBe('169.254.169.254');
    expect(nat64EmbeddedIpv4('2001:db8::7f00:1')).toBeUndefined();
  });

  it.each([
    'localhost',
    'localhost.',
    'LOCALHOST',
    '127.0.0.1',
    '127.1.2.3',
    '::1',
    '[::1]',
    '::ffff:127.0.0.1',
  ])('%s is a loopback host', (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each(['imap.example.com', 'localhost.example.com', '128.0.0.1', '10.0.0.1', '::2', 'fe80::1'])(
    '%s is not a loopback host',
    (host) => {
      expect(isLoopbackHost(host)).toBe(false);
    },
  );
});
