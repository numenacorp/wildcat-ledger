import { Knex } from 'knex';
import {
  raiseVersion,
  refusingStale,
  requireVersion,
} from '../common/versions';
import { randomBytes } from 'crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { ServiceError } from '@/modules/Items/ServiceError';
import { TENANCY_DB_CONNECTION } from '@/modules/Tenancy/TenancyDB/TenancyDB.constants';
import { CreateAccountService } from '@/modules/Accounts/CreateAccount.service';
import { DeleteAccount } from '@/modules/Accounts/DeleteAccount.service';
import { ActivateAccount } from '@/modules/Accounts/ActivateAccount.service';
import { AuditAction, ExtAuditService } from '../common/ExtAudit.service';
import { ExtUnitOfWork } from '../common/ExtUnitOfWork.service';
import { ExternalIdsService } from '../common/ExternalIds.service';
import { ExtMetadataService } from '../common/ExtMetadata.service';
import { ExtSettingsService } from '../common/ExtSettings.service';
import { ExtServiceLocator } from '../common/ExtServiceLocator.service';
import { LedgerRowsService } from '../common/LedgerRows.service';
import { fromThousandths, toThousandths } from '../common/decimal';
import { previousDay, toPlainDate } from '../common/timestamps';
import { ExtRecordKind } from '../LedgerExt.constants';
import { LedgerWorkspacesService } from '../Workspaces/LedgerWorkspaces.service';
import { fiscalYearStart } from '../Workspaces/fiscalYear';
import { ExtMarkedAccountsService } from './ExtMarkedAccounts.service';
import {
  ExtAccountNode,
  ExtAccountTreeService,
} from './ExtAccountTree.service';
import { rootTypeOf, SINGLE_ACCOUNT_TYPES } from './chart';
import { ACCOUNT_ERRORS } from './LedgerAccounts.constants';
import {
  CreateLedgerAccountDto,
  CreateLedgerChildAccountDto,
  EditLedgerAccountDto,
  LedgerAccountResponseDto,
  ListLedgerAccountsQueryDto,
} from './LedgerAccount.dto';

/** An account as it is shown inside a bill, an invoice or a payment. */
export interface LedgerAccountBrief {
  id: number;
  code: string | null;
  name: string;
  accountType: string;
  metadata: Record<string, unknown> | null;
}

interface AccountRow {
  id: number;
  name: string;
  slug: string;
  accountType: string;
  predefined: number | boolean;
  active: number | boolean;
}

/**
 * The chart of accounts of the extension: a tree of accounts with display
 * names and numbers that need not be unique, each with its balance.
 *
 * An account Bigcapital holds but the chart does not (one of its predefined
 * accounts the workspace was not created with) is listed only once it has
 * been posted to.
 */
const TREE_TABLE = 'ext_account_tree';

@Injectable()
export class LedgerAccountsService {
  constructor(
    @Inject(TENANCY_DB_CONNECTION)
    private readonly tenantKnex: () => Knex,
    private readonly cls: ClsService,
    private readonly uow: ExtUnitOfWork,
    private readonly tree: ExtAccountTreeService,
    private readonly externalIds: ExternalIdsService,
    private readonly metadata: ExtMetadataService,
    private readonly settings: ExtSettingsService,
    private readonly ledgerRows: LedgerRowsService,
    private readonly locator: ExtServiceLocator,
    private readonly workspaces: LedgerWorkspacesService,
    private readonly marked: ExtMarkedAccountsService,
    private readonly audit: ExtAuditService,
  ) {}

  /** The audit row of a change to an account, inside the change's transaction. */
  private logAccount(
    action: AuditAction,
    accountId: number,
    before: LedgerAccountResponseDto | null,
    trx: Knex.Transaction,
    code?: string | null,
  ): Promise<number> {
    return this.audit.record(
      {
        action,
        subject: ExtRecordKind.Account,
        subjectId: accountId,
        number: code ?? before?.code ?? null,
        before,
      },
      trx,
    );
  }

