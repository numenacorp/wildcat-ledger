import { isMarkedAccountSlug } from '../Accounts/markedAccounts';
import { ExtMarkedAccountsService } from '../Accounts/ExtMarkedAccounts.service';
import { Knex } from 'knex';
import { randomBytes } from 'crypto';
import { Injectable } from '@nestjs/common';
import { CreateAccountService } from '@/modules/Accounts/CreateAccount.service';
import { CreateItemService } from '@/modules/Items/CreateItem.service';
import { CreateCustomer } from '@/modules/Customers/commands/CreateCustomer.service';
import { CreateVendorService } from '@/modules/Vendors/commands/CreateVendor.service';
import { SettingsApplicationService } from '@/modules/Settings/SettingsApplication.service';
import { Features } from '@/common/types/Features';
import { ExtUnitOfWork } from '../common/ExtUnitOfWork.service';
import { isDuplicateKey } from '../common/dbErrors';
import { ExtSettingsService } from '../common/ExtSettings.service';
import { ExtMetadataService } from '../common/ExtMetadata.service';
import { ExtServiceLocator } from '../common/ExtServiceLocator.service';
import { ExtAccountTreeService } from '../Accounts/ExtAccountTree.service';
import {
  ChartAccountInput,
  parentsFirst,
  SINGLE_ACCOUNT_TYPES,
} from '../Accounts/chart';
import { ExtRecordKind } from '../LedgerExt.constants';
import { WORKSPACE_SETTINGS } from './LedgerWorkspaces.constants';

const SETTINGS_TABLE = 'ext_settings';

/** Predefined accounts the generic line item is created against. */
const GENERIC_ITEM_SELL_ACCOUNT = 'sales-of-service-income';
const GENERIC_ITEM_COST_ACCOUNT = 'cost-of-goods-sold';

export interface ProvisionWorkspaceInput {
  baseCurrency: string;
  /** The chart to create. Without one, Bigcapital's seeded chart is used. */
  accounts?: ChartAccountInput[] | null;
}

/**
 * Prepares a newly built organization for the extension. In one transaction
 * it creates the chart of accounts and the helper records every other
 * operation relies on:
 *
 * - an account for payments in transit, used when a payment names no account;
 * - one generic item, since every bill and invoice line must name an item,
 *   while the extension posts each line to an account of the caller's choice;
 * - a placeholder customer and vendor, for journal lines on receivables and
 *   payables that name no contact.
 *
 * It runs once per organization. A second run, or a concurrent one, finds the
 * marker the first wrote and does nothing.
 *
 * Must be called with the organization's tenancy context set.
 */
@Injectable()
export class ProvisionWorkspaceService {
  constructor(
    private readonly uow: ExtUnitOfWork,
    private readonly settings: ExtSettingsService,
    private readonly metadata: ExtMetadataService,
    private readonly tree: ExtAccountTreeService,
    private readonly locator: ExtServiceLocator,
    private readonly marked: ExtMarkedAccountsService,
  ) {}

  public async provision(input: ProvisionWorkspaceInput): Promise<void> {
    // Two runs that start together can deadlock on the marker. The unit of
    // work runs the loser again, and it then finds the marker.
    const provisioned = await this.uow.withTransaction(async (trx) => {
      if (!(await this.claim(trx))) return false;

      await this.createChart(input.accounts ?? null, trx);
      await this.createHelperRecords(input.baseCurrency, trx);
      return true;
    });
    if (!provisioned) return;

    // Tracking categories are switched on for every workspace.
    const settingsApplication = await this.locator.resolve(
      SettingsApplicationService,
    );
    await settingsApplication.saveSettings({
      options: [
        { group: 'features', key: Features.TRACKING_CATEGORIES, value: true },
      ],
    } as any);
  }

  public async isProvisioned(): Promise<boolean> {
    return (await this.settings.get(WORKSPACE_SETTINGS.PROVISIONED)) === true;
  }

  /**
   * Writes the marker that the organization is provisioned. The marker's key
   * is the table's primary key, so of two concurrent runs the second waits
   * for the first and then fails here.
   * @returns False when the organization is already provisioned.
   */
  private async claim(trx: Knex.Transaction): Promise<boolean> {
    try {
      await trx(SETTINGS_TABLE).insert({
        key: WORKSPACE_SETTINGS.PROVISIONED,
        value: 'true',
      });
      return true;
    } catch (error: any) {
      if (isDuplicateKey(error)) return false;
      throw error;
    }
  }

