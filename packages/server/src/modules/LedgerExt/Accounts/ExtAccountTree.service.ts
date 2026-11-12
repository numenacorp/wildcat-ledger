import { Knex } from 'knex';
import { Inject, Injectable } from '@nestjs/common';
import { TENANCY_DB_CONNECTION } from '@/modules/Tenancy/TenancyDB/TenancyDB.constants';

const TABLE = 'ext_account_tree';

/** Longest name Bigcapital stores for an account. */
const ACCOUNT_NAME_MAX_LENGTH = 255;

export interface ExtAccountNode {
  accountId: number;
  parentAccountId: number | null;
  /** The name shown for the account. Need not be unique. */
  name: string;
  /** The account number. Unique when present. */
  code: string | null;
}

/**
 * The chart of accounts as the extension presents it.
 *
 * Accounts are kept flat in Bigcapital, each under an internal name that is
 * unique. The tree, the display names and the account numbers live here. An
 * account with no node is not part of the presented chart.
 */
@Injectable()
export class ExtAccountTreeService {
  constructor(
    @Inject(TENANCY_DB_CONNECTION)
    private readonly tenantKnex: () => Knex,
  ) {}

  /**
   * The name an account is stored under in Bigcapital, which requires every
   * account name to be unique: the display name followed by the account
   * number, or by a token when there is no number.
   */
  public internalName(
    name: string,
    code: string | null,
    token: string,
  ): string {
    const suffix = code ? ` (${code})` : ` (#${token})`;
    return `${name.slice(0, ACCOUNT_NAME_MAX_LENGTH - suffix.length)}${suffix}`;
  }

  public async register(
    node: ExtAccountNode,
    trx: Knex.Transaction,
  ): Promise<void> {
    await trx(TABLE).insert({
      accountId: node.accountId,
      parentAccountId: node.parentAccountId,
      name: node.name,
      code: node.code,
      createdAt: trx.fn.now(),
      updatedAt: trx.fn.now(),
    });
  }

  public async setParent(
    accountId: number,
    parentAccountId: number | null,
    trx: Knex.Transaction,
  ): Promise<void> {
    await trx(TABLE)
      .where({ accountId })
      .update({ parentAccountId, updatedAt: trx.fn.now() });
  }

  /**
   * Changes the name, number or parent of a node. Only the keys given are
   * changed.
   */
  public async update(
    accountId: number,
    changes: Partial<Pick<ExtAccountNode, 'name' | 'code' | 'parentAccountId'>>,
    trx: Knex.Transaction,
  ): Promise<void> {
    if (Object.keys(changes).length === 0) return;
    await trx(TABLE)
      .where({ accountId })
      .update({ ...changes, updatedAt: trx.fn.now() });
  }

  public async remove(accountId: number, trx: Knex.Transaction): Promise<void> {
    await trx(TABLE).where({ accountId }).delete();
  }

  public async get(
    accountId: number,
    trx?: Knex.Transaction,
  ): Promise<ExtAccountNode | null> {
    const row = await (trx ?? this.tenantKnex())(TABLE)
      .where({ accountId })
      .first();
    return row ? this.toNode(row) : null;
  }

  public async list(trx?: Knex.Transaction): Promise<ExtAccountNode[]> {
    const rows = await (trx ?? this.tenantKnex())(TABLE).orderBy('accountId');
    return rows.map((row) => this.toNode(row));
  }

  private toNode(row: any): ExtAccountNode {
    return {
      accountId: Number(row.accountId),
      parentAccountId:
        row.parentAccountId === null ? null : Number(row.parentAccountId),
      name: row.name,
      code: row.code ?? null,
    };
  }
}
