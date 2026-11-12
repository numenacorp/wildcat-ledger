import { Knex } from 'knex';
import { Injectable } from '@nestjs/common';
import { ServiceError } from '@/modules/Items/ServiceError';
import { ExtSettingsService } from '../common/ExtSettings.service';
import {
  MARKED_ACCOUNTS,
  MARKED_ACCOUNT_ERRORS,
  MarkedAccountSlug,
  markedAccountSetting,
} from './markedAccounts';

/**
 * Finds the accounts a chart marked for the extension to post to.
 */
@Injectable()
export class ExtMarkedAccountsService {
  constructor(private readonly settings: ExtSettingsService) {}

  public async mark(
    slug: MarkedAccountSlug,
    accountId: number,
    trx: Knex.Transaction,
  ): Promise<void> {
    await this.settings.set(markedAccountSetting(slug), accountId, trx);
  }

  public async find(
    slug: MarkedAccountSlug,
    trx?: Knex.Transaction,
  ): Promise<number | null> {
    const id = await this.settings.get<number>(markedAccountSetting(slug), trx);
    return id === null || id === undefined ? null : Number(id);
  }

  /**
   * @throws {ServiceError} LEDGER_ACCOUNT_NOT_MARKED when the chart marks none.
   */
  public async get(
    slug: MarkedAccountSlug,
    trx?: Knex.Transaction,
  ): Promise<number> {
    const id = await this.find(slug, trx);

    if (id === null) {
      throw new ServiceError(
        MARKED_ACCOUNT_ERRORS.ACCOUNT_NOT_MARKED,
        `The chart marks no account as "${slug}", which this write posts to.`,
        { slug },
      );
    }
    return id;
  }

  /** The ids of every marked account. */
  public async ids(trx?: Knex.Transaction): Promise<Set<number>> {
    const ids = await Promise.all(
      Object.keys(MARKED_ACCOUNTS).map((slug) => this.find(slug, trx)),
    );
    return new Set(ids.filter((id): id is number => id !== null));
  }
}
