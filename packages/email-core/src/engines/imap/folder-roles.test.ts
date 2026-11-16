import { resolveRoles, roleFromName } from './folder-roles.js';

// The four OVH mailboxes measured on 2026-11-16 (read-only), reduced to the
// folders that matter here.
const ovh = (sent: number, envoyes: number) => [
  { path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox', specialUseSource: 'extension' as const },
  {
    path: 'Sent',
    name: 'Sent',
    specialUse: '\\Sent',
    specialUseSource: 'extension' as const,
    total: sent,
  },
  { path: 'Éléments envoyés', name: 'Éléments envoyés', total: envoyes },
];

describe('roleFromName', () => {
  it('recognises localised names without case or accents', () => {
    expect(roleFromName('Éléments envoyés')).toBe('sent');
    expect(roleFromName('ELEMENTS ENVOYES')).toBe('sent');
    expect(roleFromName('Courrier indésirable')).toBe('junk');
    expect(roleFromName('Projets 2026')).toBeUndefined();
  });
});

describe('resolveRoles', () => {
  it('reports "Éléments envoyés" as a candidate when it holds more mail than the flagged "Sent"', () => {
    const [, sent] = resolveRoles(ovh(5, 560));

    expect(sent).toEqual({
      role: 'sent',
      roleSource: 'server',
      candidatePaths: ['Éléments envoyés'],
    });
  });

  it('reports no candidate when the flagged folder is really the one in use', () => {
    const [, sent] = resolveRoles(ovh(478, 0));

    expect(sent).toEqual({ role: 'sent', roleSource: 'server' });
  });

  it('treats a role set by the config as final', () => {
    const [inbox, sent, envoyes] = resolveRoles([
      ovh(5, 560)[0],
      { path: 'Sent', name: 'Sent', total: 5 },
      {
        path: 'Éléments envoyés',
        name: 'Éléments envoyés',
        specialUse: '\\Sent',
        specialUseSource: 'user',
        total: 560,
      },
    ]);

    expect(inbox).toEqual({ role: 'inbox', roleSource: 'server' });
    expect(sent).toEqual({});
    expect(envoyes).toEqual({ role: 'sent', roleSource: 'config' });
  });

  it('keeps a role guessed by imapflow from the name, as such', () => {
    const [archive] = resolveRoles([
      { path: 'Archive', name: 'Archive', specialUse: '\\Archive', specialUseSource: 'name' },
    ]);

    expect(archive).toEqual({ role: 'archive', roleSource: 'name' });
  });
});
