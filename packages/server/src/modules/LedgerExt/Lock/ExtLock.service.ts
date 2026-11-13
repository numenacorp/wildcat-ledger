import { Knex } from 'knex';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { ServiceError } from '@/modules/Items/ServiceError';
import { TENANCY_DB_CONNECTION } from '@/modules/Tenancy/TenancyDB/TenancyDB.constants';
import { TransactionsLockingService } from '@/modules/TransactionsLocking/commands/CommandTransactionsLockingService';
import { TransactionsLockingRepository } from '@/modules/TransactionsLocking/TransactionsLockingRepository';
import { TransactionsLockingGroup } from '@/modules/TransactionsLocking/types/TransactionsLocking.types';
import { ERRORS as LOCKING_ERRORS } from '@/modules/TransactionsLocking/constants';
import { ACTOR_CLS_KEY, ExtAuditService } from '../common/ExtAudit.service';
import { ExtUnitOfWork } from '../common/ExtUnitOfWork.service';
import { ExtSettingsService } from '../common/ExtSettings.service';
import { ExtServiceLocator } from '../common/ExtServiceLocator.service';
import { toInstant, toPlainDate } from '../common/timestamps';
import { ExtRecordKind } from '../LedgerExt.constants';

const LOCKED_THROUGH = 'locked_through';
const SETTINGS_TABLE = 'ext_settings';
const EXCEPTIONS_TABLE = 'ext_lock_exceptions';
const LOCK_REASON = 'Books closed';

/** The longest reason kept. */
export const LOCK_REASON_MAX_LENGTH = 1000;

export const LOCK_ERRORS = {
  LOCK_EXCEPTION_ACTIVE: 'LOCK_EXCEPTION_ACTIVE',
  LOCK_EXCEPTION_NOT_LOCKED: 'LOCK_EXCEPTION_NOT_LOCKED',
  LOCK_EXCEPTION_RANGE_INVALID: 'LOCK_EXCEPTION_RANGE_INVALID',
  LOCK_EXCEPTION_EXPIRY_PAST: 'LOCK_EXCEPTION_EXPIRY_PAST',
  LOCK_EXCEPTION_ACTOR_REQUIRED: 'LOCK_EXCEPTION_ACTOR_REQUIRED',
  LOCK_EXCEPTION_NOT_FOUND: 'LOCK_EXCEPTION_NOT_FOUND',
};

export interface LockExceptionInput {
  from: string;
  to: string;
  reason: string;
  expiresAt: string;
}

export interface LockExceptionView {
  id: number;
  from: string;
  to: string;
  reason: string;
  actor: string;
  expiresAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
  createdAt: string;
  /** Neither revoked nor expired at the time of the read. */
  active: boolean;
}

interface ExceptionRow {
  id: number;
  fromDate: string;
  toDate: string;
  reason: string;
  actor: string;
  expiresAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
  createdAt: string;
}

interface Held {
  lockedThrough: string | null;
  exception: ExceptionRow | null;
}

/**
 * The lock on the books.
 *
 * The lock is a day, and it is inclusive: nothing dated on or before it can
 * be written. Bigcapital's own lock works the same way and is set to the
 * same day, which guards every other way into the books.
 *
 * A lock exception opens a range of locked days for a while, for a
 * correction: it names the range, the reason, who made it and when it
 * expires. While it is neither expired nor revoked, a write dated in its
 * range is let through. Bigcapital's lock holds one unlocked range, so one
 * exception is active at a time.
 */
@Injectable()
export class ExtLockService {
  /** What each open transaction holds of the lock, read once for it. */
  private readonly held = new WeakMap<object, Held>();

  constructor(
    @Inject(TENANCY_DB_CONNECTION)
    private readonly tenantKnex: () => Knex,
    private readonly cls: ClsService,
    private readonly uow: ExtUnitOfWork,
    private readonly settings: ExtSettingsService,
    private readonly locator: ExtServiceLocator,
    private readonly audit: ExtAuditService,
  ) {}

  public async getLockedThrough(
    trx?: Knex.Transaction,
  ): Promise<string | null> {
    return this.settings.get<string>(LOCKED_THROUGH, trx);
  }