  /**
   * Lists every account of the chart, flat, in code order, with its balance
   * over the range on the basis given.
   */
  public async list(
    query: ListLedgerAccountsQueryDto = {},
  ): Promise<LedgerAccountResponseDto[]> {
    const defaults = await this.ledgerDefaults();
    const basis = query.basis ?? defaults.basis;
    const from = query.from ? toPlainDate(query.from) : null;
    const notBefore =
      query.includeBeforeStart === 'true' ? null : defaults.booksStartOn;
    const trackingOptionIds = await this.trackingOptionIds(query);
    const to = query.to ? toPlainDate(query.to) : null;
    // What income and expense accounts held before the fiscal year of the
    // last day asked for: what a balance sheet counts as retained earnings.
    const priorYears = to
      ? await this.ledgerRows.balances({
          to: previousDay(fiscalYearStart(to, defaults.fiscalYearStartMonth)),
          notBefore,
          basis,
          trackingOptionIds,
        })
      : null;
    const [accounts, nodes, balances, opening, posted, helperIds] =
      await Promise.all([
        this.accountRows(),
        this.tree.list(),
        this.ledgerRows.balances({
          from,
          to,
          notBefore,
          basis,
          trackingOptionIds,
        }),
        // Everything dated before the range, asked for with a start only.
        from
          ? this.ledgerRows.balances({
              to: previousDay(from),
              notBefore,
              basis,
              trackingOptionIds,
            })
          : null,
        this.ledgerRows.postedAccountIds(),
        this.helperAccountIds(),
      ]);
    const nodeById = new Map(nodes.map((node) => [node.accountId, node]));
    const presented = accounts.filter(
      (account) => nodeById.has(account.id) || posted.has(account.id),
    );
    const ids = presented.map((account) => account.id);
    const [metadata, externalIds] = await Promise.all([
      this.metadata.getMany(ExtRecordKind.Account, ids),
      this.externalIds.findExternalIds(ExtRecordKind.Account, ids),
    ]);
    const childrenOf = new Map<number, number[]>();
    nodes.forEach((node) => {
      if (node.parentAccountId === null) return;
      childrenOf.set(node.parentAccountId, [
        ...(childrenOf.get(node.parentAccountId) ?? []),
        node.accountId,
      ]);
    });
    type Totals = Map<number, { debit: string; credit: string }>;
    const own = (totals: Totals, accountId: number): bigint => {
      const balance = totals.get(accountId);
      return balance
        ? toThousandths(balance.debit) - toThousandths(balance.credit)
        : 0n;
    };
    const withDescendants = (
      totals: Totals,
      accountId: number,
      seen = new Set<number>(),
    ): bigint => {
      if (seen.has(accountId)) return 0n;
      seen.add(accountId);
      return (childrenOf.get(accountId) ?? []).reduce(
        (total, childId) => total + withDescendants(totals, childId, seen),
        own(totals, accountId),
      );
    };

    return presented
      .map((account) => {
        const node = nodeById.get(account.id);
        const hasChildren = (childrenOf.get(account.id) ?? []).length > 0;

        return {
          id: account.id,
          code: node?.code ?? null,
          name: node?.name ?? account.name,
          accountType: account.accountType,
          parentId: node?.parentAccountId ?? null,
          isTypeRoot: Boolean(node?.isTypeRoot),
          version: node?.version ?? 1,
          active: Boolean(account.active),
          externalId: externalIds.get(account.id) ?? null,
          metadata: metadata.get(account.id) ?? null,
          deletable:
            !posted.has(account.id) &&
            !hasChildren &&
            !this.isProtected(account, helperIds),
          balance: fromThousandths(withDescendants(balances, account.id)),
          ownBalance: fromThousandths(own(balances, account.id)),
          ...(opening
            ? {
                openingBalance: fromThousandths(
                  withDescendants(opening, account.id),
                ),
                ownOpeningBalance: fromThousandths(own(opening, account.id)),
              }
            : {}),
          ...(priorYears &&
          ['income', 'expense'].includes(rootTypeOf(account.accountType))
            ? {
                priorYearsBalance: fromThousandths(
                  withDescendants(priorYears, account.id),
                ),
              }
            : {}),
        };
      })
      .sort(
        (a, b) =>
          Number(a.code === null) - Number(b.code === null) ||
          (a.code ?? '').localeCompare(b.code ?? '', 'en', { numeric: true }) ||
          a.name.localeCompare(b.name, 'en') ||
          a.id - b.id,
      );
  }

  public async get(accountId: number): Promise<LedgerAccountResponseDto> {
    await this.nodeOrThrow(accountId);
    return (await this.list()).find((account) => account.id === accountId);
  }

