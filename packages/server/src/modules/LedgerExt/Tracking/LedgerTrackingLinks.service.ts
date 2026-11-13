import { Knex } from 'knex';
import { HttpStatus, Injectable } from '@nestjs/common';
import { ServiceError } from '@/modules/Items/ServiceError';
import { ExtAuditService } from '../common/ExtAudit.service';
import { ExtUnitOfWork } from '../common/ExtUnitOfWork.service';
import { ExtLockService } from '../Lock/ExtLock.service';
import { ExtRecordKind } from '../LedgerExt.constants';
import { inChunks } from '../common/chunks';
import { TradeLedgerService } from '../Trade/TradeLedger.service';
import { TradeConfig } from '../Trade/trade.config';
import { ExtTrackingService, TrackingAssignment } from './ExtTracking.service';
import { CreateLedgerTrackingLinksDto } from './LedgerTracking.dto';
import { LINE_TYPES, TRACKING_ERRORS } from './tracking.constants';

export interface TrackingLinkView {
  id: number;
  lineId: number;
  category: string;
  option: string;
  optionName: string;
}

const JOURNAL_REFERENCE = 'Journal';

/**
 * Links between document lines and tracking options, made and removed on
 * their own, without the document being sent again.
 *
 * A link moves no money, but it changes what a period's reports say by
 * tag, so it is refused on a document dated in a locked period, as an edit
 * of the document is. Each line changed is written to the audit log with
 * the assignments it had and the ones it has. A link leaves the line's id
 * as it was. The document's ledger rows are brought
 * in step in the same transaction: a journal's rows take the assignment in
 * place; a bill's or an invoice's are written again, as an edit writes them.
 */
@Injectable()
export class LedgerTrackingLinksService {
  constructor(
    private readonly uow: ExtUnitOfWork,
    private readonly tracking: ExtTrackingService,
    private readonly tradeLedger: TradeLedgerService,
    private readonly lock: ExtLockService,
    private readonly audit: ExtAuditService,
  ) {}

  /**
   * Gives every named line every named assignment. A line that has an option
   * of a named category takes the new option in its place, on the same link.
   * @returns The links of the named categories on the named lines, in the
   *   order the lines were named.
   */
  public async create(
    dto: CreateLedgerTrackingLinksDto,
  ): Promise<TrackingLinkView[]> {
    const { kind, config } = LINE_TYPES[dto.lineType];
    const lineIds = [...new Set(dto.lineIds)];
    // The categories and options named must exist already, and be active.
    const resolved = await this.tracking.resolve(dto.tracking);
    const wanted = new Map<number, number>();

    dto.tracking.forEach((t) => {
      const { categoryId, optionId } = resolved.get(this.tracking.key(t));
      wanted.set(categoryId, optionId);
    });

    const logged: Array<[number, number]> = [];
    const links = await this.uow.withTransaction(async (trx) => {
      const lines = await inChunks(lineIds, (run) =>
        trx('ext_lines').where({ kind }).whereIn('id', run),
      );
      const lineById = new Map(
        lines.map((line: any) => [Number(line.id), line]),
      );
      const missing = lineIds.find((id) => !lineById.has(id));

      if (missing !== undefined) {
        throw new ServiceError(
          TRACKING_ERRORS.LINE_NOT_FOUND,
          'The line was not found.',
          { lineType: dto.lineType, lineId: missing },
          HttpStatus.NOT_FOUND,
        );
      }
      await this.lockDocuments(config, lines, trx);
      await this.assertOpen(config, lines, trx);

      const current = await this.tracking.ofLines(lineIds, trx);

      for (const lineId of lineIds) {
        logged.push([
          lineId,
          await this.audit.record(
            {
              action: 'edit',
              subject: kind,
              subjectId: lineId,
              before: { tracking: this.assignments(current.get(lineId)) },
            },
            trx,
          ),
        ]);
        const kept = (current.get(lineId) ?? []).filter(
          (link) => !wanted.has(link.categoryId),
        );
        await this.tracking.setLineLinks(
          lineId,
          [
            ...kept,
            ...[...wanted].map(([categoryId, optionId]) => ({
              categoryId,
              optionId,
            })),
          ],
          trx,
        );
      }
      await this.bringLedgerInStep(config, lines, [...wanted.keys()], trx);

      const after = await this.tracking.ofLines(lineIds, trx);

      return {
        after,
        views: lineIds.flatMap((lineId) =>
          (after.get(lineId) ?? [])
            .filter((link) => wanted.has(link.categoryId))
            .map((link) => ({
              id: link.id,
              lineId,
              category: link.category,
              option: link.option,
              optionName: link.optionName,
            })),
        ),
      };
    });
    for (const [lineId, auditId] of logged) {
      await this.audit.finish(auditId, {
        tracking: this.assignments(links.after.get(lineId)),
      });
    }
    return links.views;
  }

  /** A line's assignments as the audit log keeps them. */
  private assignments(
    links: Array<{ category: string; option: string }> | undefined,
  ): Array<{ category: string; option: string }> {
    return (links ?? []).map(({ category, option }) => ({ category, option }));
  }

  /**
   * Refuses when a line's document is dated in a locked period. Each
   * document's own day is the one looked at.
   */
  private async assertOpen(
    config: TradeConfig | null,
    lines: any[],
    trx: Knex.Transaction,
  ): Promise<void> {
    const recordIds = [...new Set(lines.map((line) => Number(line.recordId)))];
    if (recordIds.length === 0) return;

    const rows = config
      ? await inChunks(recordIds, (run) =>
          trx('ext_trade_documents')
            .whereIn('id', run)
            .select('posted_on as on'),
        )
      : await inChunks(recordIds, (run) =>
          trx('ext_documents')
            .where({ kind: ExtRecordKind.ManualJournal })
            .whereIn('record_id', run)
            .select('transacted_on as on'),
        );
    await this.lock.assertOpen(
      rows.map((row: any) => row.on),
      trx,
    );
  }

