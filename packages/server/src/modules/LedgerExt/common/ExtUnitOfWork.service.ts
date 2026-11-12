import { Knex } from 'knex';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import { UnitOfWork } from '@/modules/Tenancy/TenancyDB/UnitOfWork.service';
import { IsolationLevel } from '@/modules/Tenancy/TenancyDB/TransactionsHooks';
import { isDeadlock } from './dbErrors';

/**
 * Connections of an organization's pool that are never taken by extension
 * transactions. See {@link ExtUnitOfWork}.
 */
const RESERVED_CONNECTIONS = 2;

/** Times a transaction is attempted when the engine reports a deadlock. */
const MAX_ATTEMPTS = 4;

interface Gate {
  running: number;
  waiting: Array<() => void>;
}

/**
 * Opens the transaction every extension operation runs in.
 *
 * An operation of the extension usually writes through several services: the
 * document itself, the ledger rows its subscribers post, and the extension's
 * companion rows. All of them receive this one transaction, so the operation
 * is applied as a whole or not at all.
 *
 * The transaction is opened at READ COMMITTED rather than the READ UNCOMMITTED
 * the stock unit of work uses, so a request never acts on another request's
 * uncommitted rows. READ COMMITTED is preferred to REPEATABLE READ because it
 * takes no gap locks, which make concurrent inserts into the same tables
 * deadlock.
 *
 * A deadlock can still happen. The engine then rolls one transaction back
 * whole, and that transaction is run again from the start, up to a few
 * times. The work passed in must therefore be safe to run more than once:
 * everything it writes should go through the transaction it is given.
 *
 * Transactions are also limited per organization. While a transaction is
 * open, the services it calls still run some queries of their own outside it
 * (validations, number sequences), each on a second connection of the same
 * pool. If every connection of the pool were held by an open transaction,
 * none of them could finish. So at most `pool size - 2` extension
 * transactions run at once for an organization, and the rest wait their turn
 * without holding a connection.
 */
@Injectable()
export class ExtUnitOfWork {
  private static readonly gates = new Map<string, Gate>();

  constructor(
    private readonly uow: UnitOfWork,
    private readonly cls: ClsService,
    private readonly configService: ConfigService,
  ) {}

  public async withTransaction<T>(
    work: (trx: Knex.Transaction) => Promise<T> | T,
    trx?: Knex.Transaction,
  ): Promise<T> {
    // Joining an outer transaction: its opener already holds a turn.
    if (trx) {
      return this.uow.withTransaction(work, trx);
    }
    const release = await this.acquire();
    try {
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await this.uow.withTransaction(
            work,
            undefined,
            IsolationLevel.READ_COMMITTED,
          );
        } catch (error: any) {
          if (!isDeadlock(error) || attempt >= MAX_ATTEMPTS) {
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
        }
      }
    } finally {
      release();
    }
  }

  /** The most extension transactions an organization runs at once. */
  public get limit(): number {
    const poolMax =
      Number(this.configService.get('tenantDatabase.poolMax')) || 7;
    return Math.max(1, poolMax - RESERVED_CONNECTIONS);
  }

  private acquire(): Promise<() => void> {
    const key = String(this.cls.get('organizationId'));
    let gate = ExtUnitOfWork.gates.get(key);

    if (!gate) {
      gate = { running: 0, waiting: [] };
      ExtUnitOfWork.gates.set(key, gate);
    }
    const held = gate;
    const release = () => {
      const next = held.waiting.shift();
      if (next) {
        // The turn passes straight to the next in line.
        next();
        return;
      }
      held.running -= 1;
      if (held.running === 0) ExtUnitOfWork.gates.delete(key);
    };

    if (held.running < this.limit) {
      held.running += 1;
      return Promise.resolve(release);
    }
    return new Promise((resolve) => {
      held.waiting.push(() => resolve(release));
    });
  }
}
