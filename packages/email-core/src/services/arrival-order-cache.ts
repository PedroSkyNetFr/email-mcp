/**
 * Cache borné de l'ordre « par date de réception » des candidats d'une liste.
 *
 * `orderForPaging` lit l'INTERNALDATE de TOUS les candidats avant de servir une
 * page (jusqu'à 20 000 messages, ~1,3 Mo et ~0,2 s d'analyse). Sans cache,
 * feuilleter les pages 2, 3, 4… d'une même liste relisait ces dates à chaque
 * page alors que rien n'avait changé. On garde donc l'ordre calculé, tant que
 * le dossier et la recherche sont identiques.
 *
 * Clé : compte + dossier + UIDVALIDITY + UIDNEXT + nombre de messages +
 * critères de recherche. Un message arrivé (UIDNEXT, nombre), supprimé
 * (nombre) ou une renumérotation du dossier (UIDVALIDITY) change la clé, et
 * les entrées périmées du même dossier sont retirées aussitôt. Un changement
 * que la clé ne voit pas (drapeau modifié qui fait entrer ou sortir un message
 * d'une recherche `seen:false`) est rattrapé par la comparaison de l'ensemble
 * des UID : le SEARCH est refait à chaque appel, et l'ordre en cache ne sert
 * que s'il porte exactement sur les mêmes UID.
 *
 * Taille : LRU de quelques entrées — de quoi feuilleter quelques listes en
 * parallèle sans garder en mémoire des dizaines de tableaux de 20 000 entrées.
 */

/** Un candidat ordonné : UID et INTERNALDATE (ms). */
export interface OrderedCandidate {
  uid: number;
  arrival: number;
}

/** État du dossier sélectionné, tel qu'imapflow l'expose après SELECT. */
export interface MailboxState {
  uidValidity?: bigint | number | string;
  uidNext?: number;
  exists?: number;
}

/** Référence d'une entrée : clé complète, dossier et état du dossier. */
export interface ArrivalCacheRef {
  key: string;
  /** Compte + dossier, pour retirer les entrées périmées du même dossier. */
  folder: string;
  /** UIDVALIDITY + UIDNEXT + nombre de messages. */
  state: string;
}

interface Entry {
  folder: string;
  state: string;
  ordered: OrderedCandidate[];
}

export const ARRIVAL_CACHE_SIZE = 8;

/** Séparateur des composantes de la clé (absent des noms de compte et de dossier). */
const SEP = '\u0000';

/** Sérialise des critères de recherche (Date, bigint, tableaux) de façon stable. */
function criteriaKey(criteria: unknown): string {
  return JSON.stringify(criteria, (_key, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
}

export class ArrivalOrderCache {
  private entries = new Map<string, Entry>();

  constructor(private readonly maxEntries = ARRIVAL_CACHE_SIZE) {}

  /**
   * Référence de cache, ou `undefined` si l'état du dossier est inconnu (pas
   * de SELECT, client simulé…) : dans ce cas rien n'est mis en cache.
   */
  static keyFor(
    account: string,
    mailbox: string,
    state: MailboxState | false | undefined,
    criteria: unknown,
  ): ArrivalCacheRef | undefined {
    if (!state || state.uidValidity === undefined || state.uidNext === undefined) {
      return undefined;
    }
    const folder = [account, mailbox].join(SEP);
    const status = [
      String(state.uidValidity),
      String(state.uidNext),
      String(state.exists ?? ''),
    ].join(SEP);
    return { key: [folder, status, criteriaKey(criteria)].join(SEP), folder, state: status };
  }

  /** Ordre en cache pour exactement ces UID, sinon `undefined`. */
  get(ref: ArrivalCacheRef, uids: number[]): OrderedCandidate[] | undefined {
    const entry = this.entries.get(ref.key);
    if (!entry) return undefined;
    const cached = new Set(entry.ordered.map((c) => c.uid));
    if (entry.ordered.length !== uids.length || !uids.every((uid) => cached.has(uid))) {
      this.entries.delete(ref.key);
      return undefined;
    }
    // LRU : l'entrée lue redevient la plus récente.
    this.entries.delete(ref.key);
    this.entries.set(ref.key, entry);
    return entry.ordered;
  }

  set(ref: ArrivalCacheRef, ordered: OrderedCandidate[]): void {
    // Les entrées du même dossier sous un autre état (UIDNEXT, nombre,
    // UIDVALIDITY) sont périmées : on les retire, quels que soient les critères.
    [...this.entries].forEach(([k, entry]) => {
      if (entry.folder === ref.folder && entry.state !== ref.state) this.entries.delete(k);
    });
    this.entries.delete(ref.key);
    this.entries.set(ref.key, { folder: ref.folder, state: ref.state, ordered });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }

  /** Nombre d'entrées (tests). */
  get size(): number {
    return this.entries.size;
  }
}
