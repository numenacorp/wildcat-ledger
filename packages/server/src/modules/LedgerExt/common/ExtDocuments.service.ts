import { Knex } from 'knex';
import { Inject, Injectable } from '@nestjs/common';
import { TENANCY_DB_CONNECTION } from '@/modules/Tenancy/TenancyDB/TenancyDB.constants';
import { ExtRecordKind } from '../LedgerExt.constants';

const TABLE = 'ext_documents';

export interface ExtDocument {
  kind: ExtRecordKind;
  recordId: number;
  /** The exact instant of the document, as a UTC ISO-8601 string. */
  transactedAt: string;
  paymentMethod: string | null;
  reference: string | null;
  memo: string | null;
  /** Who created the document, as the caller names them. */
  createdBy: string | null;
  /** Set when the document has been voided. */
  voidedAt: string | null;
  /** The document as it last stood before it was voided. */
  voidSnapshot: Record<string, unknown> | null;
}

export type ExtDocumentAttributes = Partial<
  Pick<
    ExtDocument,
    'transactedAt' | 'paymentMethod' | 'reference' | 'memo' | 'createdBy'
  >
>;

/**
 * What the extension keeps about a document beyond Bigcapital's own columns:
 * its exact timestamp (Bigcapital stores the calendar day), the payment method
 * and memo, and the last state of a document that has been voided.
 */
@Injectable()
export class ExtDocumentsService {
  constructor(
    @Inject(TENANCY_DB_CONNECTION)
    private readonly tenantKnex: () => Knex,
  ) {}

  /**
   * Creates or updates the companion row of a document.
   */
  public async upsert(
    kind: ExtRecordKind,
    recordId: number,
    attributes: ExtDocumentAttributes,
    trx: Knex.Transaction,
  ): Promise<void> {
    const existing = await trx(TABLE).where({ kind, recordId }).first();

    if (existing) {
      if (Object.keys(attributes).length === 0) return;
      await trx(TABLE)
        .where({ id: existing.id })
        .update({ ...attributes, updatedAt: trx.fn.now() });
      return;
    }
    await trx(TABLE).insert({
      kind,
      recordId,
      ...attributes,
      createdAt: trx.fn.now(),
      updatedAt: trx.fn.now(),
    });
  }

  public async get(
    kind: ExtRecordKind,
    recordId: number,
    trx?: Knex.Transaction,
  ): Promise<ExtDocument | null> {
    const row = await (trx ?? this.tenantKnex())(TABLE)
      .where({ kind, recordId })
      .first();
    return row ? this.toDocument(row) : null;
  }

  /**
   * Retrieves the companion rows of several documents, keyed by record id.
   */
  public async getMany(
    kind: ExtRecordKind,
    recordIds: number[],
    trx?: Knex.Transaction,
  ): Promise<Map<number, ExtDocument>> {
    const found = new Map<number, ExtDocument>();
    if (recordIds.length === 0) return found;

    const rows = await (trx ?? this.tenantKnex())(TABLE)
      .where({ kind })
      .whereIn('recordId', recordIds);
    rows.forEach((row) =>
      found.set(Number(row.recordId), this.toDocument(row)),
    );
    return found;
  }

  /**
   * Marks a document voided and keeps the state it was last in, so that it
   * can still be listed and read once the document itself is gone.
   */
  public async markVoided(
    kind: ExtRecordKind,
    recordId: number,
    voidedAt: string,
    snapshot: Record<string, unknown>,
    trx: Knex.Transaction,
  ): Promise<void> {
    await this.upsert(kind, recordId, {}, trx);
    await trx(TABLE)
      .where({ kind, recordId })
      .update({
        voidedAt,
        voidSnapshot: JSON.stringify(snapshot),
        updatedAt: trx.fn.now(),
      });
  }

  /**
   * Retrieves the voided documents of a kind, newest first.
   */
  public async listVoided(
    kind: ExtRecordKind,
    trx?: Knex.Transaction,
  ): Promise<ExtDocument[]> {
    const rows = await (trx ?? this.tenantKnex())(TABLE)
      .where({ kind })
      .whereNotNull('voidedAt')
      .orderBy('transactedAt', 'desc');
    return rows.map((row) => this.toDocument(row));
  }

  public async remove(
    kind: ExtRecordKind,
    recordId: number,
    trx: Knex.Transaction,
  ): Promise<void> {
    await trx(TABLE).where({ kind, recordId }).delete();
  }

  private toDocument(row: any): ExtDocument {
    return {
      kind: row.kind,
      recordId: Number(row.recordId),
      transactedAt: row.transactedAt ?? null,
      paymentMethod: row.paymentMethod ?? null,
      reference: row.reference ?? null,
      memo: row.memo ?? null,
      createdBy: row.createdBy ?? null,
      voidedAt: row.voidedAt ?? null,
      voidSnapshot: row.voidSnapshot ? JSON.parse(row.voidSnapshot) : null,
    };
  }
}
