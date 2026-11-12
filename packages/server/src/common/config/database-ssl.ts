/**
 * Whether database connections use TLS. A managed database usually accepts
 * nothing else. With `DB_SSL=true` every connection is encrypted and the
 * server's certificate is checked against the system's certificate
 * authorities.
 */
export function resolveDatabaseSsl(
  ...candidates: Array<string | undefined>
): { rejectUnauthorized: true } | undefined {
  const value = candidates.find((candidate) => candidate && candidate.trim());

  return value && ['true', '1'].includes(value.trim().toLowerCase())
    ? { rejectUnauthorized: true }
    : undefined;
}
