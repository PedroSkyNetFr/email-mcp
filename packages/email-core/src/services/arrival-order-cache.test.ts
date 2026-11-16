/**
 * Cache de l'ordre par date de réception : clé, invalidation et borne LRU.
 */

import { ArrivalOrderCache } from './arrival-order-cache.js';

const state = { uidValidity: BigInt(1), uidNext: 11, exists: 10 };
const ordered = [
  { uid: 2, arrival: 200 },
  { uid: 1, arrival: 100 },
];

describe('ArrivalOrderCache', () => {
  it('serves the order back for the same folder state, criteria and UID set', () => {
    const cache = new ArrivalOrderCache();
    const ref = ArrivalOrderCache.keyFor('perso', 'INBOX', state, { seen: false });
    if (!ref) throw new Error('ref expected');
    cache.set(ref, ordered);

    expect(cache.get(ref, [1, 2])).toBe(ordered);
  });

  it('misses when the UID set differs (a flag change moved a message in or out)', () => {
    const cache = new ArrivalOrderCache();
    const ref = ArrivalOrderCache.keyFor('perso', 'INBOX', state, { seen: false });
    if (!ref) throw new Error('ref expected');
    cache.set(ref, ordered);

    expect(cache.get(ref, [1, 3])).toBeUndefined();
    expect(cache.get(ref, [1])).toBeUndefined();
  });

  it('keys on account, folder, UIDVALIDITY, UIDNEXT, message count and criteria', () => {
    const base = ArrivalOrderCache.keyFor('perso', 'INBOX', state, { seen: false })?.key;
    const variants = [
      ArrivalOrderCache.keyFor('pro', 'INBOX', state, { seen: false }),
      ArrivalOrderCache.keyFor('perso', 'Archive', state, { seen: false }),
      ArrivalOrderCache.keyFor(
        'perso',
        'INBOX',
        { ...state, uidValidity: BigInt(2) },
        { seen: false },
      ),
      ArrivalOrderCache.keyFor('perso', 'INBOX', { ...state, uidNext: 12 }, { seen: false }),
      ArrivalOrderCache.keyFor('perso', 'INBOX', { ...state, exists: 9 }, { seen: false }),
      ArrivalOrderCache.keyFor('perso', 'INBOX', state, { seen: true }),
      ArrivalOrderCache.keyFor('perso', 'INBOX', state, { since: new Date(0) }),
    ].map((r) => r?.key);
    variants.forEach((key) => {
      expect(key).not.toBe(base);
    });
    expect(new Set(variants).size).toBe(variants.length);
  });

  it('drops the stale entries of a folder as soon as its state changes', () => {
    const cache = new ArrivalOrderCache();
    const before = ArrivalOrderCache.keyFor('perso', 'INBOX', state, {});
    const other = ArrivalOrderCache.keyFor('perso', 'INBOX', state, { seen: false });
    const after = ArrivalOrderCache.keyFor('perso', 'INBOX', { ...state, uidNext: 12 }, {});
    if (!before || !other || !after) throw new Error('refs expected');
    cache.set(before, ordered);
    cache.set(other, ordered);
    expect(cache.size).toBe(2);

    cache.set(after, ordered);

    expect(cache.size).toBe(1);
    expect(cache.get(before, [1, 2])).toBeUndefined();
    expect(cache.get(other, [1, 2])).toBeUndefined();
  });

  it('caches nothing without a known folder state', () => {
    expect(ArrivalOrderCache.keyFor('perso', 'INBOX', undefined, {})).toBeUndefined();
    expect(ArrivalOrderCache.keyFor('perso', 'INBOX', false, {})).toBeUndefined();
    expect(ArrivalOrderCache.keyFor('perso', 'INBOX', { exists: 5 }, {})).toBeUndefined();
  });

  it('is bounded: the least recently used entry is evicted first', () => {
    const cache = new ArrivalOrderCache(2);
    const refs = ['A', 'B', 'C'].map((folder) => {
      const ref = ArrivalOrderCache.keyFor('perso', folder, state, {});
      if (!ref) throw new Error('ref expected');
      return ref;
    });
    cache.set(refs[0], ordered);
    cache.set(refs[1], ordered);
    // A relu : B devient le moins récent.
    expect(cache.get(refs[0], [1, 2])).toBeDefined();
    cache.set(refs[2], ordered);

    expect(cache.size).toBe(2);
    expect(cache.get(refs[1], [1, 2])).toBeUndefined();
    expect(cache.get(refs[0], [1, 2])).toBeDefined();
    expect(cache.get(refs[2], [1, 2])).toBeDefined();
  });
});
