import { buildInfo } from './build-info.js';

describe('buildInfo', () => {
  it('reporte la version telle quelle', async () => {
    expect((await buildInfo('1.2.3')).version).toBe('1.2.3');
  });

  it('detecte le mode d’execution depuis l’extension du module', async () => {
    // Sous vitest le module est le .ts, donc `src` ; compilé il finit en .js.
    const info = await buildInfo('1.2.3');
    expect(['src', 'dist']).toContain(info.runningFrom);
    expect(info.modulePath).toContain('build-info');
  });

  it('date le fichier execute et en calcule l’age', async () => {
    const info = await buildInfo('1.2.3');
    expect(info.builtAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(info.ageDays).toBeGreaterThanOrEqual(0);
  });

  it('calcule un age en jours a partir de la date fournie', async () => {
    const info = await buildInfo('1.2.3');
    const built = new Date(info.builtAt as string);
    const dixJoursPlusTard = new Date(built.getTime() + 10 * 86_400_000);
    expect((await buildInfo('1.2.3', dixJoursPlusTard)).ageDays).toBe(10);
  });
});