  /**
   * Removes links by id. Nothing is removed unless every id names a link.
   */
  public async remove(ids: number[]): Promise<void> {
    const linkIds = [...new Set(ids)];
    const logged: Array<[number, unknown]> = [];

    await this.uow.withTransaction(async (trx) => {
      const links = await inChunks(linkIds, (run) =>
        trx('ext_tracking_links as k')
          .join('ext_lines as l', 'l.id', 'k.line_id')
          .whereIn('k.id', run)
          .select(
            'k.id as linkId',
            'k.category_id as categoryId',
            'l.id as id',
            'l.kind as kind',
            'l.record_id as recordId',
            'l.entry_id as entryId',
            'l.index as index',
          ),
      );
      const found = new Set(links.map((link: any) => Number(link.linkId)));
      const missing = linkIds.find((id) => !found.has(id));

      if (missing !== undefined) {
        throw new ServiceError(
          TRACKING_ERRORS.LINK_NOT_FOUND,
          'The tracking link was not found.',
          { linkId: missing },
          HttpStatus.NOT_FOUND,
        );
      }
      for (const { kind, config } of Object.values(LINE_TYPES)) {
        const ofKind = links.filter((link: any) => link.kind === kind);
        if (ofKind.length === 0) continue;

        await this.lockDocuments(config, ofKind, trx);
        await this.assertOpen(config, ofKind, trx);

        const ofLines = [
          ...new Set(ofKind.map((link: any) => Number(link.id))),
        ];
        const before = await this.tracking.ofLines(ofLines, trx);
        const removed = new Set(ofKind.map((link: any) => Number(link.linkId)));
        for (const lineId of ofLines) {
          const had = before.get(lineId) ?? [];
          logged.push([
            await this.audit.record(
              {
                action: 'edit',
                subject: kind,
                subjectId: lineId,
                before: { tracking: this.assignments(had) },
              },
              trx,
            ),
            {
              tracking: this.assignments(
                had.filter((link) => !removed.has(link.id)),
              ),
            },
          ]);
        }
        await inChunks(
          ofKind.map((link: any) => Number(link.linkId)),
          (run) =>
            trx('ext_tracking_links')
              .whereIn('id', run)
              .delete()
              .then(() => []),
        );
        if (config) {
          await this.bringLedgerInStep(config, ofKind, [], trx);
          continue;
        }
        // One pass for each category, over the lines that lose it.
        const categoryIds = [
          ...new Set(ofKind.map((link: any) => Number(link.categoryId))),
        ];
        for (const categoryId of categoryIds) {
          await this.bringLedgerInStep(
            null,
            ofKind.filter(
              (link: any) => Number(link.categoryId) === categoryId,
            ),
            [categoryId],
            trx,
          );
        }
      }
    });
    for (const [auditId, after] of logged) {
      await this.audit.finish(auditId, after);
    }
  }

  /**
   * Locks the documents the lines belong to, lowest id first, so that a
   * write of the document and a link on it run one after the other.
   */
  private async lockDocuments(
    config: TradeConfig | null,
    lines: any[],
    trx: Knex.Transaction,
  ): Promise<void> {
    const table = config ? 'ext_trade_documents' : 'manual_journals';
    const recordIds = [
      ...new Set(lines.map((line) => Number(line.recordId))),
    ].sort((a, b) => a - b);

    for (const id of recordIds) {
      await trx(table).where({ id }).first().forUpdate();
    }
  }

  /**
   * Makes the ledger rows of the lines' documents carry what the lines now
   * do. For a journal, only the named categories are touched.
   */
  private async bringLedgerInStep(
    config: TradeConfig | null,
    lines: any[],
    categoryIds: number[],
    trx: Knex.Transaction,
  ): Promise<void> {
    if (config) {
      const documentIds = [
        ...new Set(lines.map((line) => Number(line.recordId))),
      ];
      for (const documentId of documentIds) {
        await this.tradeLedger.postDocument(config, documentId, trx);
        await this.tradeLedger.repostPaymentsOf(config, documentId, trx);
      }
      return;
    }
    const links = await this.tracking.ofLines(
      lines.map((line) => Number(line.id)),
      trx,
    );
    for (const line of lines) {
      const now = new Map<number, number>(
        (links.get(Number(line.id)) ?? []).map((link: TrackingAssignment) => [
          link.categoryId,
          link.optionId,
        ]),
      );
      const rows = await trx('accounts_transactions')
        .where({
          referenceType: JOURNAL_REFERENCE,
          referenceId: Number(line.recordId),
          index: Number(line.index),
        })
        .select('id');
      const targets: Array<[string, Record<string, number>]> = [
        ...(line.entryId
          ? [
              [
                'manual_journal_entry_tracking_categories',
                { manualJournalEntryId: Number(line.entryId) },
              ] as [string, Record<string, number>],
            ]
          : []),
        ...rows.map(
          (row: any) =>
            [
              'account_transaction_tracking_categories',
              { accountTransactionId: Number(row.id) },
            ] as [string, Record<string, number>],
        ),
      ];
      for (const [table, owner] of targets) {
        for (const categoryId of categoryIds) {
          await trx(table)
            .where({ ...owner, categoryId })
            .delete();

          if (now.has(categoryId)) {
            await trx(table).insert({
              ...owner,
              categoryId,
              optionId: now.get(categoryId),
              createdAt: trx.fn.now(),
              updatedAt: trx.fn.now(),
            });
          }
        }
      }
    }
  }
}
