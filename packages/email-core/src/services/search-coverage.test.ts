import { buildCoverage, continuationBefore } from './search-coverage.js';

describe('continuationBefore', () => {
  it('instant granularity: one second after the oldest examined message', () => {
    expect(continuationBefore(new Date('2025-03-14T22:10:05Z'), 'instant')).toBe(
      '2025-03-14T22:10:06.000Z',
    );
  });

  it('day granularity: the next day, even early in the UTC day', () => {
    expect(continuationBefore(new Date('2025-03-14T08:00:00Z'), 'day')).toBe('2025-03-15');
  });

  it('day granularity: covers a server whose timezone already reads the next day', () => {
    // 23:30 UTC est déjà le 15 à Paris : `before: 2025-03-15` l'exclurait.
    expect(continuationBefore(new Date('2025-03-14T23:30:00Z'), 'day')).toBe('2025-03-16');
  });
});

describe('buildCoverage', () => {
  const base = {
    stoppedBy: 'time_budget' as const,
    examined: 1200,
    candidates: 2199,
    oldestExamined: new Date('2025-03-14T08:00:00Z'),
    granularity: 'day' as const,
  };

  it('states examined / candidates, the oldest date and the before to continue with', () => {
    const coverage = buildCoverage(base);

    expect(coverage).toMatchObject({
      stoppedBy: 'time_budget',
      examined: 1200,
      candidates: 2199,
      oldestExamined: '2025-03-14T08:00:00.000Z',
      continueBefore: '2025-03-15',
    });
    expect(coverage.hint).toBe(
      'Partial scan: examined the 1200 most recent of 2199 candidate messages ' +
        '(time budget of 45 s reached). Oldest message examined: 2025-03-14T08:00:00.000Z. ' +
        'Results and total cover only the examined messages. To continue, re-run the same ' +
        'call with before: "2025-03-15" (consecutive calls may overlap slightly, so a message ' +
        'can appear twice).',
    );
  });

  it('refuses a continuation that would replay the same slice forever', () => {
    // Le `before` courant est déjà le 15 : reprendre au 15 ne progresse pas.
    const coverage = buildCoverage({ ...base, currentBefore: '2025-03-15' });

    expect(coverage.continueBefore).toBeUndefined();
    expect(coverage.hint).toMatch(/Cannot advance by date/);
  });

  it('accepts a relative current before', () => {
    const coverage = buildCoverage({ ...base, currentBefore: '1d' });

    expect(coverage.continueBefore).toBe('2025-03-15');
  });

  it('marks an unknown candidate count as a floor', () => {
    const coverage = buildCoverage({
      ...base,
      stoppedBy: 'server_cap',
      candidates: 1000,
      candidatesApprox: true,
    });

    expect(coverage.hint).toMatch(/of at least 1000 candidate messages/);
    expect(coverage.hint).toMatch(/server returned no further search results/);
  });
});
