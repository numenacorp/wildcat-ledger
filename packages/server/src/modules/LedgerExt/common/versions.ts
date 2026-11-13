import { Knex } from 'knex';
import { HttpStatus } from '@nestjs/common';
import { ServiceError } from '@/modules/Items/ServiceError';
import { camelToSnake } from '@/common/interceptors/serialize.interceptor';
import { withOpaqueKeys } from '@/common/decorators/OpaqueKeys';

/**
 * The version of a record: a counter that every change raises.
 *
 * A change says which version it was made from. It is checked and raised in
 * one statement, so of two changes made from the same version exactly one
 * lands, and a change made from a copy that has since moved on is refused
 * and answered with the record as it stands.
 */
export const VERSION_ERRORS = {
  VERSION_REQUIRED: 'VERSION_REQUIRED',
  STALE_VERSION: 'STALE_VERSION',
};

/** Raised inside a transaction when the version a change names is not the record's. */
export class StaleVersion extends Error {}

/**
 * The version a change names.
 * @throws {ServiceError} VERSION_REQUIRED
 */
export function requireVersion(value: unknown): number {
  const version = typeof value === 'string' ? Number(value) : value;

  if (
    typeof version !== 'number' ||
    !Number.isInteger(version) ||
    version < 1
  ) {
    throw new ServiceError(
      VERSION_ERRORS.VERSION_REQUIRED,
      'A change names the version of the record it was made from.',
    );
  }
  return version;
}

/**
 * Raises the version of the rows matched. With a version expected, only a
 * row at that version is raised.
 * @throws {StaleVersion} A version was expected and no row is at it.
 */
export async function raiseVersion(
  trx: Knex.Transaction,
  table: string,
  where: Record<string, unknown>,
  expected?: number,
): Promise<void> {
  const query = trx(table).where(where);
  if (expected !== undefined) query.where({ version: expected });

  const changed = await query.increment('version', 1);
  if (expected !== undefined && Number(changed) === 0) throw new StaleVersion();
}

/**
 * Runs a change, answering a stale version with the record as it stands.
 * @throws {ServiceError} STALE_VERSION
 */
export async function refusingStale<T>(
  run: () => Promise<T>,
  current: () => Promise<unknown>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof StaleVersion)) throw error;

    throw new ServiceError(
      VERSION_ERRORS.STALE_VERSION,
      'The record has changed since it was read. Read it again and make the change on what it is now.',
      // Written as a route answers it, since an error's payload is sent as it
      // is: keys in snake case, and metadata, whose keys are the caller's
      // own, left exactly as it was stored.
      { current: withOpaqueKeys(await current(), ['metadata'], camelToSnake) },
      HttpStatus.CONFLICT,
    );
  }
}
