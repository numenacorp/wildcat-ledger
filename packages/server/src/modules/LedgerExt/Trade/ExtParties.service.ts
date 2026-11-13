import { randomBytes } from 'crypto';
import {
  raiseVersion,
  refusingStale,
  requireVersion,
} from '../common/versions';
import { Knex } from 'knex';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { ServiceError } from '@/modules/Items/ServiceError';
import { TENANCY_DB_CONNECTION } from '@/modules/Tenancy/TenancyDB/TenancyDB.constants';
import { CreateVendorService } from '@/modules/Vendors/commands/CreateVendor.service';
import { CreateCustomer } from '@/modules/Customers/commands/CreateCustomer.service';
import { ExtUnitOfWork } from '../common/ExtUnitOfWork.service';
import { ExternalIdsService } from '../common/ExternalIds.service';
import { ExtServiceLocator } from '../common/ExtServiceLocator.service';
import { ERRORS, ExtRecordKind } from '../LedgerExt.constants';
import { LedgerWorkspacesService } from '../Workspaces/LedgerWorkspaces.service';
import { TRADE_ERRORS } from './trade.constants';

const TABLE = 'ext_parties';

/** A vendor or a customer. */
export type PartyKind = ExtRecordKind.Vendor | ExtRecordKind.Customer;

/** What a caller says about a vendor or customer. Every field is optional. */
export interface PartyFields {
  companyName?: string | null;
  individualName?: string | null;
  email?: string | null;
  mobilePhone?: string | null;
  officePhone?: string | null;
  addressString?: string | null;
  notes?: string | null;
}

export interface PartyView {
  id: number;
  externalId: string | null;
  companyName: string | null;
  individualName: string | null;
  email: string | null;
  mobilePhone: string | null;
  officePhone: string | null;
  addressString: string | null;
  notes: string | null;
  active: boolean;
  /** Raised by every change to the party's fields. */
  version: number;
}

const FIELDS: Array<keyof PartyFields> = [
  'companyName',
  'individualName',
  'email',
  'mobilePhone',
  'officePhone',
  'addressString',
  'notes',
];

/**
 * Vendors and customers as callers describe them.
 *
 * Each is a contact in Bigcapital, which carries its balance, under a name of
 * the extension's own making: Bigcapital requires a display name, and a
 * caller need give none. What the caller said is kept here as it was said.
 */
@Injectable()
export class ExtPartiesService {
  constructor(
    @Inject(TENANCY_DB_CONNECTION)
    private readonly tenantKnex: () => Knex,
    private readonly cls: ClsService,
    private readonly uow: ExtUnitOfWork,
    private readonly externalIds: ExternalIdsService,
    private readonly locator: ExtServiceLocator,
    private readonly workspaces: LedgerWorkspacesService,
  ) {}

  /**
   * Creates a party. A create carrying the external id of an existing party
   * is a retry when its fields are the ones the party was made with, and is
   * answered with the party; otherwise it is refused, and the party is
   * changed through `update`.
   * @throws {ServiceError} EXTERNAL_ID_IN_USE
   */
  public async create(
    kind: PartyKind,
    fields: PartyFields & { externalId?: string | null },
  ): Promise<{ party: PartyView; created: boolean; replayed: boolean }> {
    const { recordId, created, replayed } = await this.externalIds.createOnce({
      kind,
      externalId: fields.externalId,
      body: fields,
      describe: async (id) => ({
        state: 'live' as const,
        version: (await this.get(kind, id)).version,
      }),
      create: (trx) => this.createInTransaction(kind, fields, trx),
      read: async (id) => id,
    });
    return { party: await this.get(kind, recordId), created, replayed };
  }

  /**
   * Replaces the fields of a party with the ones given.
   * @throws {ServiceError} VERSION_REQUIRED, STALE_VERSION
   */
  public async update(
    kind: PartyKind,
    partyId: number,
    fields: PartyFields & { version?: number | null },
  ): Promise<PartyView> {
    await this.get(kind, partyId);
    const version = requireVersion(fields.version);

    await refusingStale(
      () =>
        this.uow.withTransaction(async (trx) => {
          await raiseVersion(trx, TABLE, { contactId: partyId, kind }, version);
          await trx(TABLE)
            .where({ contactId: partyId, kind })
            .update({ ...this.columns(fields), updatedAt: trx.fn.now() });
          // The same fields sent again under the party's external id are a
          // retry of what it now holds, not a change.
          const { version: _version, ...held } = fields;
          await this.externalIds.rehash(
            kind,
            partyId,
            (externalId) => ({ ...held, externalId }),
            trx,
          );
        }),
      () => this.get(kind, partyId),
    );
    return this.get(kind, partyId);
  }

  /**
   * The id of the party carrying the external id, made with no name when
   * there is none yet.
   */
  public async ensure(
    kind: PartyKind,
    externalId: string,
    trx: Knex.Transaction,
  ): Promise<number> {
    try {
      const { recordId } = await this.externalIds.createOnce({
        kind,
        externalId,
        // Made from its id alone: whichever party holds the id is the one meant.
        anyBody: true,
        create: (innerTrx) => this.createInTransaction(kind, {}, innerTrx),
        read: async (id) => id,
        trx,
      });
      return recordId;
    } catch (error: any) {
      // Only a clash of the external id is answered here. Anything else,
      // a deadlock above all, has ended the transaction and must be raised.
      if (
        !(error instanceof ServiceError) ||
        error.errorType !== ERRORS.EXTERNAL_ID_IN_USE
      ) {
        throw error;
      }
      // Another write made the party at the same moment and has committed:
      // that party is the one meant.
      const winnerId = await this.externalIds.findRecordId(
        kind,
        externalId,
        trx,
      );
      if (winnerId === null) throw error;
      return winnerId;
    }
  }

