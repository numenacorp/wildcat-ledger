/**
 * Resolves the character set of the database connections and of newly created
 * organization databases. Only the two UTF-8 sets are accepted, since the
 * value is written into `CREATE DATABASE`.
 */
const COLLATIONS = {
  utf8mb4: 'utf8mb4_unicode_ci',
  utf8: 'utf8_general_ci',
} as const;

export type DatabaseCharset = keyof typeof COLLATIONS;

export const DEFAULT_DATABASE_CHARSET: DatabaseCharset = 'utf8mb4';

export function resolveDatabaseCharset(
  ...candidates: Array<string | undefined>
): DatabaseCharset {
  const value = candidates.find((candidate) => candidate && candidate.trim());
  if (!value) return DEFAULT_DATABASE_CHARSET;

  const charset = value.trim().toLowerCase();
  if (!(charset in COLLATIONS)) {
    throw new Error(
      `Unsupported database charset "${value}". Use utf8mb4 or utf8.`,
    );
  }
  return charset as DatabaseCharset;
}

export const collationOf = (charset: DatabaseCharset): string =>
  COLLATIONS[charset];