  /**
   * Creates an account. With an external id the create is repeat-safe: a
   * repeat returns the account the first call made.
   */
  public async create(dto: CreateLedgerAccountDto): Promise<{
    account: LedgerAccountResponseDto;
    created: boolean;
    replayed: boolean;
  }> {
    if (!rootTypeOf(dto.accountType)) {
      throw new ServiceError(
        ACCOUNT_ERRORS.ACCOUNT_TYPE_NOT_FOUND,
        `"${dto.accountType}" is not an account type.`,
      );
    }
    if (SINGLE_ACCOUNT_TYPES.includes(dto.accountType)) {
      throw new ServiceError(
        ACCOUNT_ERRORS.ACCOUNT_TYPE_SINGLE,
        `An organization holds one account of type "${dto.accountType}", and it already exists.`,
      );
    }
    if (dto.parentId !== undefined && dto.parentId !== null) {
      await this.assertParentAllowed(dto.accountType, dto.parentId);
    }
    let logged: number | null = null;
    const { recordId, created, replayed } = await this.externalIds.createOnce({
      kind: ExtRecordKind.Account,
      externalId: dto.externalId,
      body: dto,
      describe: async (id) => ({
        state: 'live' as const,
        version: (await this.tree.get(id))?.version ?? 1,
      }),
      create: async (trx) => {
        const id = await this.createInTransaction(
          {
            name: dto.name,
            code: dto.code ?? null,
            accountType: dto.accountType,
            parentAccountId: dto.parentId ?? null,
            metadata: dto.metadata,
          },
          trx,
        );
        logged = await this.logAccount('create', id, null, trx, dto.code);
        return id;
      },
      read: async (id) => id,
    });
    const account = await this.get(recordId);
    if (created) await this.audit.finish(logged, account);
    return { account, created, replayed };
  }

  /**
   * Creates a child of an account. The child takes its parent's type, and its
   * parent's metadata with the given keys laid over it.
   */
  public async createChild(
    parentId: number,
    dto: CreateLedgerChildAccountDto,
  ): Promise<LedgerAccountResponseDto> {
    await this.nodeOrThrow(parentId);
    const parent = await this.accountRowOrThrow(parentId);
    const parentMetadata = await this.metadata.get(
      ExtRecordKind.Account,
      parentId,
    );
    const metadata =
      parentMetadata || dto.metadata
        ? { ...(parentMetadata ?? {}), ...(dto.metadata ?? {}) }
        : undefined;

    // A receivable or payable account is the only one of its type, so its
    // children are plain accounts of the same side of the balance sheet.
    const accountType = SINGLE_ACCOUNT_TYPES.includes(parent.accountType)
      ? parent.accountType === 'accounts-receivable'
        ? 'other-current-asset'
        : 'other-current-liability'
      : parent.accountType;

    const [accountId, logged] = await this.uow.withTransaction(async (trx) => {
      const id = await this.createInTransaction(
        {
          name: dto.name,
          code: dto.code ?? null,
          accountType,
          parentAccountId: parentId,
          metadata,
        },
        trx,
      );
      return [id, await this.logAccount('create', id, null, trx, dto.code)];
    });
    const account = await this.get(accountId);
    await this.audit.finish(logged, account);
    return account;
  }

  /**
   * Renames, renumbers or moves an account. Only the keys given are changed.
   */
  public async edit(
    accountId: number,
    dto: EditLedgerAccountDto,
  ): Promise<LedgerAccountResponseDto> {
    await this.nodeOrThrow(accountId);
    const account = await this.accountRowOrThrow(accountId);
    const changes: Partial<ExtAccountNode> = {};

    if (dto.name !== undefined) changes.name = dto.name;
    if (dto.code !== undefined)
      changes.code = dto.code === '' ? null : dto.code;
    if (dto.parentId !== undefined) {
      if (dto.parentId !== null) {
        if ((await this.tree.get(accountId))?.isTypeRoot) {
          throw new ServiceError(
            ACCOUNT_ERRORS.ACCOUNT_IS_TYPE_ROOT,
            'The account is a type root and cannot be moved under another account.',
            { accountIds: [accountId] },
          );
        }
        await this.assertParentAllowed(account.accountType, dto.parentId);
        await this.assertNotCircular(accountId, dto.parentId);
      }
      changes.parentAccountId = dto.parentId;
    }
    const version = requireVersion(dto.version);
    const before = await this.get(accountId);
    const logged = await refusingStale(
      () =>
        this.uow.withTransaction(async (trx) => {
          await raiseVersion(trx, TREE_TABLE, { accountId }, version);
          await this.tree.update(accountId, changes, trx);
          await this.metadata.set(
            ExtRecordKind.Account,
            accountId,
            dto.metadata,
            trx,
          );
          return this.logAccount('edit', accountId, before, trx);
        }),
      () => this.get(accountId),
    );
    const after = await this.get(accountId);
    await this.audit.finish(logged, after);
    return after;
  }

