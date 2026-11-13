import { Knex } from 'knex';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { TENANCY_DB_CONNECTION } from '@/modules/Tenancy/TenancyDB/TenancyDB.constants';
import { ServiceError } from '@/modules/Items/ServiceError';
import { toIso } from '../Trade/TradePaymentViews.service';
import { ExtTrackingService } from './ExtTracking.service';
import {
  CreateLedgerTrackingCategoryDto,
  LedgerTrackingOptionDto,
} from './LedgerTracking.dto';
import { TRACKING_ERRORS } from './tracking.constants';

export interface TrackingOptionView {
  id: number;
  name: string;
  /** The name the option is shown under: its own, until one is given. */
  displayName: string;
  active: boolean;
}

export interface TrackingCategoryView {
  id: number;
  name: string;
  /** The name the category is shown under: its own, until one is given. */
  displayName: string;
  options: TrackingOptionView[];
  createdAt: string | null;
  updatedAt: string | null;
}

/**
 * Tracking categories and their options, as records a caller can list, add
 * to and name. Nothing here removes a category or an option.
 */
@Injectable()
export class LedgerTrackingCategoriesService {
  constructor(
    @Inject(TENANCY_DB_CONNECTION)
    private readonly tenantKnex: () => Knex,
    private readonly tracking: ExtTrackingService,
  ) {}

  /** Every category with its options, in the order they were made. */
  public async list(): Promise<TrackingCategoryView[]> {
    return this.views(await this.tenantKnex()('tracking_categories'));
  }

  public async get(categoryId: number): Promise<TrackingCategoryView> {
    const row = Number.isInteger(categoryId)
      ? await this.tenantKnex()('tracking_categories')
          .where({ id: categoryId })
          .first()
      : null;
    if (!row) throw this.categoryNotFound({ categoryId });

    return (await this.views([row]))[0];
  }

  public async getByName(name: string): Promise<TrackingCategoryView> {
    const row = await this.tenantKnex()('tracking_categories')
      .where({ name })
      .first();
    if (!row) throw this.categoryNotFound({ name });

    return (await this.views([row]))[0];
  }

  /**
   * Makes a category with the options named. Sent again, it adds the options
   * that are missing and removes none; a display name sent again replaces
   * the one held.
   */
  public async create(
    dto: CreateLedgerTrackingCategoryDto,
  ): Promise<{ category: TrackingCategoryView; created: boolean }> {
    const knex = this.tenantKnex();
    const existing = await knex('tracking_categories')
      .where({ name: dto.name })
      .first();
    const categoryId = await this.tracking.ensureCategory(dto.name);

    if (dto.displayName) {
      await knex('ext_tracking_category_names')
        .insert({ categoryId, name: dto.displayName })
        .onConflict('categoryId')
        .merge();
    }
    for (const option of dto.options ?? []) {
      await this.tracking.ensureOption(
        categoryId,
        option.name,
        option.displayName,
      );
    }
    return { category: await this.get(categoryId), created: !existing };
  }

  /**
   * Adds an option to a category, or answers the one of that name.
   */
  public async addOption(
    categoryId: number,
    dto: LedgerTrackingOptionDto,
  ): Promise<{
    option: TrackingOptionView & { category: string };
    created: boolean;
  }> {
    await this.get(categoryId);
    const { id, created } = await this.tracking.ensureOptionRow(
      categoryId,
      dto.name,
      dto.displayName,
    );
    const category = await this.get(categoryId);

    return {
      option: {
        category: category.name,
        ...category.options.find((option) => option.id === id),
      },
      created,
    };
  }

  /**
   * Changes the name an option is shown under, or archives or restores it.
   * An archived option stays on the lines that carry it and takes no new
   * one.
   */
  public async updateOption(
    categoryId: number,
    optionId: number,
    changes: { displayName?: string; active?: boolean },
  ): Promise<TrackingOptionView & { category: string }> {
    const knex = this.tenantKnex();

    await this.get(categoryId);
    const option = Number.isInteger(optionId)
      ? await knex('tracking_category_options')
          .where({ id: optionId, categoryId })
          .first()
      : null;
    if (!option) {
      throw new ServiceError(
        TRACKING_ERRORS.OPTION_NOT_FOUND,
        'The tracking option was not found.',
        { categoryId, optionId },
        HttpStatus.NOT_FOUND,
      );
    }
    if (changes.displayName !== undefined) {
      await knex('ext_tracking_option_names')
        .insert({ optionId, name: changes.displayName })
        .onConflict('optionId')
        .merge();
    }
    if (changes.active !== undefined) {
      await knex('tracking_category_options')
        .where({ id: optionId })
        .update({ active: changes.active, updatedAt: knex.fn.now() });
    }

    const category = await this.get(categoryId);

    return {
      category: category.name,
      ...category.options.find((o) => o.id === optionId),
    };
  }

  private async views(categories: any[]): Promise<TrackingCategoryView[]> {
    if (categories.length === 0) return [];

    const knex = this.tenantKnex();
    const ids = categories.map((category) => Number(category.id));
    const [names, options] = await Promise.all([
      knex('ext_tracking_category_names').whereIn('categoryId', ids),
      knex('tracking_category_options as o')
        .leftJoin('ext_tracking_option_names as n', 'n.option_id', 'o.id')
        .whereIn('o.category_id', ids)
        .orderBy('o.id')
        .select(
          'o.id as id',
          'o.category_id as categoryId',
          'o.name as name',
          'o.active as active',
          'n.name as displayName',
        ),
    ]);
    const nameOf = new Map<number, string>(
      names.map((row: any) => [Number(row.categoryId), row.name]),
    );

    return [...categories]
      .sort((a, b) => Number(a.id) - Number(b.id))
      .map((category) => {
        const id = Number(category.id);
        return {
          id,
          name: category.name,
          displayName: nameOf.get(id) ?? category.name,
          options: options
            .filter((option: any) => Number(option.categoryId) === id)
            .map((option: any) => ({
              id: Number(option.id),
              name: option.name,
              displayName: option.displayName ?? option.name,
              active: Boolean(option.active),
            })),
          createdAt: toIso(category.createdAt),
          // Bigcapital leaves this empty until the category is first edited.
          updatedAt: toIso(category.updatedAt ?? category.createdAt),
        };
      });
  }

  private categoryNotFound(payload: Record<string, unknown>): ServiceError {
    return new ServiceError(
      TRACKING_ERRORS.CATEGORY_NOT_FOUND,
      'The tracking category was not found.',
      payload,
      HttpStatus.NOT_FOUND,
    );
  }
}
