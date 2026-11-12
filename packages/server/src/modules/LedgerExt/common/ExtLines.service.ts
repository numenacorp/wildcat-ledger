import { Knex } from 'knex';
import { Inject, Injectable } from '@nestjs/common';
import { TENANCY_DB_CONNECTION } from '@/modules/Tenancy/TenancyDB/TenancyDB.constants';
import { inChunks } from './chunks';
import { ExtRecordKind } from '../LedgerExt.constants';

const TABLE = 'ext_lines';

export interface ExtLine {
  /** The stable id of the line. It survives edits of the document. */
  id: number;
  kind: ExtRecordKind;
  recordId: number;
  /** The id of Bigcapital's own entry row, which is replaced on every edit. */
  entryId: number | null;
  index: number;
  externalId: string | null;
  description: string | null;
  /** The account, item, rate, quantity and amount of a bill or invoice line. */
  accountId: number | null;
  item: string | null;
  rate: string | null;
  quantity: string | null;
  amount: string | null;
}

export interface ExtLineInput {
  /** The stable id of an existing line, when the line is being kept. */
  id?: number;
  entryId?: number | null;
  externalId?: string | null;
  description?: string | null;
  accountId?: number | null;
  item?: string | null;
  rate?: string | null;
  quantity?: string | null;
  amount?: string | null;
}

/**
 * Stable identity for the lines of a document.
 *
 * Bigcapital replaces a document's entry rows, and so their ids, whenever the
 * document is edited. The extension gives every line an id of its own that a
 * caller can hold on to, and keeps each line's external id and description.
 */
@Injectable()
export class ExtLinesService {
  constructor(
    @Inject(TENANCY_DB_CONNECTION)
    private readonly tenantKnex: () => Knex,
  ) {}

  /**
   * Replaces the lines of a document with the given ones, in order.
   *
   * A line that names the stable id of an existing line of the same document
   * keeps that id. Any other line gets a new one, and existing lines that are
   * not named are removed.
   * @returns The lines as stored, in order.
   */
  public async replace(
    kind: ExtRecordKind,
    recordId: number,
    lines: ExtLineInput[],
    trx: Knex.Transaction,
  ): Promise<ExtLine[]> {
    const existing = await this.list(kind, recordId, trx);
    const existingIds = new Set(existing.map((line) => line.id));
    const keptIds = new Set<number>();

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const attributes = {
        entryId: line.entryId ?? null,
        index: index + 1,
        externalId: line.externalId ?? null,
        description: line.description ?? null,
        accountId: line.accountId ?? null,
        item: line.item ?? null,
        rate: line.rate ?? null,
        quantity: line.quantity ?? null,
        amount: line.amount ?? null,
      };
      if (line.id !== undefined && existingIds.has(line.id)) {
        await trx(TABLE).where({ id: line.id }).update(attributes);
        keptIds.add(line.id);
      } else {
        const [id] = await trx(TABLE).insert({ kind, recordId, ...attributes });
        keptIds.add(id);
      }
    }
    const removedIds = existing
      .map((line) => line.id)
      .filter((id) => !keptIds.has(id));

    if (removedIds.length > 0) {
      await trx(TABLE).whereIn('id', removedIds).delete();
    }
    return this.list(kind, recordId, trx);
  }

  public async list(
    kind: ExtRecordKind,
    recordId: number,
    trx?: Knex.Transaction,
  ): Promise<ExtLine[]> {
    const rows = await (trx ?? this.tenantKnex())(TABLE)
      .where({ kind, recordId })
      .orderBy('index', 'asc');
    return rows.map((row) => this.toLine(row));
  }

  /**
   * Retrieves the lines of several documents, keyed by record id.
   */
  public async listMany(
    kind: ExtRecordKind,
    recordIds: number[],
    trx?: Knex.Transaction,
  ): Promise<Map<number, ExtLine[]>> {
    const found = new Map<number, ExtLine[]>();
    if (recordIds.length === 0) return found;

    const rows = await inChunks(recordIds, (run) =>
      (trx ?? this.tenantKnex())(TABLE)
        .where({ kind })
        .whereIn('recordId', run)
        .orderBy('index', 'asc'),
    );

    rows.forEach((row) => {
      const line = this.toLine(row);
      found.set(line.recordId, [...(found.get(line.recordId) ?? []), line]);
    });
    return found;
  }

  public async remove(
    kind: ExtRecordKind,
    recordId: number,
    trx: Knex.Transaction,
  ): Promise<void> {
    await trx(TABLE).where({ kind, recordId }).delete();
  }

  private toLine(row: any): ExtLine {
    return {
      id: Number(row.id),
      kind: row.kind,
      recordId: Number(row.recordId),
      entryId: row.entryId === null ? null : Number(row.entryId),
      index: Number(row.index),
      externalId: row.externalId ?? null,
      description: row.description ?? null,
      accountId: row.accountId === null ? null : Number(row.accountId),
      item: row.item ?? null,
      rate: row.rate ?? null,
      quantity: row.quantity ?? null,
      amount: row.amount === null ? null : String(row.amount),
    };
  }
}