  /**
   * Deletes an account that has no postings and no children and is not one
   * Bigcapital or the extension depends on.
   */
  public async delete(
    accountId: number,
    expected?: number | string | null,
  ): Promise<void> {
    await this.nodeOrThrow(accountId);
    const version = requireVersion(expected);
    const account = await this.accountRowOrThrow(accountId);
    const [nodes, posted, helperIds] = await Promise.all([
      this.tree.list(),
      this.ledgerRows.postedAccountIds(),
      this.helperAccountIds(),
    ]);
    if (nodes.find((node) => node.accountId === accountId)?.isTypeRoot) {
      throw new ServiceError(
        ACCOUNT_ERRORS.ACCOUNT_IS_TYPE_ROOT,
        'The account is a type root and cannot be deleted.',
        { accountIds: [accountId] },
      );
    }
    if (this.isProtected(account, helperIds)) {
      throw new ServiceError(
        ACCOUNT_ERRORS.ACCOUNT_PREDEFINED,
        'The account is predefined and cannot be deleted.',
      );
    }
    if (nodes.some((node) => node.parentAccountId === accountId)) {
      throw new ServiceError(
        ACCOUNT_ERRORS.ACCOUNT_HAS_CHILDREN,
        'The account has child accounts and cannot be deleted.',
      );
    }
    if (posted.has(accountId)) {
      throw new ServiceError(
        ACCOUNT_ERRORS.ACCOUNT_HAS_ASSOCIATED_TRANSACTIONS,
        'The account has transactions and cannot be deleted.',
      );
    }
    const knex = this.tenantKnex();
    const [asset, loan] = await Promise.all([
      knex('ext_fixed_assets')
        .where({ accountId })
        .orWhere({ accumulatedAccountId: accountId })
        .first(),
      knex('ext_loans').where({ accountId }).first(),
    ]);
    if (asset || loan) {
      throw new ServiceError(
        ACCOUNT_ERRORS.ACCOUNT_IN_USE,
        `The account is used by a ${asset ? 'fixed asset' : 'loan'} and cannot be deleted.`,
        asset
          ? { fixedAssetId: Number(asset.id) }
          : { loanId: Number(loan.id) },
      );
    }
    const deleteAccount = await this.locator.resolve(DeleteAccount);
    // The account as it stood, kept by the log: once deleted it is read no more.
    const before = await this.get(accountId);

    await refusingStale(
      () =>
        this.uow.withTransaction(async (trx) => {
          await raiseVersion(trx, TREE_TABLE, { accountId }, version);
          await this.logAccount('delete', accountId, before, trx);
          await deleteAccount.deleteAccount(accountId, trx);
          await this.tree.remove(accountId, trx);
          await this.metadata.remove(ExtRecordKind.Account, accountId, trx);
          // The account's external id stays its own: it is not used again.
          await this.externalIds.markDeleted(
            ExtRecordKind.Account,
            accountId,
            trx,
          );
        }),
      () => this.get(accountId),
    );
  }

