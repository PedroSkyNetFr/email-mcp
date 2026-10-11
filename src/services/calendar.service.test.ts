import { describe, expect, it } from 'vitest';

import CalendarService from './calendar.service.js';

// Invitation telle qu'Outlook / Exchange l'écrit : propriétés texte avec un
// paramètre LANGUAGE, organisateur et participants avec CN, fuseau Windows.
const OUTLOOK_INVITE = [
  'BEGIN:VCALENDAR',
  'METHOD:REQUEST',
  'PRODID:Microsoft Exchange Server 2010',
  'VERSION:2.0',
  'BEGIN:VTIMEZONE',
  'TZID:Romance Standard Time',
  'BEGIN:STANDARD',
  'DTSTART:16010101T030000',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10',
  'END:STANDARD',
  'BEGIN:DAYLIGHT',
  'DTSTART:16010101T020000',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3',
  'END:DAYLIGHT',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'ORGANIZER;CN=Jean Dupont:mailto:jean@example.test',
  'ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Marie:mailto:marie@example.test',
  'ATTENDEE;CN=Paul:mailto:paul@example.test',
  'DESCRIPTION;LANGUAGE=fr-FR:Ordre du jour\\, point budget',
  'UID:040000008200E00074C5B7101A82E008',
  'SUMMARY;LANGUAGE=fr-FR:Réunion budget',
  'DTSTART;TZID=Romance Standard Time:20261020T140000',
  'DTEND;TZID=Romance Standard Time:20261020T150000',
  'RRULE:FREQ=WEEKLY;COUNT=3;BYDAY=TU',
  'LOCATION;LANGUAGE=fr-FR:Salle 2',
  'STATUS:TENTATIVE',
  'DTSTAMP:20261011T090000Z',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

const PLAIN_EVENT = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:plain-1',
  'SUMMARY:Point simple',
  'DTSTART:20261101T090000Z',
  'DTEND:20261101T100000Z',
  'DTSTAMP:20261011T090000Z',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

describe('CalendarService.parseIcs', () => {
  it('lit une invitation Outlook avec paramètres LANGUAGE, fuseau Windows et récurrence', () => {
    const [event] = CalendarService.parseIcs(OUTLOOK_INVITE);

    expect(event).toMatchObject({
      uid: '040000008200E00074C5B7101A82E008',
      summary: 'Réunion budget',
      description: 'Ordre du jour, point budget',
      location: 'Salle 2',
      // 14 h à Paris, heure d'été : 12 h UTC.
      start: '2026-10-20T12:00:00.000Z',
      end: '2026-10-20T13:00:00.000Z',
      status: 'TENTATIVE',
      method: 'REQUEST',
      organizer: { name: 'Jean Dupont', address: 'jean@example.test' },
      attendees: [
        { name: 'Marie', address: 'marie@example.test' },
        { name: 'Paul', address: 'paul@example.test' },
      ],
    });
    expect(event?.recurrence).toContain('FREQ=WEEKLY;COUNT=3;BYDAY=TU');
  });

  it('lit un événement sans paramètre ni METHOD', () => {
    expect(CalendarService.parseIcs(PLAIN_EVENT)).toEqual([
      {
        uid: 'plain-1',
        summary: 'Point simple',
        description: undefined,
        start: '2026-11-01T09:00:00.000Z',
        end: '2026-11-01T10:00:00.000Z',
        location: undefined,
        organizer: undefined,
        attendees: [],
        status: 'CONFIRMED',
        method: undefined,
        recurrence: undefined,
      },
    ]);
  });

  it('dédoublonne par UID entre plusieurs parties', () => {
    const events = new CalendarService().extractFromParts([PLAIN_EVENT, PLAIN_EVENT]);
    expect(events).toHaveLength(1);
  });
});