  /** The id of the party carrying the external id, or null. */
  public findByExternalId(
    kind: PartyKind,
    externalId: string,
    trx?: Knex.Transaction,
  ): Promise<number | null> {
    return this.externalIds.findRecordId(kind, externalId, trx);
  }

  public async get(
    kind: PartyKind,
    partyId: number,
    trx?: Knex.Transaction,
  ): Promise<PartyView> {
    const party = Number.isInteger(partyId)
      ? (await this.views(kind, [partyId], trx)).get(partyId)
      : undefined;

    if (!party) this.notFound(kind, { id: partyId });
    return party;
  }

  /**
   * @throws {ServiceError} vendor_not_found or customer_not_found.
   */
  public notFound(
    kind: PartyKind,
    named: { id?: number; externalId?: string },
  ): never {
    const vendor = kind === ExtRecordKind.Vendor;

    throw new ServiceError(
      vendor ? TRADE_ERRORS.VENDOR_NOT_FOUND : TRADE_ERRORS.CUSTOMER_NOT_FOUND,
      `The ${vendor ? 'vendor' : 'customer'} was not found.`,
      {
        ...(named.id !== undefined
          ? { [vendor ? 'vendorId' : 'customerId']: named.id }
          : {}),
        ...(named.externalId !== undefined
          ? { externalId: named.externalId }
          : {}),
      },
      HttpStatus.NOT_FOUND,
    );
  }

  /**
   * Lists the parties of a kind, in the order they were made.
   */
  public async list(
    kind: PartyKind,
    query: { page?: string | number; pageSize?: string | number },
  ): Promise<{
    data: PartyView[];
    pagination: { total: number; page: number; pageSize: number };
  }> {
    const page = Math.max(1, Number(query.page) || 1);
    const pageSize = Math.min(Math.max(1, Number(query.pageSize) || 50), 200);
    const knex = this.tenantKnex();
    const [{ total }] = await knex(TABLE).where({ kind }).count({ total: '*' });
    const rows = await knex(TABLE)
      .where({ kind })
      .orderBy('contactId')
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .select('contactId');
    const ids = rows.map((row: any) => Number(row.contactId));
    const views = await this.views(kind, ids);

    return {
      data: ids.map((id) => views.get(id)),
      pagination: { total: Number(total), page, pageSize },
    };
  }

  /**
   * Parties of a kind, keyed by id.
   */
  public async views(
    kind: PartyKind,
    partyIds: number[],
    trx?: Knex.Transaction,
  ): Promise<Map<number, PartyView>> {
    const ids = [...new Set(partyIds)];
    const views = new Map<number, PartyView>();
    if (ids.length === 0) return views;

    const [rows, externalIds] = await Promise.all([
      (trx ?? this.tenantKnex())(TABLE)
        .where({ kind })
        .whereIn('contactId', ids),
      this.externalIds.findExternalIds(kind, ids, trx),
    ]);
    rows.forEach((row: any) => {
      const id = Number(row.contactId);

      views.set(id, {
        id,
        externalId: externalIds.get(id) ?? null,
        companyName: row.companyName ?? null,
        individualName: row.individualName ?? null,
        email: row.email ?? null,
        mobilePhone: row.mobilePhone ?? null,
        officePhone: row.officePhone ?? null,
        addressString: row.addressString ?? null,
        notes: row.notes ?? null,
        active: true,
        version: Number(row.version),
      });
    });
    return views;
  }

  /** Whether each contact given is a vendor or a customer; others are left out. */
  public async kindsOf(contactIds: number[]): Promise<Map<number, PartyKind>> {
    const kinds = new Map<number, PartyKind>();
    if (contactIds.length === 0) return kinds;

    const rows = await this.tenantKnex()(TABLE)
      .whereIn('contactId', contactIds)
      .select('contactId', 'kind');
    rows.forEach((row: any) => kinds.set(Number(row.contactId), row.kind));
    return kinds;
  }

  private async createInTransaction(
    kind: PartyKind,
    fields: PartyFields,
    trx: Knex.Transaction,
  ): Promise<number> {
    const workspace = await this.workspaces.findByOrganization(
      this.cls.get('organizationId'),
    );
    const token = randomBytes(6).toString('hex');
    let contact: any;

    if (kind === ExtRecordKind.Vendor) {
      const createVendor = await this.locator.resolve(CreateVendorService);
      contact = await createVendor.createVendor(
        {
          displayName: `Vendor ${token}`,
          currencyCode: workspace?.baseCurrency,
        } as any,
        trx,
      );
    } else {
      const createCustomer = await this.locator.resolve(CreateCustomer);
      contact = await createCustomer.createCustomer(
        {
          customerType: 'business',
          displayName: `Customer ${token}`,
          currencyCode: workspace?.baseCurrency,
        } as any,
        trx,
      );
    }
    await trx(TABLE).insert({
      contactId: contact.id,
      kind,
      ...this.columns(fields),
      createdAt: trx.fn.now(),
      updatedAt: trx.fn.now(),
    });
    return contact.id;
  }

  /** Every field, the ones not given as null: an upsert replaces them all. */
  private columns(fields: PartyFields): Record<string, string | null> {
    return Object.fromEntries(
      FIELDS.map((field) => [field, fields[field] ?? null]),
    );
  }
}