  /**
   * Sets the last locked day, or clears the lock with null.
   */
  public async setLockedThrough(
    lockedThrough: string | null,
  ): Promise<string | null> {
    const locking = await this.locator.resolve(TransactionsLockingService);
    const day = lockedThrough === null ? null : toPlainDate(lockedThrough);

    if (day === null) {
      await locking.cancelTransactionLocking(TransactionsLockingGroup.All, {
        reason: LOCK_REASON,
      } as any);
    } else {
      await locking.commandTransactionsLocking(TransactionsLockingGroup.All, {
        module: TransactionsLockingGroup.All,
        lockToDate: day,
        reason: LOCK_REASON,
      } as any);
    }
    // The row is kept when the lock is cleared, holding a null, so that
    // writes always have a row to hold against the next change (see
    // `hold`). Writing it waits for every write that holds it.
    const auditId = await this.uow.withTransaction(async (trx) => {
      const before = await this.heldRow(trx, true);

      await trx(SETTINGS_TABLE)
        .where({ key: LOCKED_THROUGH })
        .update({ value: JSON.stringify(day) });
      if (before === day) return null;

      return this.audit.record(
        {
          action: 'edit',
          subject: ExtRecordKind.Lock,
          subjectId: null,
          before: { lockedThrough: before },
        },
        trx,
      );
    });
    await this.audit.finish(auditId, { lockedThrough: day });
    return day;
  }

  /**
   * Refuses when any of the given days is locked: on or before the last
   * locked day, and not in the range of an active exception.
   * @throws {ServiceError} TRANSACTIONS_DATE_LOCKED
   */
  public async assertOpen(
    days: Array<string | null | undefined>,
    trx?: Knex.Transaction,
  ): Promise<void> {
    const { lockedThrough, exception } = trx
      ? await this.hold(trx)
      : {
          lockedThrough: await this.getLockedThrough(),
          exception: await this.activeException(),
        };
    if (!lockedThrough) return;

    const locked = days.find(
      (day) =>
        day &&
        day <= lockedThrough &&
        !(exception && day >= exception.fromDate && day <= exception.toDate),
    );
    if (locked) {
      throw new ServiceError(
        LOCKING_ERRORS.TRANSACTIONS_DATE_LOCKED,
        'The transaction is dated in a period that has been closed.',
        { lockedThrough, date: locked },
      );
    }
  }

  /**
   * Opens a range of locked days until the exception expires or is revoked.
   * @throws {ServiceError} LOCK_EXCEPTION_ACTOR_REQUIRED
   * @throws {ServiceError} LOCK_EXCEPTION_RANGE_INVALID
   * @throws {ServiceError} LOCK_EXCEPTION_EXPIRY_PAST
   * @throws {ServiceError} LOCK_EXCEPTION_NOT_LOCKED
   * @throws {ServiceError} LOCK_EXCEPTION_ACTIVE
   */
  public async createException(
    input: LockExceptionInput,
  ): Promise<LockExceptionView> {
    const actor = this.cls.get<string>(ACTOR_CLS_KEY) ?? null;
    if (!actor) {
      throw new ServiceError(
        LOCK_ERRORS.LOCK_EXCEPTION_ACTOR_REQUIRED,
        'A lock exception names who made it, in the x-ledger-actor header.',
      );
    }
    const from = toPlainDate(input.from);
    const to = toPlainDate(input.to);
    const expiresAt = toInstant(input.expiresAt);
    const reason = input.reason.trim();

    if (from > to) {
      throw new ServiceError(
        LOCK_ERRORS.LOCK_EXCEPTION_RANGE_INVALID,
        'The range of a lock exception ends on or after the day it starts.',
        { from, to },
      );
    }
    const createdAt = new Date().toISOString();
    if (expiresAt <= createdAt) {
      throw new ServiceError(
        LOCK_ERRORS.LOCK_EXCEPTION_EXPIRY_PAST,
        'A lock exception expires at a time still to come.',
        { expiresAt },
      );
    }
    const { id, auditId } = await this.uow.withTransaction(async (trx) => {
      // Held for writing: every write that checks the lock waits for this.
      const lockedThrough = await this.heldRow(trx, true);

      if (!lockedThrough || to > lockedThrough) {
        throw new ServiceError(
          LOCK_ERRORS.LOCK_EXCEPTION_NOT_LOCKED,
          'A lock exception opens days that are locked. This range is not locked, or not all of it.',
          { lockedThrough, from, to },
        );
      }
      const active = await this.activeException(trx);
      if (active) {
        throw new ServiceError(
          LOCK_ERRORS.LOCK_EXCEPTION_ACTIVE,
          'One lock exception is active at a time. Revoke it, or wait for it to expire.',
          { id: active.id, expiresAt: active.expiresAt },
        );
      }
      const [newId] = await trx(EXCEPTIONS_TABLE).insert({
        fromDate: from,
        toDate: to,
        reason,
        actor,
        expiresAt,
        createdAt,
      });
      const audit = await this.audit.record(
        {
          action: 'create',
          subject: ExtRecordKind.LockException,
          subjectId: newId,
          before: null,
        },
        trx,
      );
      return { id: newId, auditId: audit };
    });
    const locking = await this.locator.resolve(TransactionsLockingService);

    await locking.unlockTransactionsLockingPartially(
      TransactionsLockingGroup.All,
      { unlockFromDate: from, unlockToDate: to, reason } as any,
    );
    const view = await this.exception(id);

    await this.audit.finish(auditId, view);
    return view;
  }

