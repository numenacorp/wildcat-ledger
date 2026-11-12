import { Knex } from 'knex';
import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { ServiceError } from '@/modules/Items/ServiceError';
import { TransactionsLockingService } from '@/modules/TransactionsLocking/commands/CommandTransactionsLockingService';
import { TransactionsLockingGroup } from '@/modules/TransactionsLocking/types/TransactionsLocking.types';
import { ERRORS as LOCKING_ERRORS } from '@/modules/TransactionsLocking/constants';
import { ExtUnitOfWork } from '../common/ExtUnitOfWork.service';
import { ExtSettingsService } from '../common/ExtSettings.service';
import { ExtServiceLocator } from '../common/ExtServiceLocator.service';
import { previousDay, toInstant, toLocalDay } from '../common/timestamps';
import { LedgerWorkspacesService } from '../Workspaces/LedgerWorkspaces.service';

const CLOSING_AT = 'closing_at';
const SETTINGS_TABLE = 'ext_settings';
const LOCK_REASON = 'Books closed';

/**
 * The closing instant of the books.
 *
 * Everything dated before the closing instant is locked; a document at that
 * instant or after is open. Bigcapital locks by calendar day, so the
 * extension checks the exact instant itself on its own routes, and also sets
 * Bigcapital's lock through the day before the closing day, which guards
 * every other way into the books.
 */
@Injectable()
export class ExtLockService {
  /** The closing instant each open transaction holds, read once for it. */
  private readonly held = new WeakMap<object, string | null>();

  constructor(
    private readonly cls: ClsService,
    private readonly uow: ExtUnitOfWork,
    private readonly settings: ExtSettingsService,
    private readonly locator: ExtServiceLocator,
    private readonly workspaces: LedgerWorkspacesService,
  ) {}

  public async getClosingAt(trx?: Knex.Transaction): Promise<string | null> {
    return this.settings.get<string>(CLOSING_AT, trx);
  }

  /**
   * Sets the closing instant, or clears the lock with null.
   */
  public async setClosingAt(closingAt: string | null): Promise<string | null> {
    const locking = await this.locator.resolve(TransactionsLockingService);
    const instant = closingAt === null ? null : toInstant(closingAt);

    if (instant === null) {
      await locking.cancelTransactionLocking(TransactionsLockingGroup.All, {
        reason: LOCK_REASON,
      } as any);
    } else {
      const lockToDate = previousDay(
        toLocalDay(instant, await this.timezone()),
      );

      await locking.commandTransactionsLocking(TransactionsLockingGroup.All, {
        module: TransactionsLockingGroup.All,
        lockToDate,
        reason: LOCK_REASON,
      } as any);
    }
    // The row is kept when the lock is cleared, holding a null, so that
    // writes always have a row to hold against the next change (see
    // `heldClosingAt`). Writing it waits for every write that holds it.
    await this.uow.withTransaction(async (trx) => {
      await trx(SETTINGS_TABLE)
        .insert({ key: CLOSING_AT, value: JSON.stringify(instant) })
        .onConflict('key')
        .merge();
    });
    return instant;
  }

  /**
   * Refuses when any of the given instants falls before the closing instant.
   * @throws {ServiceError} TRANSACTIONS_DATE_LOCKED
   */
  public async assertOpen(
    instants: Array<string | null | undefined>,
    trx?: Knex.Transaction,
  ): Promise<void> {
    const closingAt = trx
      ? await this.heldClosingAt(trx)
      : await this.getClosingAt();
    if (!closingAt) return;

    const locked = instants.find((instant) => instant && instant < closingAt);
    if (locked) {
      throw new ServiceError(
        LOCKING_ERRORS.TRANSACTIONS_DATE_LOCKED,
        'The transaction is dated in a period that has been closed.',
        { closingAt, postedAt: locked },
      );
    }
  }

  /**
   * The closing instant, read so that it cannot change before the
   * transaction ends: the setting's row is held with a shared lock, which a
   * change of the closing instant waits for. Without this a write could pass
   * the check, the books close over its date, and the write then commit.
   */
  private async heldClosingAt(trx: Knex.Transaction): Promise<string | null> {
    if (this.held.has(trx)) return this.held.get(trx);

    const read = () =>
      trx(SETTINGS_TABLE).where({ key: CLOSING_AT }).forShare().first();
    let row = await read();

    if (!row) {
      // No row to hold yet: one is made, holding no closing instant.
      await trx(SETTINGS_TABLE)
        .insert({ key: CLOSING_AT, value: JSON.stringify(null) })
        .onConflict('key')
        .ignore();
      row = await read();
    }
    const closingAt = row ? (JSON.parse(row.value) as string | null) : null;

    this.held.set(trx, closingAt);
    return closingAt;
  }

  public async timezone(): Promise<string> {
    const workspace = await this.workspaces.findByOrganization(
      this.cls.get('organizationId'),
    );
    return workspace?.timezone || 'UTC';
  }
}
