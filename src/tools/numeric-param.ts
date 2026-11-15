/**
 * Paramètres numériques tolérants aux chaînes.
 *
 * Beaucoup de clients MCP sérialisent chaque argument en chaîne : un
 * `z.number()` nu refuse alors `"20"` et l'outil échoue avant même que son
 * gestionnaire ne s'exécute, sans que l'appelant comprenne pourquoi
 * (codefuturist #28). `numeric()` accepte la chaîne d'un nombre décimal
 * (« 20 », « -3 », « 1.5 », espaces autour tolérés) et la convertit, puis
 * applique le schéma d'origine — bornes `min`/`max`/`int` comprises.
 *
 * Volontairement plus strict que `z.coerce.number()`, qui transforme `""` et
 * `null` en 0 et `true` en 1 : une valeur vide ou booléenne passée pour un
 * nombre est une erreur de l'appelant, on la refuse au lieu d'inventer 0.
 *
 * Le schéma JSON publié aux clients reste celui du nombre (`type: integer`,
 * bornes) : la conversion n'est qu'une tolérance à l'entrée.
 */

import { z } from 'zod';

/** Chaîne décimale complète : signe optionnel, partie entière, décimales. */
const NUMERIC_STRING = /^\s*[-+]?(?:\d+\.?\d*|\.\d+)\s*$/;

/** Convertit une chaîne numérique en nombre ; laisse toute autre valeur intacte. */
export function coerceNumericString(value: unknown): unknown {
  if (typeof value === 'string' && NUMERIC_STRING.test(value)) {
    return Number(value);
  }
  return value;
}

/**
 * Enveloppe un schéma numérique pour qu'il accepte aussi la chaîne du nombre.
 * Usage : `numeric(z.number().int().min(1).default(1))` — défaut et `optional()`
 * DANS le schéma enveloppé, pour que le schéma JSON publié garde `default`.
 */
export function numeric<T extends z.ZodType>(schema: T): z.ZodPreprocess<T> {
  return z.preprocess(coerceNumericString, schema);
}