  /**
   * Archives an account, or restores it. An archived account takes no new
   * line and is left out of pickers; its history and its balance stay on
   * every report. As in Bigcapital, the accounts beneath it go with it, both
   * ways. A type root, and an account documents or the extension post to by
   * role, cannot be archived; nor can an account above one.
   */
  public async setArchived(
    accountId: number,
    archived: boolean,
    expected?: number | null,
  ): Promise<LedgerAccountResponseDto> {
    await this.nodeOrThrow(accountId);
    const version = requireVersion(expected);
    const [nodes, accounts, helperIds] = await Promise.all([
      this.tree.list(),
      this.accountRows(),
      this.helperAccountIds(),
    ]);
    const ids: number[] = [];
    const walk = (id: number) => {
      if (ids.includes(id)) return;
      ids.push(id);
      nodes
        .filter((node) => node.parentAccountId === id)
        .forEach((node) => walk(node.accountId));
    };
    walk(accountId);

    if (archived) {
      const nodeById = new Map(nodes.map((node) => [node.accountId, node]));
      const rowById = new Map(accounts.map((row) => [Number(row.id), row]));
      const roots = ids.filter((id) => nodeById.get(id)?.isTypeRoot);
      const kept = ids.filter((id) =>
        this.isProtected(rowById.get(id), helperIds),
      );
      if (roots.length > 0) {
        throw new ServiceError(
          ACCOUNT_ERRORS.ACCOUNT_IS_TYPE_ROOT,
          'The account is a type root and cannot be archived.',
          { accountIds: roots },
        );
      }
      if (kept.length > 0) {
        throw new ServiceError(
          ACCOUNT_ERRORS.ACCOUNT_PREDEFINED,
          kept.includes(accountId)
            ? 'The account is predefined and cannot be archived.'
            : 'An account beneath this one is predefined, so it cannot be archived.',
          { accountIds: kept },
        );
      }
    }
    const activate = await this.locator.resolve(ActivateAccount);
    const before = await this.get(accountId);

    // Bigcapital switches each account in a transaction of its own, so the
    // version is checked and raised first, in one of ours.
    await refusingStale(
      () =>
        this.uow.withTransaction((trx) =>
          raiseVersion(trx, TREE_TABLE, { accountId }, version),
        ),
      () => this.get(accountId),
    );

    // Bigcapital holds the chart flat, so each account is switched by itself.
    for (const id of ids) {
      await activate.activateAccount(id, !archived);
    }
    // Bigcapital's call runs in a transaction of its own, so the row is
    // written once it has landed.
    const logged = await this.uow.withTransaction((trx) =>
      this.logAccount(archived ? 'archive' : 'restore', accountId, before, trx),
    );
    const after = await this.get(accountId);
    await this.audit.finish(logged, after);
    return after;
  }

  /**
   * Accounts as they are shown inside a document, keyed by id.
   */
  public async briefs(
    accountIds: number[],
  ): Promise<Map<number, LedgerAccountBrief>> {
    const ids = [...new Set(accountIds)];
    const briefs = new Map<number, LedgerAccountBrief>();
    if (ids.length === 0) return briefs;

    const [accounts, nodes, metadata] = await Promise.all([
      this.tenantKnex()('accounts')
        .whereIn('id', ids)
        .select('id', 'name', 'accountType'),
      this.tree.list(),
      this.metadata.getMany(ExtRecordKind.Account, ids),
    ]);
    const nodeById = new Map(nodes.map((node) => [node.accountId, node]));

    accounts.forEach((account: any) => {
      const id = Number(account.id);
      const node = nodeById.get(id);

      briefs.set(id, {
        id,
        code: node?.code ?? null,
        name: node?.name ?? account.name,
        accountType: account.accountType,
        metadata: metadata.get(id) ?? null,
      });
    });
    return briefs;
  }

  /**
   * Throws unless every account given is part of the presented chart.
   * @throws {ServiceError} account_not_found, with the ids not found.
   */
  public async assertPresented(accountIds: number[]): Promise<void> {
    const ids = [...new Set(accountIds)];
    if (ids.length === 0) return;

    const [accounts, nodes] = await Promise.all([
      this.tenantKnex()('accounts').whereIn('id', ids).select('id'),
      this.tree.list(),
    ]);
    const existing = new Set(
      accounts.map((account: any) => Number(account.id)),
    );
    const presented = new Set(nodes.map((node) => node.accountId));
    const missing = ids.filter((id) => !existing.has(id) || !presented.has(id));

    if (missing.length > 0) {
      throw new ServiceError(
        ACCOUNT_ERRORS.ACCOUNT_NOT_FOUND,
        'An account was not found.',
        { accountIds: missing },
        HttpStatus.NOT_FOUND,
      );
    }
  }

