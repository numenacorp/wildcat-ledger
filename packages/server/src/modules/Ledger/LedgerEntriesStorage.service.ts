import { Knex } from 'knex';
import * as async from 'async';
import { Inject, Injectable } from '@nestjs/common';
import { transformLedgerEntryToTransaction } from './utils';
import {
  ILedgerEntry,
  ISaveLedgerEntryQueuePayload,
} from './types/Ledger.types';
import { ILedger } from './types/Ledger.types';
import { AccountTransaction } from '../Accounts/models/AccountTransaction.model';
import { AccountTransactionTrackingCategory } from '../TrackingCategories/models/AccountTransactionTrackingCategory';
import { TenantModelProxy } from '../System/models/TenantBaseModel';

// Filter the blank entries.
const filterBlankEntry = (entry: ILedgerEntry) =>
  Boolean(entry.credit || entry.debit);

@Injectable()
export class LedgerEntriesStorageService {
  /**
   * @param {TenantModelProxy<typeof AccountTransaction>} accountTransactionModel - Account transaction model.
   */
  constructor(
    @Inject(AccountTransaction.name)
    private readonly accountTransactionModel: TenantModelProxy<
      typeof AccountTransaction
    >,

    @Inject(AccountTransactionTrackingCategory.name)
    private readonly accountTransactionTrackingCategoryModel: TenantModelProxy<
      typeof AccountTransactionTrackingCategory
    >,
  ) {}

  /**
   * Saves entries of the given ledger.
   * @param {ILedger} ledger - Ledger.
   * @param {Knex.Transaction} trx - Knex transaction.
   * @returns {Promise<void>}
   */
  public saveEntries = async (ledger: ILedger, trx?: Knex.Transaction) => {
    const saveEntryQueue = async.queue(this.saveEntryTask.bind(this), 10);
    const entries = ledger.filter(filterBlankEntry).getEntries();

    // Each entry is awaited, so that an entry that could not be saved fails
    // the write. Pushed and merely drained, a failure went unseen and the
    // document was kept with rows missing from the books.
    await Promise.all(
      entries.map((entry) => saveEntryQueue.pushAsync({ entry, trx })),
    );
  };

  /**
   * Deletes the ledger entries.
   * @param {ILedger} ledger - Ledger.
   * @param {Knex.Transaction} trx - Knex transaction.
   */
  public deleteEntries = async (ledger: ILedger, trx?: Knex.Transaction) => {
    const entriesIds = ledger
      .getEntries()
      .filter((e) => e.entryId)
      .map((e) => e.entryId);

    await this.accountTransactionModel()
      .query(trx)
      .whereIn('id', entriesIds)
      .delete();
  };

  /**
   * Saves the ledger entry to the account transactions repository.
   * @param {ILedgerEntry} entry - Ledger entry.
   * @param {Knex.Transaction} trx
   * @returns {Promise<void>}
   */
  private saveEntry = async (
    entry: ILedgerEntry,
    trx?: Knex.Transaction,
  ): Promise<void> => {
    const transaction = transformLedgerEntryToTransaction(entry);

    const insertedTransaction = await this.accountTransactionModel()
      .query(trx)
      .insertAndFetch(transaction);

    // One row at a time: the models refuse to insert several rows in
    // one statement on MySQL and MariaDB, and the refusal was lost in the
    // save queue, leaving a row with two categories carrying none.
    for (const { categoryId, optionId } of entry.trackingCategories ?? []) {
      await this.accountTransactionTrackingCategoryModel().query(trx).insert({
        accountTransactionId: insertedTransaction.id,
        categoryId,
        optionId,
      });
    }
  };

  /**
   * Save the ledger entry to the transactions repository async task.
   * @param {ISaveLedgerEntryQueuePayload} task - Task payload.
   * @returns {Promise<void>}
   */
  private saveEntryTask = async (
    task: ISaveLedgerEntryQueuePayload,
  ): Promise<void> => {
    const { entry, trx } = task;

    await this.saveEntry(entry, trx);
  };
}
