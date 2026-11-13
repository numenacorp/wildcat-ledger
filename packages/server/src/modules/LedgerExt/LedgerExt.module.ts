import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { OrganizationBuildQueue } from '../Organization/Organization.types';
import { TenancyModule } from '../Tenancy/Tenancy.module';
import { TenancyDatabaseModule } from '../Tenancy/TenancyDB/TenancyDB.module';
import { ExtUnitOfWork } from './common/ExtUnitOfWork.service';
import { ExternalIdsService } from './common/ExternalIds.service';
import { ExtMetadataService } from './common/ExtMetadata.service';
import { ExtDocumentsService } from './common/ExtDocuments.service';
import { ExtLinesService } from './common/ExtLines.service';
import { ExtSettingsService } from './common/ExtSettings.service';
import { ExtServiceLocator } from './common/ExtServiceLocator.service';
import { ExtAccountTreeService } from './Accounts/ExtAccountTree.service';
import { ProvisionWorkspaceService } from './Workspaces/ProvisionWorkspace.service';
import { LedgerWorkspacesService } from './Workspaces/LedgerWorkspaces.service';
import { LedgerWorkspacesController } from './Workspaces/LedgerWorkspaces.controller';
import { LedgerWorkspaceGuard } from './Workspaces/LedgerWorkspace.guard';
import { LedgerRowsService } from './common/LedgerRows.service';
import { LedgerAccountsService } from './Accounts/LedgerAccounts.service';
import { LedgerAccountsController } from './Accounts/LedgerAccounts.controller';
import { ExtSequencesService } from './common/ExtSequences.service';
import { ExtTrackingService } from './Tracking/ExtTracking.service';
import { LedgerBankController } from './Bank/LedgerBank.controller';
import { OpeningEntriesService } from './Books/OpeningEntries.service';
import { LedgerFixedAssetsService } from './Books/LedgerFixedAssets.service';
import { LedgerLoansService } from './Books/LedgerLoans.service';
import { LedgerOpeningBalancesService } from './Books/LedgerOpeningBalances.service';
import {
  LedgerFixedAssetsController,
  LedgerLoansController,
  LedgerOpeningBalancesController,
} from './Books/LedgerBooks.controller';
import { LedgerTrackingCategoriesService } from './Tracking/LedgerTrackingCategories.service';
import { LedgerTrackingLinksService } from './Tracking/LedgerTrackingLinks.service';
import {
  LedgerTrackingCategoriesController,
  LedgerTrackingLinksController,
} from './Tracking/LedgerTracking.controller';
import { ExtLockService } from './Lock/ExtLock.service';
import { LedgerManualJournalsService } from './ManualJournals/LedgerManualJournals.service';
import { LedgerManualJournalsController } from './ManualJournals/LedgerManualJournals.controller';
import { LedgerEntriesService } from './Entries/LedgerEntries.service';
import { LedgerEntriesController } from './Entries/LedgerEntries.controller';
import {
  LedgerLockExceptionsController,
  LedgerSettingsController,
} from './Settings/LedgerSettings.controller';
import { LedgerPostingsService } from './common/LedgerPostings.service';
import { ExtMarkedAccountsService } from './Accounts/ExtMarkedAccounts.service';
import { ExtPartiesService } from './Trade/ExtParties.service';
import { TradeLedgerService } from './Trade/TradeLedger.service';
import { CreditApplicationsService } from './Trade/CreditApplications.service';
import {
  LedgerCreditApplicationsController,
  LedgerCreditNotesController,
  LedgerVendorCreditsController,
} from './Trade/LedgerCredits.controller';
import { TradePaymentViewsService } from './Trade/TradePaymentViews.service';
import { TradeDocumentsService } from './Trade/TradeDocuments.service';
import { TradePaymentsService } from './Trade/TradePayments.service';
import { LedgerInvoicePdfService } from './Trade/LedgerInvoicePdf.service';
import {
  LedgerCustomersController,
  LedgerVendorsController,
} from './Trade/LedgerVendors.controller';
import {
  LedgerBillPaymentsController,
  LedgerBillsController,
  LedgerInvoicePaymentsController,
  LedgerInvoicesController,
} from './Trade/LedgerBills.controller';

import { ExtAuditService } from './common/ExtAudit.service';
import { LedgerAuditController } from './Audit/LedgerAudit.controller';

const shared = [
  ExtAuditService,
  ExtUnitOfWork,
  ExternalIdsService,
  ExtMetadataService,
  ExtDocumentsService,
  ExtLinesService,
  ExtSettingsService,
  ExtServiceLocator,
  ExtAccountTreeService,
  LedgerRowsService,
  ExtSequencesService,
  LedgerPostingsService,
  ExtMarkedAccountsService,
];

/**
 * The ledger extension: operations for running Bigcapital as an embedded
 * ledger behind another application.
 *
 * Its routes sit under `/api/ledger`, its tables are prefixed `ext_`, and it
 * calls Bigcapital's own services inside one transaction per operation.
 */
@Module({
  imports: [
    TenancyModule,
    TenancyDatabaseModule,
    BullModule.registerQueue({ name: OrganizationBuildQueue }),
  ],
  controllers: [
    LedgerAuditController,
    LedgerWorkspacesController,
    // Before the accounts controller: `accounts/:id/lines` is declared here.
    LedgerEntriesController,
    LedgerAccountsController,
    LedgerManualJournalsController,
    LedgerSettingsController,
    LedgerLockExceptionsController,
    LedgerVendorsController,
    LedgerCustomersController,
    LedgerBillPaymentsController,
    LedgerBillsController,
    LedgerVendorCreditsController,
    LedgerCreditNotesController,
    LedgerCreditApplicationsController,
    LedgerInvoicePaymentsController,
    LedgerInvoicesController,
    LedgerTrackingCategoriesController,
    LedgerTrackingLinksController,
    LedgerFixedAssetsController,
    LedgerLoansController,
    LedgerOpeningBalancesController,
    LedgerBankController,
  ],
  providers: [
    ...shared,
    ProvisionWorkspaceService,
    LedgerWorkspacesService,
    LedgerWorkspaceGuard,
    LedgerAccountsService,
    ExtTrackingService,
    ExtLockService,
    LedgerManualJournalsService,
    LedgerEntriesService,
    ExtPartiesService,
    TradeLedgerService,
    CreditApplicationsService,
    TradePaymentViewsService,
    TradeDocumentsService,
    TradePaymentsService,
    LedgerInvoicePdfService,
    LedgerTrackingCategoriesService,
    LedgerTrackingLinksService,
    OpeningEntriesService,
    LedgerFixedAssetsService,
    LedgerLoansService,
    LedgerOpeningBalancesService,
  ],
  exports: [...shared],
})
export class LedgerExtModule {}
