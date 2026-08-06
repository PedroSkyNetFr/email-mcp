import { join } from 'node:path';

import { defaultEmlFilename, exportSubfolder } from './file-paths.js';

describe('defaultEmlFilename', () => {
  it('compose date, sujet et identifiant', () => {
    expect(defaultEmlFilename('1234', 'Facture de juillet', '2026-08-05T10:00:00.000Z')).toBe(
      '2026-08-05_Facture de juillet_1234.eml',
    );
  });

  it('neutralise un sujet qui tenterait une traversée de répertoire', () => {
    // Le sujet vient de l'expéditeur. La garantie qui compte n'est pas
    // l'absence de « .. » dans le texte, mais l'absence de SEPARATEUR : sans
    // séparateur, le nom reste un seul segment et ne peut pas sortir du dossier.
    const name = defaultEmlFilename('7', '../../etc/passwd', '2026-08-05T10:00:00.000Z');
    expect(name).not.toContain('/');
    expect(name).not.toContain('\\');
    expect(name.endsWith('.eml')).toBe(true);
    expect(join('/tmp/export', name).startsWith(join('/tmp/export'))).toBe(true);
  });

  it('tronque un sujet très long', () => {
    const name = defaultEmlFilename('7', 'x'.repeat(400), '2026-08-05T10:00:00.000Z');
    expect(name.length).toBeLessThan(120);
  });

  it('retombe sur des valeurs neutres sans sujet ni date exploitable', () => {
    expect(defaultEmlFilename('7')).toBe('sans-date_sans-objet_7.eml');
    expect(defaultEmlFilename('7', 'Objet', 'pas-une-date')).toBe('sans-date_Objet_7.eml');
  });

  it('assainit aussi l’identifiant (un id Graph est une chaîne opaque)', () => {
    expect(defaultEmlFilename('AAA/BBB=', 'Objet', '2026-08-05T00:00:00.000Z')).toBe(
      '2026-08-05_Objet_AAA_BBB=.eml',
    );
  });
});

describe('exportSubfolder', () => {
  const email = { date: '2026-08-05T10:00:00.000Z', from: { address: 'contact@exemple.fr' } };

  it('mode flat : chaîne vide, la destination reste le dossier racine', () => {
    expect(exportSubfolder('flat', email, 'perso')).toBe('');
  });

  it('mode date : année-mois en UTC', () => {
    expect(exportSubfolder('date', email, 'perso')).toBe('2026-08');
  });

  it('mode sender : domaine de l’expéditeur', () => {
    expect(exportSubfolder('sender', email, 'perso')).toBe('exemple.fr');
  });

  it('mode account : nom du compte assaini', () => {
    expect(exportSubfolder('account', email, 'perso/pro')).toBe('perso_pro');
  });

  it('retombe sur des libellés explicites quand la donnée manque', () => {
    expect(exportSubfolder('date', { ...email, date: 'illisible' }, 'perso')).toBe('unknown-date');
    expect(exportSubfolder('sender', { ...email, from: { address: 'sans-arobase' } }, 'p')).toBe(
      'unknown-sender',
    );
  });
});
