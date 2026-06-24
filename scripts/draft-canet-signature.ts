#!/usr/bin/env tsx
/**
 * Helper clé-en-main : crée un BROUILLON HTML signé CANET CONSTRUCTION avec le
 * logo réellement embarqué en image inline « cid » (multipart/related), sans
 * avoir à recoller le HTML de la signature à chaque fois.
 *
 * Il réutilise toute l'infrastructure existante : loadConfig → ConnectionManager
 * → ImapService.saveDraftWithAttachments, en ajoutant simplement le logo comme
 * pièce inline { path, cid: 'logoCanet' }. Le corps optionnel est concaténé
 * AU-DESSUS de la signature (lue depuis templates/canet-signature.toml, source
 * unique de vérité — pas d'échappement HTML, contrairement à apply_template).
 *
 * Usage :
 *   tsx scripts/draft-canet-signature.ts \
 *     --account contact \
 *     --to contact@pierrecanet.fr \
 *     --subject "Test signature inline" \
 *     --logo /chemin/absolu/Logo-CC-v2-mail.png \
 *     --body "<p>Bonjour,</p><p>Ceci est un test.</p>"
 *
 * Options :
 *   --account <nom>   Compte configuré (défaut : 1er compte du config.toml)
 *   --to <adresse>    Destinataire (défaut : contact@pierrecanet.fr)
 *   --subject <texte> Objet (défaut : "Test signature inline CANET CONSTRUCTION")
 *   --logo <chemin>   Chemin ABSOLU du logo PNG. Omis → petit PNG de
 *                     remplacement, juste pour valider la chaîne technique.
 *   --body <html>     Corps HTML optionnel inséré avant la signature.
 *   --cid <id>        Content-ID du logo (défaut : logoCanet — doit matcher le
 *                     <img src="cid:..."> de la signature).
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseTOML } from 'smol-toml';

import { loadConfig } from '../src/config/loader.js';
import ConnectionManager from '../src/connections/manager.js';
import ImapService from '../src/services/imap.service.js';
import OAuthService from '../src/services/oauth.service.js';

// --- Analyse minimale des arguments --flag valeur --------------------------
function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      out[a.slice(2)] = argv[i + 1] ?? '';
      i += 1;
    }
  }
  return out;
}

// PNG 16x16 bleu (#86A7D2) — remplacement quand --logo n'est pas fourni.
const PLACEHOLDER_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAJklEQVR42mNgGAWj' +
  'YBSMglEwCkbBKBgFo2AUjIJRMApGwSgAAA4gAAGZqM2hAAAAAElFTkSuQmCC';

function resolveSignatureBody(): string {
  // Source unique : templates/canet-signature.toml à la racine du dépôt.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const tplPath = path.join(here, '..', 'templates', 'canet-signature.toml');
  const raw = parseTOML(readFileSync(tplPath, 'utf-8')) as { body?: unknown };
  if (typeof raw.body !== 'string') {
    throw new Error(`Template ${tplPath} invalide : champ "body" manquant`);
  }
  return raw.body;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const config = await loadConfig();
  const accountName = args.account ?? config.accounts[0]?.name;
  if (!accountName) {
    throw new Error('Aucun compte configuré. Lancez `email-mcp account add` au préalable.');
  }

  const to = args.to ?? 'contact@pierrecanet.fr';
  const subject = args.subject ?? 'Test signature inline CANET CONSTRUCTION';
  const cid = args.cid ?? 'logoCanet';

  // Logo : chemin fourni, sinon PNG de remplacement écrit dans un dossier temp.
  let logoPath = args.logo;
  if (!logoPath) {
    const tmp = mkdtempSync(path.join(tmpdir(), 'canet-logo-'));
    logoPath = path.join(tmp, 'logo-placeholder.png');
    writeFileSync(logoPath, Buffer.from(PLACEHOLDER_PNG_BASE64, 'base64'));
    // eslint-disable-next-line no-console
    console.warn(`[i] Aucun --logo fourni : PNG de remplacement utilisé (${logoPath}).`);
  }

  const intro = args.body ?? '<p>Bonjour,</p><p>Ceci est un brouillon de test.</p>';
  const html = `<!DOCTYPE html><html><body>${intro}<br>${resolveSignatureBody()}</body></html>`;

  const oauthService = new OAuthService();
  const connections = new ConnectionManager(config.accounts, oauthService);
  const imapService = new ImapService(connections);

  try {
    const result = await imapService.saveDraftWithAttachments(accountName, {
      to: [to],
      subject,
      body: html,
      html: true,
      // Logo embarqué INLINE (cid) + cohabitation possible avec des PJ classiques.
      attachments: [{ path: logoPath, filename: 'logo.png', cid }],
    });
    // eslint-disable-next-line no-console
    console.log(
      `✅ Brouillon créé : UID ${result.id} dans "${result.mailbox}" (compte ${accountName}).`,
    );
    // eslint-disable-next-line no-console
    console.log(
      `   Logo inline cid:${cid} — ouvrez le brouillon dans Outlook pour vérifier le rendu.`,
    );
  } finally {
    await connections.closeAll();
  }
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('❌ Échec :', err instanceof Error ? err.message : err);
  process.exit(1);
});
