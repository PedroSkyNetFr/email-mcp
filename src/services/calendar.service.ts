/**
 * Calendar service — ICS/iCalendar parsing.
 *
 * Extracts structured calendar events from ICS content using node-ical.
 */

import type { CalendarComponent } from 'node-ical';
import ical from 'node-ical';

import type { CalendarEvent, EmailAddress } from '../types/index.js';

type IcalComponent = CalendarComponent;

export default class CalendarService {
  /**
   * Parse ICS text content into structured CalendarEvent objects.
   */
  static parseIcs(content: string): CalendarEvent[] {
    const parsed = ical.sync.parseICS(content);
    const events: CalendarEvent[] = [];

    // Extract the VCALENDAR METHOD if present
    let calendarMethod: string | undefined;
    Object.values(parsed).forEach((comp: IcalComponent | undefined) => {
      if (comp?.type === 'VCALENDAR') {
        calendarMethod = (comp as unknown as Record<string, unknown>).method as string | undefined;
      }
    });

    Object.values(parsed).forEach((comp: IcalComponent | undefined) => {
      if (comp?.type !== 'VEVENT') return;

      const event = comp as unknown as Record<string, unknown>;
      const start = event.start as Date | undefined;
      const end = event.end as Date | undefined;
      const organizer = CalendarService.parseOrganizer(event.organizer);
      const attendees = CalendarService.parseAttendees(event.attendee);
      const rrule = event.rrule as { toString: () => string } | undefined;

      events.push({
        uid: (event.uid as string) ?? '',
        summary: CalendarService.paramText(event.summary) ?? '(No title)',
        description: CalendarService.paramText(event.description),
        start: start ? start.toISOString() : '',
        end: end ? end.toISOString() : '',
        location: CalendarService.paramText(event.location),
        organizer,
        attendees,
        status: CalendarService.normalizeStatus(event.status as string | undefined),
        method: calendarMethod,
        recurrence: rrule?.toString(),
      });
    });

    // Sort by start time
    events.sort((a, b) => a.start.localeCompare(b.start));

    return events;
  }

  /**
   * Extract calendar events from raw email body parts.
   * Accepts an array of ICS content strings (from inline text/calendar parts
   * or downloaded .ics attachments).
   */
  // eslint-disable-next-line class-methods-use-this
  extractFromParts(icsContents: string[]): CalendarEvent[] {
    const allEvents: CalendarEvent[] = [];
    const seenUids = new Set<string>();

    icsContents.forEach((content) => {
      const events = CalendarService.parseIcs(content);
      events.forEach((event) => {
        if (!seenUids.has(event.uid)) {
          seenUids.add(event.uid);
          allEvents.push(event);
        }
      });
    });

    allEvents.sort((a, b) => a.start.localeCompare(b.start));
    return allEvents;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Texte d'une propriété iCalendar. node-ical renvoie la chaîne seule, ou
   * `{ params, val }` dès que la propriété porte un paramètre : Outlook et
   * Exchange écrivent `SUMMARY;LANGUAGE=fr-FR:...`, ce qui donnait un objet
   * à la place du titre. Le type `ParameterValue` de node-ical 0.27 l'expose.
   */
  private static paramText(value: unknown): string | undefined {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object' && 'val' in value) {
      const { val } = value;
      return typeof val === 'string' ? val : undefined;
    }
    return undefined;
  }

  private static parseOrganizer(organizer: unknown): EmailAddress | undefined {
    if (!organizer) return undefined;

    if (typeof organizer === 'string') {
      const email = organizer.replace(/^mailto:/i, '');
      return { address: email };
    }

    const org = organizer as Record<string, unknown>;
    const val = (org.val as string | undefined) ?? '';
    const email = val.replace(/^mailto:/i, '');
    return {
      name: (org.params as Record<string, unknown>)?.CN as string | undefined,
      address: email,
    };
  }

  private static parseAttendees(attendees: unknown): EmailAddress[] {
    if (!attendees) return [];

    const list = Array.isArray(attendees) ? attendees : [attendees];
    return list
      .map((att) => {
        if (typeof att === 'string') {
          return { address: att.replace(/^mailto:/i, '') };
        }
        const a = att as Record<string, unknown>;
        const val = (a.val as string | undefined) ?? '';
        const email = val.replace(/^mailto:/i, '');
        return {
          name: (a.params as Record<string, unknown>)?.CN as string | undefined,
          address: email,
        };
      })
      .filter((a) => a.address);
  }

  private static normalizeStatus(
    status: string | undefined,
  ): 'TENTATIVE' | 'CONFIRMED' | 'CANCELLED' {
    const upper = (status ?? 'CONFIRMED').toUpperCase();
    if (upper === 'TENTATIVE') return 'TENTATIVE';
    if (upper === 'CANCELLED') return 'CANCELLED';
    return 'CONFIRMED';
  }
}
