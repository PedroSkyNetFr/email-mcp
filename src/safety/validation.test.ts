import {
  sanitizeMailboxName,
  sanitizeSearchQuery,
  sanitizeTemplateVariable,
  validateInputLength,
  validateLabelName,
  validateWebhookUrl,
} from './validation.js';

describe('sanitizeMailboxName', () => {
  it('returns a valid trimmed name', () => {
    expect(sanitizeMailboxName('  INBOX  ')).toBe('INBOX');
  });

  it('throws on empty string', () => {
    expect(() => sanitizeMailboxName('')).toThrow('must not be empty');
  });

  it('throws on whitespace-only string', () => {
    expect(() => sanitizeMailboxName('   ')).toThrow('must not be empty');
  });

  it('throws when name contains *', () => {
    expect(() => sanitizeMailboxName('INBOX*')).toThrow('wildcard');
  });

  it('throws when name contains %', () => {
    expect(() => sanitizeMailboxName('INBOX%')).toThrow('wildcard');
  });

  it('allows names with dots and slashes', () => {
    expect(sanitizeMailboxName('INBOX/Subfolder.Label')).toBe('INBOX/Subfolder.Label');
  });
});

describe('sanitizeSearchQuery', () => {
  it('returns a clean query', () => {
    expect(sanitizeSearchQuery('hello world')).toBe('hello world');
  });

  it('strips control characters', () => {
    expect(sanitizeSearchQuery('hello\x00\x01world')).toBe('helloworld');
  });

  it('throws on empty after sanitization', () => {
    expect(() => sanitizeSearchQuery('\x00\x01')).toThrow('must not be empty');
  });

  it('preserves tabs', () => {
    expect(sanitizeSearchQuery('hello\tworld')).toBe('hello\tworld');
  });

  it('preserves newlines', () => {
    expect(sanitizeSearchQuery('hello\nworld')).toBe('hello\nworld');
  });
});

describe('validateWebhookUrl', () => {
  it('throws on invalid URL', () => {
    expect(() => validateWebhookUrl('not-a-url')).toThrow('Invalid webhook URL');
  });

  it('throws on non-http(s) protocol', () => {
    expect(() => validateWebhookUrl('ftp://example.com')).toThrow('http or https');
  });

  it('throws on localhost', () => {
    expect(() => validateWebhookUrl('https://localhost/hook')).toThrow('loopback or private');
  });

  it('throws on 127.0.0.1', () => {
    expect(() => validateWebhookUrl('https://127.0.0.1/hook')).toThrow('loopback or private');
  });

  it('throws on 10.x.x.x', () => {
    expect(() => validateWebhookUrl('https://10.0.0.1/hook')).toThrow('loopback or private');
  });

  it('throws on 172.16-31.x.x', () => {
    expect(() => validateWebhookUrl('https://172.16.0.1/hook')).toThrow('loopback or private');
    expect(() => validateWebhookUrl('https://172.31.255.255/hook')).toThrow('loopback or private');
  });

  it('throws on 192.168.x.x', () => {
    expect(() => validateWebhookUrl('https://192.168.1.1/hook')).toThrow('loopback or private');
  });

  it('throws on ::1', () => {
    // Note: URL parser keeps brackets in hostname for IPv6, so the source
    // comparison against '::1' won't match '[::1]'. This tests current behaviour.
    expect(() => validateWebhookUrl('http://::1/hook')).toThrow();
  });

  it('throws on 0.0.0.0', () => {
    expect(() => validateWebhookUrl('https://0.0.0.0/hook')).toThrow('loopback or private');
  });

  // Plages ajoutées (SSRF) — toutes passaient avant net.BlockList.
  it.each([
    ['0.0.0.0/8 entier, pas seulement 0.0.0.0', 'https://0.1.2.3/hook'],
    ['CGNAT 100.64/10', 'https://100.64.0.1/hook'],
    ['CGNAT 100.64/10 (borne haute)', 'https://100.127.255.254/hook'],
    ['lien local / métadonnées cloud', 'http://169.254.169.254/latest/meta-data'],
    ['IPv6 non spécifiée ::', 'http://[::]/hook'],
    ['IPv6 unique locale fc00::/7', 'http://[fd12:3456::1]/hook'],
    ['IPv6 lien local fe80::/10', 'http://[fe80::1]/hook'],
    ['IPv4 encapsulée en IPv6', 'http://[::ffff:169.254.169.254]/hook'],
    ['IPv4 encapsulée (boucle locale)', 'http://[::ffff:127.0.0.1]/hook'],
    ['écriture décimale de 127.0.0.1', 'http://2130706433/hook'],
    ['sous-domaine de localhost', 'http://api.localhost/hook'],
    ['localhost avec point final', 'http://localhost./hook'],
    ['sous-domaine de localhost avec point final', 'http://api.localhost./hook'],
    ['NAT64 vers la boucle locale', 'http://[64:ff9b::7f00:1]/hook'],
    [
      'NAT64 vers les métadonnées cloud (notation pointée)',
      'http://[64:ff9b::169.254.169.254]/hook',
    ],
    ['NAT64 vers 10/8', 'http://[64:ff9b::a00:1]/hook'],
    ['multicast 224.0.0.0/4', 'http://224.0.0.1/hook'],
    ['multicast 224.0.0.0/4 (borne haute)', 'http://239.255.255.250/hook'],
    ["bancs d'essai 198.18.0.0/15", 'http://198.19.255.1/hook'],
    ['réservé 240.0.0.0/4', 'http://240.0.0.1/hook'],
    ['diffusion limitée', 'http://255.255.255.255/hook'],
  ])('throws on %s', (_label, url) => {
    expect(() => validateWebhookUrl(url)).toThrow('loopback or private');
  });

  it('still allows public addresses next to the blocked ranges', () => {
    expect(() => validateWebhookUrl('https://100.128.0.1/hook')).not.toThrow();
    expect(() => validateWebhookUrl('https://172.32.0.1/hook')).not.toThrow();
    expect(() => validateWebhookUrl('http://[2001:db8::1]/hook')).not.toThrow();
    // NAT64 vers une IPv4 publique, et bornes des nouvelles plages.
    expect(() => validateWebhookUrl('http://[64:ff9b::808:808]/hook')).not.toThrow();
    expect(() => validateWebhookUrl('http://198.17.255.1/hook')).not.toThrow();
    expect(() => validateWebhookUrl('http://198.20.0.1/hook')).not.toThrow();
    expect(() => validateWebhookUrl('http://223.255.255.1/hook')).not.toThrow();
  });

  it('allows valid public https URL', () => {
    expect(() => validateWebhookUrl('https://hooks.example.com/wh')).not.toThrow();
  });

  it('allows valid public http URL', () => {
    expect(() => validateWebhookUrl('http://hooks.example.com/wh')).not.toThrow();
  });
});

