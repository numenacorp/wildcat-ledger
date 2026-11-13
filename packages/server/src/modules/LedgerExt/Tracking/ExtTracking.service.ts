import { Knex } from 'knex';
import { ExtRecordKind } from '../LedgerExt.constants';
import { TRACKING_ERRORS } from './tracking.constants';
import { ServiceError } from '@/modules/Items/ServiceError';
import { Inject, Injectable } from '@nestjs/common';
import { TENANCY_DB_CONNECTION } from '@/modules/Tenancy/TenancyDB/TenancyDB.constants';
import { CreateTrackingCategoryService } from '@/modules/TrackingCategories/commands/CreateTrackingCategory.service';
import { ExtServiceLocator } from '../common/ExtServiceLocator.service';
import { isDuplicateKey } from '../common/dbErrors';
import { inChunks } from '../common/chunks';

/** A tracking assignment named by category and option, as callers give it. */
export interface TrackingInput {
  category: string;
  option: string;
  /** The name the option is shown under, taken when the option is new. */
  optionName?: string | null;
}

export interface TrackingAssignment {
  categoryId: number;
  optionId: number;
}

export interface TrackingView {
  /** The id of the link between the line and the option. */
  id: number;
  category: string;
  option: string;
  /** The name the option is shown under: its own, unless one was given. */
  optionName: string;
}

/**
 * Tracking categories and options addressed by name.
 *
 * A write names categories and options that exist and are active: one that
 * is unknown, or archived, is refused, and nothing is made on first use.
 * Categories and options are made through their own routes.
 */
@Injectable()
export class ExtTrackingService {
  constructor(
    @Inject(TENANCY_DB_CONNECTION)
    private readonly tenantKnex: () => Knex,
    private readonly locator: ExtServiceLocator,
  ) {}

  /**
   * The assignments the lines of one record carry now, for `resolve`: an
   * edit of the record may send them again though one is archived since.
   */
  public async carriedBy(
    lineKind: ExtRecordKind,
    recordId: number,
  ): Promise<TrackingInput[]> {
    const lines = await this.tenantKnex()('ext_lines')
      .where({ kind: lineKind, recordId })
      .select('id');
    const links = await this.ofLines(lines.map((line: any) => Number(line.id)));

    return [...links.values()]
      .flat()
      .map(({ category, option }) => ({ category, option }));
  }

  /**
   * Resolves named assignments to ids. Nothing is created.
   * @param carried Assignments the record being edited already carries. An
   *   archived option stays on the lines that carry it, so it is taken
   *   again from them; it is refused on any other line.
   * @returns For each distinct `category` and `option` pair, its ids.
   * @throws {ServiceError} TRACKING_CATEGORY_NOT_FOUND,
   *   TRACKING_OPTION_NOT_FOUND, TRACKING_OPTION_ARCHIVED
   */
  public async resolve(
    inputs: TrackingInput[],
    carried: TrackingInput[] = [],
  ): Promise<Map<string, TrackingAssignment>> {
    const resolved = new Map<string, TrackingAssignment>();
    const knex = this.tenantKnex();
    const kept = new Set(carried.map((input) => this.key(input)));

    for (const input of inputs) {
      const key = this.key(input);
      if (resolved.has(key)) continue;

      const { category, option } = input;
      const categoryRow = await knex('tracking_categories')
        .where({ name: category })
        .first();
      if (!categoryRow) {
        throw new ServiceError(
          TRACKING_ERRORS.UNKNOWN_CATEGORY,
          `There is no tracking category "${category}". Make it before a write names it.`,
          { category },
        );
      }
      const categoryId = Number(categoryRow.id);
      const optionRow = await knex('tracking_category_options')
        .where({ categoryId, name: option })
        .first();
      if (!optionRow) {
        throw new ServiceError(
          TRACKING_ERRORS.UNKNOWN_OPTION,
          `The tracking category "${category}" has no option "${option}". Make it before a write names it.`,
          { category, option },
        );
      }
      if (!optionRow.active && !kept.has(key)) {
        throw new ServiceError(
          TRACKING_ERRORS.OPTION_ARCHIVED,
          `The option "${option}" of the tracking category "${category}" is archived and takes no new line.`,
          { category, option },
        );
      }
      resolved.set(key, { categoryId, optionId: Number(optionRow.id) });
    }
    return resolved;
  }

  public key(input: TrackingInput): string {
    return JSON.stringify([input.category, input.option]);
  }

  /**
   * The assignments and names of document lines, keyed by the stable line id.
   */
  public async ofLines(
    lineIds: number[],
    trx?: Knex.Transaction,
  ): Promise<Map<number, Array<TrackingView & TrackingAssignment>>> {
    const found = new Map<number, Array<TrackingView & TrackingAssignment>>();
    if (lineIds.length === 0) return found;

    const rows = await inChunks(lineIds, (run) =>
      (trx ?? this.tenantKnex())('ext_tracking_links as l')
        .join('tracking_categories as c', 'c.id', 'l.category_id')
        .join('tracking_category_options as o', 'o.id', 'l.option_id')
        .leftJoin('ext_tracking_option_names as n', 'n.option_id', 'o.id')
        .whereIn('l.line_id', run)
        .orderBy('l.id')
        .select(
          'l.id as id',
          'l.line_id as lineId',
          'l.category_id as categoryId',
          'l.option_id as optionId',
          'c.name as category',
          'o.name as option',
          'n.name as optionName',
        ),
    );
    rows.forEach((row: any) => {
      const lineId = Number(row.lineId);

      found.set(lineId, [
        ...(found.get(lineId) ?? []),
        {
          id: Number(row.id),
          category: row.category,
          option: row.option,
          optionName: row.optionName ?? row.option,
          categoryId: Number(row.categoryId),
          optionId: Number(row.optionId),
        },
      ]);
    });
    return found;
  }