  /**
   * Throws unless every account given can take a line: it is part of the
   * presented chart, is not a type root and is not archived.
   * @throws {ServiceError} account_not_found, ACCOUNT_IS_TYPE_ROOT or
   *   ACCOUNT_ARCHIVED, each with the ids it is about.
   */
  public async assertPostable(accountIds: number[]): Promise<void> {
    const ids = [...new Set(accountIds)];
    if (ids.length === 0) return;
    await this.assertPresented(ids);

    const [nodes, accounts] = await Promise.all([
      this.tree.list(),
      this.tenantKnex()('accounts').whereIn('id', ids).select('id', 'active'),
    ]);
    const rootIds = new Set(
      nodes.filter((node) => node.isTypeRoot).map((node) => node.accountId),
    );
    const roots = ids.filter((id) => rootIds.has(id));

    if (roots.length > 0) {
      throw new ServiceError(
        ACCOUNT_ERRORS.ACCOUNT_IS_TYPE_ROOT,
        'A type root groups accounts and takes no postings. Post to an account beneath it.',
        { accountIds: roots },
      );
    }
    const archived = accounts
      .filter((account: any) => !account.active)
      .map((account: any) => Number(account.id));

    if (archived.length > 0) {
      throw new ServiceError(
        ACCOUNT_ERRORS.ACCOUNT_ARCHIVED,
        'An account is archived and takes no new line. Restore it first.',
        { accountIds: archived },
      );
    }
  }

  /** Throws unless the account is part of the presented chart. */
  public async nodeOrThrow(
    accountId: number,
    trx?: Knex.Transaction,
  ): Promise<ExtAccountNode> {
    const node = Number.isInteger(accountId)
      ? await this.tree.get(accountId, trx)
      : null;

    if (!node) {
      throw new ServiceError(
        ACCOUNT_ERRORS.ACCOUNT_NOT_FOUND,
        'The account was not found.',
        { accountId },
        HttpStatus.NOT_FOUND,
      );
    }
    return node;
  }

  /**
   * Creates an account inside the transaction of the record it is made for,
   * as a fixed asset's or a loan's own account is.
   */
  public createWithin(
    input: {
      name: string;
      accountType: string;
      parentAccountId: number | null;
    },
    trx: Knex.Transaction,
  ): Promise<number> {
    return this.createInTransaction({ ...input, code: null }, trx);
  }

  /**
   * The root of the chart for a root type (asset, liability, ...): of the
   * accounts of that root type with no parent, the one with the most
   * accounts beneath it, and of those the first made. A chart's real root
   * holds the rest of its type; a stray top-level account holds few. Null
   * when the chart has no account of the type.
   */
  public async rootOf(
    rootType: string,
    trx?: Knex.Transaction,
  ): Promise<number | null> {
    const [nodes, accounts] = await Promise.all([
      this.tree.list(trx),
      (trx ?? this.tenantKnex())('accounts').select('id', 'accountType'),
    ]);
    const typeOf = new Map<number, string>(
      accounts.map((account: any) => [Number(account.id), account.accountType]),
    );
    const parentOf = new Map(
      nodes.map((node) => [node.accountId, node.parentAccountId]),
    );
    const beneath = new Map<number, number>();

    nodes.forEach((node) => {
      let top = node.accountId;
      // The guard bounds the walk should the tree ever hold a loop.
      for (let i = 0; i < nodes.length && parentOf.get(top); i += 1) {
        top = parentOf.get(top);
      }
      beneath.set(top, (beneath.get(top) ?? 0) + 1);
    });
    const roots = nodes
      .filter(
        (node) =>
          node.parentAccountId === null &&
          rootTypeOf(typeOf.get(node.accountId) ?? '') === rootType,
      )
      .map((node) => node.accountId)
      .sort((a, b) => (beneath.get(b) ?? 0) - (beneath.get(a) ?? 0) || a - b);
    return roots[0] ?? null;
  }

  private async createInTransaction(
    input: {
      name: string;
      code: string | null;
      accountType: string;
      parentAccountId: number | null;
      metadata?: Record<string, unknown>;
    },
    trx: Knex.Transaction,
  ): Promise<number> {
    const createAccount = await this.locator.resolve(CreateAccountService);
    // Bigcapital requires account names to be unique and bounds the code, so
    // the account is stored there under an internal name with no code.
    const created = await createAccount.createAccount(
      {
        name: this.tree.internalName(
          input.name,
          null,
          randomBytes(6).toString('hex'),
        ),
        accountType: input.accountType,
      } as any,
      trx,
    );
    await this.tree.register(
      {
        accountId: created.id,
        parentAccountId: input.parentAccountId,
        name: input.name,
        code: input.code === '' ? null : input.code,
      },
      trx,
    );
    await this.metadata.set(
      ExtRecordKind.Account,
      created.id,
      input.metadata,
      trx,
    );
    return created.id;
  }