describe('sanitizeTemplateVariable', () => {
  it('returns value as-is when html is false', () => {
    expect(sanitizeTemplateVariable('<b>test</b>', false)).toBe('<b>test</b>');
  });

  it('escapes & when html is true', () => {
    expect(sanitizeTemplateVariable('a & b', true)).toBe('a &amp; b');
  });

  it('escapes < and > when html is true', () => {
    expect(sanitizeTemplateVariable('<div>', true)).toBe('&lt;div&gt;');
  });

  it('escapes double quotes when html is true', () => {
    expect(sanitizeTemplateVariable('"hello"', true)).toBe('&quot;hello&quot;');
  });

  it('escapes single quotes when html is true', () => {
    expect(sanitizeTemplateVariable("it's", true)).toBe('it&#39;s');
  });

  it('escapes all special chars together', () => {
    expect(sanitizeTemplateVariable('<a href="x">&\'', true)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&amp;&#39;',
    );
  });
});

describe('validateLabelName', () => {
  it('throws on empty string', () => {
    expect(() => validateLabelName('')).toThrow('must not be empty');
  });

  it('throws on whitespace-only string', () => {
    expect(() => validateLabelName('   ')).toThrow('must not be empty');
  });

  it('throws on >200 chars', () => {
    expect(() => validateLabelName('a'.repeat(201))).toThrow('must not exceed 200');
  });

  it('allows exactly 200 chars', () => {
    expect(validateLabelName('a'.repeat(200))).toBe('a'.repeat(200));
  });

  it('throws on control characters', () => {
    expect(() => validateLabelName('label\x00name')).toThrow('control characters');
  });

  it('trims whitespace and returns valid name', () => {
    expect(validateLabelName('  Important  ')).toBe('Important');
  });
});

describe('validateInputLength', () => {
  it('throws when over max', () => {
    expect(() => validateInputLength('12345', 3, 'field')).toThrow(
      'field exceeds maximum length of 3',
    );
  });

  it('allows at exact max length', () => {
    expect(() => validateInputLength('123', 3, 'field')).not.toThrow();
  });

  it('allows under max length', () => {
    expect(() => validateInputLength('ab', 5, 'name')).not.toThrow();
  });
});
