import {
  forwardSubject,
  hasForwardPrefix,
  hasReplyPrefix,
  replySubject,
} from './subject-prefix.js';

describe('replySubject', () => {
  it.each([
    'Re: Devis',
    'RE: Devis',
    're: devis',
    'Re : Devis', // espace avant les deux-points (Outlook français)
    'AW: Angebot',
    'Aw: Angebot',
    'SV: Fråga',
    'Antw: Vraag',
    'Rif: Preventivo',
    'Re[2]: Devis',
    'RE(3): Devis',
    '  Re: Devis',
    '回复：会议',
  ])('keeps "%s" as is', (subject) => {
    expect(replySubject(subject)).toBe(subject);
  });

  it('adds "Re:" to a fresh subject', () => {
    expect(replySubject('Devis')).toBe('Re: Devis');
  });

  it('adds "Re:" in front of a forward prefix (usage courant)', () => {
    expect(replySubject('Fwd: Devis')).toBe('Re: Fwd: Devis');
  });

  it('does not mistake a word starting with a prefix for a prefix', () => {
    expect(hasReplyPrefix('Recette du jour')).toBe(false);
    expect(hasReplyPrefix('Résumé: semaine 12')).toBe(false);
    expect(hasReplyPrefix('Aware: note')).toBe(false);
  });
});

describe('forwardSubject', () => {
  it.each([
    'Fwd: Devis',
    'FWD: Devis',
    'Fw: Devis',
    'FW: Devis',
    'TR: Réunion',
    'WG: Angebot',
    'Enc: Proposta',
    'RV: Propuesta',
    'Fwd[2]: Devis',
    '转发：会议',
  ])('keeps "%s" as is', (subject) => {
    expect(forwardSubject(subject)).toBe(subject);
  });

  it('adds "Fwd:" to a fresh subject or a reply', () => {
    expect(forwardSubject('Devis')).toBe('Fwd: Devis');
    expect(forwardSubject('Re: Devis')).toBe('Fwd: Re: Devis');
  });

  it('does not match words that merely start like a prefix', () => {
    expect(hasForwardPrefix('Travaux: planning')).toBe(false);
    expect(hasForwardPrefix('Fwding rules')).toBe(false);
    // Préfixe d'une lettre volontairement non reconnu.
    expect(hasForwardPrefix('I: retour de congés')).toBe(false);
  });
});