  /**
   * A parent must be part of the chart and of the same root type (asset,
   * liability, equity, income or expense) as its child.
   */
  private async assertParentAllowed(accountType: string, parentId: number) {
    const parentNode = await this.tree.get(parentId);
    const parent = parentNode
      ? await this.tenantKnex()('accounts').where({ id: parentId }).first()
      : null;

    if (!parent) {
      throw new ServiceError(
        ACCOUNT_ERRORS.PARENT_ACCOUNT_NOT_FOUND,
        'The parent account was not found.',
        { parentId },
        HttpStatus.NOT_FOUND,
      );
    }
    if (rootTypeOf(parent.accountType) !== rootTypeOf(accountType)) {
      throw new ServiceError(
        ACCOUNT_ERRORS.PARENT_ACCOUNT_HAS_DIFFERENT_TYPE,
        `The parent account is ${rootTypeOf(parent.accountType)}, and the account is ${rootTypeOf(accountType)}.`,
      );
    }
  }

  private async assertNotCircular(accountId: number, parentId: number) {
    const nodes = await this.tree.list();
    const parentOf = new Map(
      nodes.map((node) => [node.accountId, node.parentAccountId]),
    );
    let current: number | null = parentId;
    let steps = 0;

    while (current !== null && steps <= nodes.length) {
      if (current === accountId) {
        throw new ServiceError(
          ACCOUNT_ERRORS.ACCOUNT_PARENT_CIRCULAR,
          'An account cannot be moved under itself or one of its descendants.',
        );
      }
      current = parentOf.get(current) ?? null;
      steps += 1;
    }
  }

  /** Accounts that documents or the extension itself post to by role. */
  private isProtected(account: AccountRow, helperIds: Set<number>): boolean {
    return (
      Boolean(account.predefined) ||
      SINGLE_ACCOUNT_TYPES.includes(account.accountType) ||
      helperIds.has(account.id)
    );
  }

  /**
   * The options a balance request counts by: those named of the category
   * named, or every option of it when none is named. Null when the request
   * names no category. A category or option nobody has made finds none, and
   * the balances are then all zero.
   */
  private async trackingOptionIds(
    query: ListLedgerAccountsQueryDto,
  ): Promise<number[] | null> {
    if (query.trackingCategory === undefined) {
      if (query.trackingOption !== undefined) {
        throw new ServiceError(
          ACCOUNT_ERRORS.TRACKING_OPTION_WITHOUT_CATEGORY,
          'A tracking option is named with the tracking category it belongs to.',
        );
      }
      return null;
    }
    const knex = this.tenantKnex();
    const category = await knex('tracking_categories')
      .where({ name: query.trackingCategory })
      .first();
    if (!category) return [];

    const options = knex('tracking_category_options')
      .where({ categoryId: category.id })
      .select('id');
    if (query.trackingOption !== undefined) {
      options.whereIn('name', query.trackingOption);
    }
    return (await options).map((option: any) => Number(option.id));
  }

  private async helperAccountIds(): Promise<Set<number>> {
    return this.marked.ids();
  }

  private accountRows(): Promise<AccountRow[]> {
    return this.tenantKnex()('accounts').select(
      'id',
      'name',
      'slug',
      'accountType',
      'predefined',
      'active',
    );
  }

  private async accountRowOrThrow(accountId: number): Promise<AccountRow> {
    const account = await this.tenantKnex()('accounts')
      .where({ id: accountId })
      .first();

    if (!account) {
      throw new ServiceError(
        ACCOUNT_ERRORS.ACCOUNT_NOT_FOUND,
        'The account was not found.',
        { accountId },
        HttpStatus.NOT_FOUND,
      );
    }
    return account;
  }

  /**
   * What a ledger read falls back on: the workspace's reporting basis, and
   * the day its books start, before which entries are left out unless a
   * read asks for them.
   */
  public async ledgerDefaults(): Promise<{
    basis: 'accrual' | 'cash';
    booksStartOn: string | null;
    fiscalYearStartMonth: number;
  }> {
    const workspace = await this.workspaces.findByOrganization(
      this.cls.get('organizationId'),
    );
    return {
      basis: workspace?.reportingBasis ?? 'accrual',
      booksStartOn: workspace?.booksStartOn ?? null,
      fiscalYearStartMonth: workspace?.fiscalYearStartMonth ?? 1,
    };
  }
}