  /**
   * Creates the given chart, or presents the seeded chart when none is given.
   */
  private async createChart(
    accounts: ChartAccountInput[] | null,
    trx: Knex.Transaction,
  ): Promise<void> {
    const seeded: Array<{
      id: number;
      name: string;
      code: string;
      slug: string;
      accountType: string;
    }> = await trx('accounts').select(
      'id',
      'name',
      'code',
      'slug',
      'accountType',
    );

    if (!accounts) {
      for (const account of seeded) {
        await this.tree.register(
          {
            accountId: account.id,
            parentAccountId: null,
            name: account.name,
            code: account.code || null,
          },
          trx,
        );
      }
      return;
    }
    const createAccount = await this.locator.resolve(CreateAccountService);
    const idByCode = new Map<string, number>();
    const usedSeededIds = new Set<number>();

    for (const entry of parentsFirst(accounts)) {
      // An entry of a single-account type, or one naming a predefined
      // account, stands for the seeded account instead of making a twin.
      const match = seeded.find((account) =>
        entry.slug
          ? account.slug === entry.slug &&
            account.accountType === entry.accountType
          : SINGLE_ACCOUNT_TYPES.includes(entry.accountType) &&
            account.accountType === entry.accountType,
      );
      let accountId: number;

      if (match && !usedSeededIds.has(match.id)) {
        accountId = match.id;
        usedSeededIds.add(match.id);
      } else {
        const created = await createAccount.createAccount(
          {
            name: this.tree.internalName(entry.name, entry.code, this.token()),
            accountType: entry.accountType,
            description: entry.description ?? undefined,
          } as any,
          trx,
        );
        accountId = created.id;
      }
      idByCode.set(entry.code, accountId);

      await this.tree.register(
        {
          accountId,
          parentAccountId: entry.parentCode
            ? (idByCode.get(entry.parentCode) ?? null)
            : null,
          name: entry.name,
          code: entry.code,
        },
        trx,
      );
      await this.metadata.set(
        ExtRecordKind.Account,
        accountId,
        entry.metadata ?? undefined,
        trx,
      );
      if (isMarkedAccountSlug(entry.slug)) {
        await this.marked.mark(entry.slug, accountId, trx);
      }
    }
    // Documents post to the receivable and payable accounts whether or not
    // the chart named them, so both are always part of the presented chart.
    for (const type of SINGLE_ACCOUNT_TYPES) {
      const account = seeded.find((a) => a.accountType === type);

      if (account && !usedSeededIds.has(account.id)) {
        await this.tree.register(
          {
            accountId: account.id,
            parentAccountId: null,
            name: account.name,
            code: null,
          },
          trx,
        );
      }
    }
  }

  private async createHelperRecords(
    baseCurrency: string,
    trx: Knex.Transaction,
  ): Promise<void> {
    const sellAccount = await trx('accounts')
      .where({ slug: GENERIC_ITEM_SELL_ACCOUNT })
      .first();
    const costAccount = await trx('accounts')
      .where({ slug: GENERIC_ITEM_COST_ACCOUNT })
      .first();

    const createItem = await this.locator.resolve(CreateItemService);
    const itemId = await createItem.createItem(
      {
        name: 'Line',
        type: 'service',
        sellable: true,
        purchasable: true,
        sellAccountId: sellAccount.id,
        costAccountId: costAccount.id,
      } as any,
      trx,
    );
    const createCustomer = await this.locator.resolve(CreateCustomer);
    const customer = await createCustomer.createCustomer(
      {
        customerType: 'business',
        displayName: 'Unassigned Customer',
        currencyCode: baseCurrency,
      } as any,
      trx,
    );
    const createVendor = await this.locator.resolve(CreateVendorService);
    const vendor = await createVendor.createVendor(
      {
        displayName: 'Unassigned Vendor',
        currencyCode: baseCurrency,
      } as any,
      trx,
    );
    await this.settings.set(WORKSPACE_SETTINGS.GENERIC_ITEM_ID, itemId, trx);
    await this.settings.set(
      WORKSPACE_SETTINGS.PLACEHOLDER_CUSTOMER_ID,
      customer.id,
      trx,
    );
    await this.settings.set(
      WORKSPACE_SETTINGS.PLACEHOLDER_VENDOR_ID,
      vendor.id,
      trx,
    );
  }

  private token(): string {
    return randomBytes(4).toString('hex');
  }
}