  /**
   * Makes the assignments of one document line the given ones. A line has at
   * most one option of a category: of two assignments of one category the
   * later stands. A link whose category stays keeps its id, also when its
   * option changes.
   */
  public async setLineLinks(
    lineId: number,
    assignments: TrackingAssignment[],
    trx: Knex.Transaction,
  ): Promise<void> {
    const wanted = new Map<number, number>();
    assignments.forEach((a) => wanted.set(a.categoryId, a.optionId));

    const existing = await trx('ext_tracking_links').where({ lineId });
    const seen = new Set<number>();

    for (const link of existing) {
      const categoryId = Number(link.categoryId);
      const optionId = wanted.get(categoryId);

      if (optionId === undefined || seen.has(categoryId)) {
        await trx('ext_tracking_links').where({ id: link.id }).delete();
        continue;
      }
      seen.add(categoryId);
      if (Number(link.optionId) !== optionId) {
        await trx('ext_tracking_links')
          .where({ id: link.id })
          .update({ optionId });
      }
    }
    const added = [...wanted]
      .filter(([categoryId]) => !seen.has(categoryId))
      .map(([categoryId, optionId]) => ({ lineId, categoryId, optionId }));

    if (added.length > 0) await trx('ext_tracking_links').insert(added);
  }

  /**
   * Brings the links of a journal's lines in step with the assignments
   * Bigcapital holds for the journal's entries, which a write of the journal
   * has just replaced.
   */
  public async syncJournalLinks(
    lines: Array<{ id: number; entryId: number | null }>,
    trx: Knex.Transaction,
  ): Promise<void> {
    const entryIds = lines
      .map((line) => line.entryId)
      .filter((id): id is number => id !== null);
    const rows = await inChunks(entryIds, (run) =>
      trx('manual_journal_entry_tracking_categories').whereIn(
        'manualJournalEntryId',
        run,
      ),
    );
    for (const line of lines) {
      await this.setLineLinks(
        line.id,
        rows
          .filter(
            (row: any) => Number(row.manualJournalEntryId) === line.entryId,
          )
          .map((row: any) => ({
            categoryId: Number(row.categoryId),
            optionId: Number(row.optionId),
          })),
        trx,
      );
    }
  }

  public async removeLineLinks(
    lineIds: number[],
    trx: Knex.Transaction,
  ): Promise<void> {
    if (lineIds.length === 0) return;
    await inChunks(lineIds, (run) =>
      trx('ext_tracking_links')
        .whereIn('lineId', run)
        .delete()
        .then(() => []),
    );
  }

  public async ensureCategory(name: string): Promise<number> {
    const existing = await this.tenantKnex()('tracking_categories')
      .where({ name })
      .first();
    if (existing) return Number(existing.id);

    const createCategory = await this.locator.resolve(
      CreateTrackingCategoryService,
    );
    try {
      const created: any = await createCategory.createTrackingCategory({
        name,
        options: [],
      } as any);
      return Number(created.id);
    } catch (error) {
      // Another request created it in the meantime.
      const raced = await this.tenantKnex()('tracking_categories')
        .where({ name })
        .first();
      if (raced) return Number(raced.id);
      throw error;
    }
  }

  /**
   * Adds an option to a category. Bigcapital's own edit replaces a category's
   * whole option list, which two requests adding different options at once
   * would lose one of, so the option row is inserted directly.
   */
  public async ensureOption(
    categoryId: number,
    name: string,
    displayName?: string | null,
  ): Promise<number> {
    return (await this.ensureOptionRow(categoryId, name, displayName)).id;
  }

  /**
   * As `ensureOption`, saying also whether the option was made by this call.
   */
  public async ensureOptionRow(
    categoryId: number,
    name: string,
    displayName?: string | null,
  ): Promise<{ id: number; created: boolean }> {
    const knex = this.tenantKnex();
    const find = () =>
      knex('tracking_category_options').where({ categoryId, name }).first();

    const existing = await find();
    if (existing) return { id: Number(existing.id), created: false };
    try {
      const [id] = await knex('tracking_category_options').insert({
        categoryId,
        name,
        active: true,
        createdAt: knex.fn.now(),
        updatedAt: knex.fn.now(),
      });
      if (displayName && displayName !== name) {
        await knex('ext_tracking_option_names').insert({
          optionId: id,
          name: displayName,
        });
      }
      return { id: Number(id), created: true };
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      return { id: Number((await find()).id), created: false };
    }
  }
}
