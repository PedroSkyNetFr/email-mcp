/**
 * Les clients MCP envoient souvent chaque argument en chaîne : un
 * `z.number()` nu refuse `"20"` et l'outil échoue avant son gestionnaire
 * (codefuturist #28, d313dc6).
 *
 * Le test parcourt le schéma réel de CHAQUE outil enregistré par les
 * registrars de `register.ts` — pas une sélection — et vérifie la propriété
 * plutôt que le texte source : un champ qui accepte le nombre 5 doit accepter
 * la chaîne "5" (scalaire ou tableau de nombres). Un outil ajouté plus tard
 * est couvert d'office.
 */

import { z } from 'zod';

import registerAccountsTools from './accounts.tool.js';
import registerAnalyticsTools from './analytics.tool.js';
import registerAttachmentTools from './attachments.tool.js';
import registerBulkTools from './bulk.tool.js';
import registerCalendarTools from './calendar.tool.js';
import registerContactsTools from './contacts.tool.js';
import registerCrossAccountMoveTool from './cross-account-move.tool.js';
import registerDraftTools from './drafts.tool.js';
import registerEmailsTools from './emails.tool.js';
import registerEmlTools from './eml.tool.js';
import registerExchangeTools from './exchange.tool.js';
import registerExportTools from './export.tool.js';
import registerFolderTools from './folders.tool.js';
import registerHeaderTools from './headers.tool.js';
import registerHealthTools from './health.tool.js';
import registerLabelTools from './label.tool.js';
import registerLocateTools from './locate.tool.js';
import registerMailboxesTools from './mailboxes.tool.js';
import registerManageTools from './manage.tool.js';
import { coerceNumericString, numeric } from './numeric-param.js';
import registerSavedSearchesTools from './saved-searches.tool.js';
import registerSchedulerTools from './scheduler.tool.js';
import registerSendTools from './send.tool.js';
import { registerTemplateReadTools, registerTemplateWriteTools } from './templates.tool.js';
import registerThreadTools from './thread.tool.js';
import registerWatcherTools, { registerWatcherWriteTools } from './watcher.tool.js';

type Shape = Record<string, z.ZodType>;

/** Service factice : toute propriété est elle-même appelable et chaînable. */
function fakeService(): never {
  const target = () => fakeService();
  return new Proxy(target, {
    get: (_t, prop) => {
      // Interpolation dans une description : rendre une primitive.
      if (prop === Symbol.toPrimitive) return () => 25;
      return fakeService();
    },
  }) as never;
}

/** Capture la forme d'entrée de chaque `server.registerTool(nom, { inputSchema: z.object(forme) }, …)`. */
function collectShapes(): Map<string, Shape> {
  const shapes = new Map<string, Shape>();
  const server = {
    registerTool: (name: string, config: { inputSchema?: unknown }) => {
      // SDK v2 : le schéma d'entrée est un `z.object(...)` ; sa forme porte les champs.
      if (config.inputSchema instanceof z.ZodObject) {
        const shape: Shape = config.inputSchema.shape;
        if (Object.keys(shape).length > 0) shapes.set(name, shape);
      }
    },
  };
  const f = fakeService;
  const registrars: (() => void)[] = [
    () => registerAccountsTools(server as never, f()),
    () => registerMailboxesTools(server as never, f()),
    () => registerEmailsTools(server as never, f(), f()),
    () => registerAttachmentTools(server as never, f(), f()),
    () => registerExportTools(server as never, f(), f()),
    () => registerEmlTools(server as never, f(), f()),
    () => registerHeaderTools(server as never, f()),
    () => registerContactsTools(server as never, f()),
    () => registerThreadTools(server as never, f()),
    () => registerTemplateReadTools(server as never, f()),
    () => registerCalendarTools(server as never, f(), f(), f(), f()),
    () => registerAnalyticsTools(server as never, f()),
    () => registerHealthTools(server as never, f(), f()),
    () => registerLocateTools(server as never, f()),
    () => registerWatcherTools(server as never, f(), f(), f()),
    () => registerSavedSearchesTools(server as never, f(), f(), f()),
    () => registerSendTools(server as never, f(), f()),
    () => registerManageTools(server as never, f()),
    () => registerLabelTools(server as never, f()),
    () => registerBulkTools(server as never, f()),
    () => registerDraftTools(server as never, f(), f()),
    () => registerCrossAccountMoveTool(server as never, f(), f()),
    () => registerExchangeTools(server as never, f(), f()),
    () => registerFolderTools(server as never, f()),
    () => registerTemplateWriteTools(server as never, f(), f(), f()),
    () => registerSchedulerTools(server as never, f()),
    () => registerWatcherWriteTools(server as never, f()),
  ];
  registrars.forEach((register) => {
    register();
  });
  return shapes;
}

describe('numeric()', () => {
  const page = numeric(z.number().int().min(1).default(1));

  it('accepts numeric strings and applies the wrapped bounds', () => {
    expect(page.parse('3')).toBe(3);
    expect(page.parse(' 7 ')).toBe(7);
    expect(page.parse(4)).toBe(4);
    expect(page.parse(undefined)).toBe(1);
    expect(page.safeParse('0').success).toBe(false);
    expect(page.safeParse('1.5').success).toBe(false);
    expect(numeric(z.number()).parse('-2.5')).toBe(-2.5);
  });

  it('is stricter than z.coerce: "", null, true and "12abc" are refused, not turned into numbers', () => {
    const n = numeric(z.number());
    ['', '  ', null, true, false, '12abc', '0x10', 'NaN'].forEach((value) => {
      expect(n.safeParse(value).success).toBe(false);
    });
    expect(coerceNumericString('')).toBe('');
    expect(coerceNumericString(true)).toBe(true);
  });

  it('keeps the published JSON Schema a number, with its default and description', () => {
    const shape = z.object({ page: page.describe('Page number') });
    const schema = z.toJSONSchema(shape, { io: 'input' }) as unknown as {
      properties: { page: Record<string, unknown> };
      required?: string[];
    };
    expect(schema.properties.page).toMatchObject({
      type: 'integer',
      minimum: 1,
      default: 1,
      description: 'Page number',
    });
    expect(schema.required ?? []).not.toContain('page');
  });
});

describe('numeric tool parameters accept strings (every registered tool)', () => {
  const shapes = collectShapes();
  const fields = [...shapes.entries()].flatMap(([tool, shape]) =>
    Object.entries(shape).map(([field, schema]) => ({ tool, field, schema })),
  );

  it('finds tools to check, so a broken harness cannot pass vacuously', () => {
    expect(shapes.size).toBeGreaterThan(50);
    expect(fields.length).toBeGreaterThan(300);
  });

  it('a field that accepts 5 also accepts "5" (scalar or array)', () => {
    const offenders = fields
      .map(({ tool, field, schema }) => {
        if (schema.safeParse(5).success) {
          return schema.safeParse('5').success ? null : `${tool}.${field}`;
        }
        if (schema.safeParse([5]).success) {
          return schema.safeParse(['5']).success ? null : `${tool}.${field}`;
        }
        return null;
      })
      .filter((o): o is string => o !== null);
    expect(offenders).toEqual([]);
  });

  it('the coerced value is a real number (list_emails.page, get_email.maxLength)', () => {
    expect(shapes.get('list_emails')?.page.parse('2')).toBe(2);
    expect(shapes.get('get_email')?.maxLength.parse('0')).toBe(0);
    expect(shapes.get('search_emails')?.uids.parse(['4', '5'])).toEqual([4, 5]);
  });
});