  /**
   * Ends an exception before it expires. One already revoked or expired is
   * answered as it stands.
   * @throws {ServiceError} LOCK_EXCEPTION_NOT_FOUND
   */
  public async revokeException(id: number): Promise<LockExceptionView> {
    const before = await this.exception(id);
    if (!before.active) return before;

    const revokedAt = new Date().toISOString();
    const auditId = await this.uow.withTransaction(async (trx) => {
      await this.heldRow(trx, true);

      const changed = await trx(EXCEPTIONS_TABLE)
        .where({ id })
        .whereNull('revokedAt')
        .update({
          revokedAt,
          revokedBy: this.cls.get<string>(ACTOR_CLS_KEY) ?? null,
        });
      if (!changed) return null;

      return this.audit.record(
        {
          action: 'revoke',
          subject: ExtRecordKind.LockException,
          subjectId: id,
          before,
        },
        trx,
      );
    });
    await this.closeBigcapitalRange();

    const view = await this.exception(id);

    await this.audit.finish(auditId, view);
    return view;
  }

  /** Every exception, active or not, newest first. */
  public async listExceptions(): Promise<LockExceptionView[]> {
    await this.closeBigcapitalRange();

    const rows: ExceptionRow[] = await this.tenantKnex()(EXCEPTIONS_TABLE)
      .orderBy('id', 'desc')
      .select('*');
    const now = new Date().toISOString();

    return rows.map((row) => this.view(row, now));
  }

  /**
   * Bigcapital's lock has no expiry of its own. Where it still holds an
   * unlocked range and no exception is active, the range is closed. Called
   * on the routes of the lock; the extension's own writes check the
   * exception themselves and do not wait for this.
   */
  public async closeBigcapitalRange(): Promise<void> {
    if (await this.activeException()) return;

    const repository = await this.locator.resolve(
      TransactionsLockingRepository,
    );
    const meta = await repository.getTransactionsLocking(
      TransactionsLockingGroup.All,
    );
    if (!meta.unlockFromDate && !meta.unlockToDate) return;

    const locking = await this.locator.resolve(TransactionsLockingService);
    await locking.cancelPartialTransactionsUnlock(TransactionsLockingGroup.All);
  }

  private async exception(id: number): Promise<LockExceptionView> {
    const row: ExceptionRow | undefined = await this.tenantKnex()(
      EXCEPTIONS_TABLE,
    )
      .where({ id })
      .first();

    if (!row) {
      throw new ServiceError(
        LOCK_ERRORS.LOCK_EXCEPTION_NOT_FOUND,
        'The lock exception was not found.',
        { id },
        HttpStatus.NOT_FOUND,
      );
    }
    return this.view(row, new Date().toISOString());
  }

  private view(row: ExceptionRow, now: string): LockExceptionView {
    return {
      id: Number(row.id),
      from: row.fromDate,
      to: row.toDate,
      reason: row.reason,
      actor: row.actor,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt ?? null,
      revokedBy: row.revokedBy ?? null,
      createdAt: row.createdAt,
      active: !row.revokedAt && row.expiresAt > now,
    };
  }

  /** The exception that is neither revoked nor expired, if there is one. */
  private async activeException(
    trx?: Knex.Transaction,
  ): Promise<ExceptionRow | null> {
    const row = await (trx ?? this.tenantKnex())(EXCEPTIONS_TABLE)
      .whereNull('revokedAt')
      .where('expiresAt', '>', new Date().toISOString())
      .orderBy('id', 'desc')
      .first();
    return row ?? null;
  }

  /**
   * The lock, read so that it cannot change before the transaction ends:
   * the setting's row is held with a shared lock, which a change of the
   * lock or of an exception waits for. Without this a write could pass the
   * check, the books close over its date, and the write then commit.
   */
  private async hold(trx: Knex.Transaction): Promise<Held> {
    const known = this.held.get(trx);
    if (known) return known;

    const held = {
      lockedThrough: await this.heldRow(trx, false),
      exception: await this.activeException(trx),
    };
    this.held.set(trx, held);
    return held;
  }

  /** The last locked day, with its row held for reading or for writing. */
  private async heldRow(
    trx: Knex.Transaction,
    forWrite: boolean,
  ): Promise<string | null> {
    const read = () => {
      const query = trx(SETTINGS_TABLE).where({ key: LOCKED_THROUGH });
      return (forWrite ? query.forUpdate() : query.forShare()).first();
    };
    let row = await read();

    if (!row) {
      // No row to hold yet: one is made, holding no lock.
      await trx(SETTINGS_TABLE)
        .insert({ key: LOCKED_THROUGH, value: JSON.stringify(null) })
        .onConflict('key')
        .ignore();
      row = await read();
    }
    return row ? (JSON.parse(row.value) as string | null) : null;
  }
}
