import { Knex } from 'knex';
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
 * A write may name a category or an option that does not exist yet; it is
 * created then. Categories and options are created before, and outside, the
 * transaction of the document that names them, because Bigcapital validates a
 * document's assignments on a connection of its own, where rows of an open
 * transaction cannot be seen. A category created for a document that then
 * fails is left in place, empty.
 */
@Injectable()
export class ExtTrackingService {
  constructor(
    @Inject(TENANCY_DB_CONNECTION)
    private readonly tenantKnex: () => Knex,
    private readonly locator: ExtServiceLocator,
  ) {}

  /**
   * Resolves named assignments to ids, creating what is missing.
   * @returns For each distinct `category` and `option` pair, its ids.
   */
  public async resolve(
    inputs: TrackingInput[],
  ): Promise<Map<string, TrackingAssignment>> {
    const resolved = new Map<string, TrackingAssignment>();

    for (const input of inputs) {
      const key = this.key(input);
      if (resolved.has(key)) continue;

      const categoryId = await this.ensureCategory(input.category);
      const optionId = await this.ensureOption(
        categoryId,
        input.option,
        input.optionName,
      );
      resolved.set(key, { categoryId, optionId });
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
