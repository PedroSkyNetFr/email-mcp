/**
 * Tests d'intégration : export `.eml` (save_email / save_emails_from_search) et
 * en-têtes Internet complets (get_email_headers).
 *
 * Ces deux fonctions ne se valident pas hors ligne : ce qui compte, c'est que
 * la source rendue par le serveur soit écrite VERBATIM, et que le bloc
 * d'en-têtes obtenu par `BODY.PEEK[HEADER]` se déplie et s'analyse comme
 * attendu. On sème donc de vrais messages via GreenMail et on les relit par la
 * couche service (les outils MCP en sont des enveloppes minces).
 */

/* eslint-disable n/no-sync -- tests use sync fs helpers for setup/teardown */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TestServices } from './helpers/index.js';
import {
  buildTestAccount,
  createTestServices,
  seedEmail,
  seedEmails,
  seedEmailWithAttachment,
  TEST_ACCOUNT_NAME,
  waitForDelivery,
} from './helpers/index.js';

describe('.eml export + Internet headers', () => {
  let services: TestServices;
  let workDir: string;

  beforeAll(() => {
    services = createTestServices(buildTestAccount());
  });

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'eml-export-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await services.connections.closeAll();
  });

  /** Sème un message et retourne l'UID que le serveur lui a attribué. */
  async function seedAndLocate(subject: string): Promise<string> {
    await seedEmail({ subject, text: 'Corps du message de test.' });
    await waitForDelivery();
    const list = await services.imapService.listEmails(TEST_ACCOUNT_NAME, { subject });
    expect(list.items.length).toBeGreaterThanOrEqual(1);
    return list.items[0].id;
  }

  // -------------------------------------------------------------------------
  // getEmailRaw / saveEmailToDisk
  // -------------------------------------------------------------------------
  describe('saveEmailToDisk', () => {
    it('écrit un .eml dont les octets sont ceux du serveur', async () => {
      const subject = `eml-save-${Date.now()}`;
      const emailId = await seedAndLocate(subject);

      const result = await services.imapService.saveEmailToDisk(
        TEST_ACCOUNT_NAME,
        emailId,
        'INBOX',
        workDir,
      );

      expect(result.path.endsWith('.eml')).toBe(true);
      expect(result.size).toBeGreaterThan(0);

      const onDisk = readFileSync(result.path);
      expect(onDisk.length).toBe(result.size);
      // Un .eml commence par le bloc d'en-têtes, pas par du MIME décodé.
      const asText = onDisk.toString('utf-8');
      expect(asText).toContain(`Subject: ${subject}`);
      expect(asText).toContain('Corps du message de test.');

      // Comparaison directe avec la source telle que la retourne le serveur :
      // c'est la garantie « verbatim » qui fait tout l'intérêt du format.
      const source = await services.imapService.getEmailRaw(TEST_ACCOUNT_NAME, emailId, 'INBOX');
      expect(onDisk.equals(source)).toBe(true);
    });

    it('nomme le fichier à partir de la date et du sujet quand la cible est un dossier', async () => {
      const subject = `eml-nom-${Date.now()}`;
      const emailId = await seedAndLocate(subject);

      const result = await services.imapService.saveEmailToDisk(
        TEST_ACCOUNT_NAME,
        emailId,
        'INBOX',
        workDir,
      );

      const name = result.path.slice(workDir.length + 1);
      expect(name).toMatch(/^\d{4}-\d{2}-\d{2}_/);
      expect(name).toContain(subject);
      expect(name.endsWith(`_${emailId}.eml`)).toBe(true);
    });

    it('conserve les pièces jointes, ce qu’un export de métadonnées ne peut pas faire', async () => {
      const subject = `eml-pj-${Date.now()}`;
      await seedEmailWithAttachment(
        'facture.pdf',
        Buffer.from('%PDF-1.4 test').toString('base64'),
        {
          subject,
        },
      );
      await waitForDelivery();
      const list = await services.imapService.listEmails(TEST_ACCOUNT_NAME, { subject });
      const emailId = list.items[0].id;

      const result = await services.imapService.saveEmailToDisk(
        TEST_ACCOUNT_NAME,
        emailId,
        'INBOX',
        workDir,
      );

      const asText = readFileSync(result.path, 'utf-8');
      expect(asText).toContain('facture.pdf');
      expect(asText.toLowerCase()).toContain('content-disposition: attachment');
    });

    it('ne remplace pas un fichier existant sans y être autorisé', async () => {
      const subject = `eml-collision-${Date.now()}`;
      const emailId = await seedAndLocate(subject);

      const first = await services.imapService.saveEmailToDisk(
        TEST_ACCOUNT_NAME,
        emailId,
        'INBOX',
        workDir,
      );
      const second = await services.imapService.saveEmailToDisk(
        TEST_ACCOUNT_NAME,
        emailId,
        'INBOX',
        workDir,
      );

      expect(second.path).not.toBe(first.path);
      expect(second.path).toContain('-1.eml');
      expect(readdirSync(workDir)).toHaveLength(2);
    });

    it('refuse une destination hors des répertoires autorisés', async () => {
      const subject = `eml-garde-${Date.now()}`;
      const emailId = await seedAndLocate(subject);

      await expect(
        services.imapService.saveEmailToDisk(
          TEST_ACCOUNT_NAME,
          emailId,
          'INBOX',
          'relative/path.eml',
        ),
      ).rejects.toThrow(/absolute path/i);
    });
  });

  // -------------------------------------------------------------------------
  // saveEmailsFromSearch
  // -------------------------------------------------------------------------
  describe('saveEmailsFromSearch', () => {
    it('écrit un .eml par message trouvé', async () => {
      const subject = `eml-lot-${Date.now()}`;
      await seedEmails(3, { subject });
      await waitForDelivery();

      const result = await services.imapService.saveEmailsFromSearch({
        accountNames: null,
        accountName: TEST_ACCOUNT_NAME,
        query: '',
        searchOptions: { mailbox: 'INBOX', subject },
        maxEmails: 100,
        destinationFolder: join(workDir, 'lot'),
        organizeBy: 'flat',
      });

      expect(result.errors).toEqual([]);
      expect(result.files_saved).toBeGreaterThanOrEqual(3);
      expect(result.total_size).toBeGreaterThan(0);
      expect(readdirSync(join(workDir, 'lot')).every((f) => f.endsWith('.eml'))).toBe(true);
    });

    it('range par mois quand organize_by=date', async () => {
      const subject = `eml-lot-date-${Date.now()}`;
      await seedEmails(2, { subject });
      await waitForDelivery();

      const folder = join(workDir, 'par-date');
      const result = await services.imapService.saveEmailsFromSearch({
        accountNames: null,
        accountName: TEST_ACCOUNT_NAME,
        query: '',
        searchOptions: { mailbox: 'INBOX', subject },
        maxEmails: 100,
        destinationFolder: folder,
        organizeBy: 'date',
      });

      expect(result.files_saved).toBeGreaterThanOrEqual(2);
      const buckets = readdirSync(folder);
      expect(buckets).toHaveLength(1);
      expect(buckets[0]).toMatch(/^\d{4}-\d{2}$/);
    });
  });

  // -------------------------------------------------------------------------
  // getEmailHeaders
  // -------------------------------------------------------------------------
  describe('getEmailHeaders', () => {
    it('rend le bloc d’en-têtes et les en-têtes décodés', async () => {
      const subject = `hdr-${Date.now()}`;
      const emailId = await seedAndLocate(subject);

      const dump = await services.imapService.getEmailHeaders(TEST_ACCOUNT_NAME, emailId, 'INBOX');

      expect(dump.account).toBe(TEST_ACCOUNT_NAME);
      expect(dump.emailId).toBe(emailId);
      expect(dump.entries.length).toBeGreaterThan(3);
      expect(dump.grouped.subject?.[0]).toBe(subject);
      expect(dump.grouped.from?.[0]).toContain('sender@localhost');
      // Le bloc brut s'arrête aux en-têtes : le corps ne doit pas y figurer.
      expect(dump.raw).toContain('Subject:');
      expect(dump.raw).not.toContain('Corps du message de test.');
    });

    it('conserve la chaîne Received complète et la rend chronologique', async () => {
      const subject = `hdr-received-${Date.now()}`;
      const emailId = await seedAndLocate(subject);

      const dump = await services.imapService.getEmailHeaders(TEST_ACCOUNT_NAME, emailId, 'INBOX');

      // GreenMail ajoute au moins un Received à la remise.
      expect(dump.analysis.received.length).toBeGreaterThanOrEqual(1);
      expect(dump.grouped.received?.length).toBe(dump.analysis.received.length);
      dump.analysis.received.forEach((hop, index) => {
        expect(hop.index).toBe(index);
        expect(hop.raw.length).toBeGreaterThan(0);
      });
    });

    it('ne marque pas le message comme lu (BODY.PEEK)', async () => {
      const subject = `hdr-peek-${Date.now()}`;
      const emailId = await seedAndLocate(subject);

      const before = await services.imapService.getEmailFlags(TEST_ACCOUNT_NAME, emailId, 'INBOX');
      await services.imapService.getEmailHeaders(TEST_ACCOUNT_NAME, emailId, 'INBOX');
      const after = await services.imapService.getEmailFlags(TEST_ACCOUNT_NAME, emailId, 'INBOX');

      expect(after.seen).toBe(before.seen);
    });

    it('échoue explicitement sur un identifiant inconnu', async () => {
      await expect(
        services.imapService.getEmailHeaders(TEST_ACCOUNT_NAME, '999999', 'INBOX'),
      ).rejects.toThrow(/not found/i);
    });
  });
});
