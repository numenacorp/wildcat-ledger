import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { ApiCommonHeaders } from '@/common/decorators/ApiCommonHeaders';
import { OpaqueKeys } from '@/common/decorators/OpaqueKeys';
import { LedgerWorkspaceGuard } from '../Workspaces/LedgerWorkspace.guard';
import {
  LedgerBillApplicationDto,
  LedgerBillDto,
  LedgerBillPaymentDto,
  LedgerInvoiceApplicationDto,
  LedgerInvoiceDto,
  LedgerInvoicePaymentDto,
  ListLedgerPaymentsQueryDto,
  ListLedgerBillsQueryDto,
  ListLedgerInvoicesQueryDto,
} from './LedgerBill.dto';
import {
  TradeDocumentInput,
  TradeDocumentsService,
} from './TradeDocuments.service';
import { TradePaymentsService } from './TradePayments.service';
import { LedgerInvoicePdfService } from './LedgerInvoicePdf.service';
import { CreditApplicationsService } from './CreditApplications.service';
import { BILLS, INVOICES, VENDOR_CREDITS } from './trade.config';
import { DOCUMENT_LIST_MAX_PAGE_SIZE } from './trade.constants';
import { created as answer, VersionDto } from '../common/Version.dto';
import {
  presentApplication,
  presentBill,
  presentBillPayment,
  presentDocument,
  presentInvoice,
  presentInvoicePayment,
} from './tradePresenters';

const billInput = (dto: LedgerBillDto): TradeDocumentInput => {
  const { vendorId, vendorExternalId, ...rest } = dto;
  return { ...rest, partyId: vendorId, partyExternalId: vendorExternalId };
};

const invoiceInput = (dto: LedgerInvoiceDto): TradeDocumentInput => {
  const { customerId, customerExternalId, invoiceNumber, ...rest } = dto;
  return {
    ...rest,
    partyId: customerId,
    partyExternalId: customerExternalId,
    number: invoiceNumber,
  };
};

@ApiTags('Ledger: Bills')
@Controller('ledger/bills')
@ApiCommonHeaders()
@UseGuards(LedgerWorkspaceGuard)
@OpaqueKeys('metadata')
export class LedgerBillsController {
  constructor(
    private readonly documents: TradeDocumentsService,
    private readonly payments: TradePaymentsService,
  ) {}

  @Post()
  @ApiOperation({
    summary:
      'Create a bill. A repeat of an external id with the same body answers the bill; with another body it is refused',
  })
  async create(
    @Body() dto: LedgerBillDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { document, created, replayed } = await this.documents.create(
      BILLS,
      billInput(dto),
    );
    response.status(created ? 201 : 200);
    // A bill sent with a total below zero is answered as the vendor credit
    // it was stored as.
    return answer(presentDocument(BILLS, document), replayed);
  }

  @Get()
  @ApiOperation({ summary: 'List bills, oldest first' })
  async list(@Query() query: ListLedgerBillsQueryDto) {
    const { withCredits, ...rest } = query;
    const { data, pagination } = await this.documents.list(BILLS, rest);
    const page = { data: data.map(presentBill), pagination };

    return withCredits === 'true'
      ? { ...page, credits: await this.credits() }
      : page;
  }

  /**
   * What every vendor has left to apply, oldest first: each open vendor
   * credit, then each bill payment with money left. With the open bills it
   * is what payables are made of.
   */
  private async credits() {
    const all = { page: 1, pageSize: DOCUMENT_LIST_MAX_PAGE_SIZE };
    const [credits, payments] = await Promise.all([
      this.documents.list(VENDOR_CREDITS, {
        ...all,
        status: 'open,partially_applied',
      }),
      this.payments.list(BILLS, { ...all, unapplied: 'true' }),
    ]);
    return [
      ...credits.data.map((credit) => ({
        kind: 'vendor_credit',
        id: credit.id,
        on: credit.postedOn,
        unapplied: credit.balance,
        vendor: credit.party,
      })),
      ...payments.data.map((payment) => ({
        kind: 'bill_payment',
        id: payment.id,
        on: payment.paidOn,
        unapplied: payment.unapplied,
        vendor: payment.party,
      })),
    ];
  }

  @Get(':id')
  @ApiOperation({ summary: 'Read a bill' })
  async get(@Param('id') id: string) {
    return { data: presentBill(await this.documents.get(BILLS, Number(id))) };
  }

  @Put(':id')
  @ApiOperation({ summary: 'Replace a bill with the one given' })
  async edit(@Param('id') id: string, @Body() dto: LedgerBillDto) {
    return {
      data: presentBill(
        await this.documents.edit(BILLS, Number(id), billInput(dto)),
      ),
    };
  }

  @Post(':id/void')
  @HttpCode(200)
  @ApiOperation({ summary: 'Void a bill' })
  async void(@Param('id') id: string, @Body() dto: VersionDto) {
    return {
      data: presentBill(
        await this.documents.void(BILLS, Number(id), dto?.version),
      ),
    };
  }
}

@ApiTags('Ledger: Bill Payments')
@Controller('ledger/bill-payments')
@ApiCommonHeaders()
@UseGuards(LedgerWorkspaceGuard)
@OpaqueKeys('metadata')
export class LedgerBillPaymentsController {
  constructor(
    private readonly payments: TradePaymentsService,
    private readonly applications: CreditApplicationsService,
  ) {}

  @Post(':id/applications')
  @ApiOperation({
    summary:
      'Apply what a bill payment left unapplied to a bill of the same vendor',
  })
  async apply(
    @Param('id') id: string,
    @Body() dto: LedgerBillApplicationDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { billId, ...rest } = dto;
    const { application, replayed } = await this.applications.apply(
      { config: BILLS, id: Number(id) },
      { ...rest, documentId: billId },
      async () =>
        presentBillPayment(await this.payments.get(BILLS, Number(id))),
    );
    response.status(replayed ? 200 : 201);
    return answer(presentApplication(application), replayed);
  }

  @Post()
  @ApiOperation({
    summary:
      'Create a bill payment. A repeat of an external id with the same body answers the payment; with another body it is refused',
  })
  async create(
    @Body() dto: LedgerBillPaymentDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { allocations, vendorId, ...rest } = dto;
    const { payment, created, replayed } = await this.payments.create(BILLS, {
      ...rest,
      partyId: vendorId,
      allocations: (allocations ?? []).map((a) => ({
        documentId: a.billId,
        amount: a.amount,
      })),
    });
    response.status(created ? 201 : 200);
    return answer(presentBillPayment(payment), replayed);
  }

  @Get()
  @ApiOperation({
    summary:
      'List bill payments, oldest first; with unapplied=true, those with money left to apply',
  })
  async list(@Query() query: ListLedgerPaymentsQueryDto) {
    const { vendorId, customerId: _customerId, ...rest } = query;
    const { data, pagination } = await this.payments.list(BILLS, {
      ...rest,
      partyId: vendorId,
    });
    return { data: data.map(presentBillPayment), pagination };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Read a bill payment' })
  async get(@Param('id') id: string) {
    return {
      data: presentBillPayment(await this.payments.get(BILLS, Number(id))),
    };
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a bill payment' })
  async delete(@Param('id') id: string, @Query('version') version?: string) {
    return {
      data: presentBillPayment(
        await this.payments.delete(BILLS, Number(id), version),
      ),
    };
  }
}

@ApiTags('Ledger: Invoices')
@Controller('ledger/invoices')
@ApiCommonHeaders()
@UseGuards(LedgerWorkspaceGuard)
@OpaqueKeys('metadata')
export class LedgerInvoicesController {
  constructor(
    private readonly documents: TradeDocumentsService,
    private readonly pdf: LedgerInvoicePdfService,
  ) {}

  @Get(':id/pdf')
  @ApiOperation({ summary: 'Render an invoice and answer a link to the file' })
  async pdfLink(@Param('id') id: string) {
    return { data: await this.pdf.link(Number(id)) };
  }

  @Post()
  @ApiOperation({
    summary:
      'Create an invoice. A repeat of an external id with the same body answers the invoice; with another body it is refused',
  })
  async create(
    @Body() dto: LedgerInvoiceDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { document, created, replayed } = await this.documents.create(
      INVOICES,
      invoiceInput(dto),
    );
    response.status(created ? 201 : 200);
    return answer(presentInvoice(document), replayed);
  }

  @Get()
  @ApiOperation({ summary: 'List invoices, oldest first' })
  async list(@Query() query: ListLedgerInvoicesQueryDto) {
    const { customerId, ...rest } = query;
    const { data, pagination } = await this.documents.list(INVOICES, {
      ...rest,
      partyId: customerId,
    });
    return { data: data.map(presentInvoice), pagination };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Read an invoice' })
  async get(@Param('id') id: string) {
    return {
      data: presentInvoice(await this.documents.get(INVOICES, Number(id))),
    };
  }

  @Put(':id')
  @ApiOperation({ summary: 'Replace an invoice with the one given' })
  async edit(@Param('id') id: string, @Body() dto: LedgerInvoiceDto) {
    return {
      data: presentInvoice(
        await this.documents.edit(INVOICES, Number(id), invoiceInput(dto)),
      ),
    };
  }

  @Post(':id/void')
  @HttpCode(200)
  @ApiOperation({ summary: 'Void an invoice' })
  async void(@Param('id') id: string, @Body() dto: VersionDto) {
    return {
      data: presentInvoice(
        await this.documents.void(INVOICES, Number(id), dto?.version),
      ),
    };
  }
}

@ApiTags('Ledger: Invoice Payments')
@Controller('ledger/invoice-payments')
@ApiCommonHeaders()
@UseGuards(LedgerWorkspaceGuard)
@OpaqueKeys('metadata')
export class LedgerInvoicePaymentsController {
  constructor(
    private readonly payments: TradePaymentsService,
    private readonly applications: CreditApplicationsService,
  ) {}

  @Post(':id/applications')
  @ApiOperation({
    summary:
      'Apply what an invoice payment left unapplied to an invoice of the same customer',
  })
  async apply(
    @Param('id') id: string,
    @Body() dto: LedgerInvoiceApplicationDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { invoiceId, ...rest } = dto;
    const { application, replayed } = await this.applications.apply(
      { config: INVOICES, id: Number(id) },
      { ...rest, documentId: invoiceId },
      async () =>
        presentInvoicePayment(await this.payments.get(INVOICES, Number(id))),
    );
    response.status(replayed ? 200 : 201);
    return answer(presentApplication(application), replayed);
  }

  @Post()
  @ApiOperation({
    summary:
      'Create an invoice payment. A repeat of an external id with the same body answers the payment; with another body it is refused',
  })
  async create(
    @Body() dto: LedgerInvoicePaymentDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { allocations, customerId, ...rest } = dto;
    const { payment, created, replayed } = await this.payments.create(
      INVOICES,
      {
        ...rest,
        partyId: customerId,
        allocations: (allocations ?? []).map((a) => ({
          documentId: a.invoiceId ?? null,
          accountId: a.accountId ?? null,
          memo: a.memo ?? null,
          amount: a.amount,
        })),
      },
    );
    response.status(created ? 201 : 200);
    return answer(presentInvoicePayment(payment), replayed);
  }

  @Get()
  @ApiOperation({
    summary:
      'List invoice payments, oldest first; with unapplied=true, those with money left to apply',
  })
  async list(@Query() query: ListLedgerPaymentsQueryDto) {
    const { customerId, vendorId: _vendorId, ...rest } = query;
    const { data, pagination } = await this.payments.list(INVOICES, {
      ...rest,
      partyId: customerId,
    });
    return { data: data.map(presentInvoicePayment), pagination };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Read an invoice payment' })
  async get(@Param('id') id: string) {
    return {
      data: presentInvoicePayment(
        await this.payments.get(INVOICES, Number(id)),
      ),
    };
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete an invoice payment' })
  async delete(@Param('id') id: string, @Query('version') version?: string) {
    return {
      data: presentInvoicePayment(
        await this.payments.delete(INVOICES, Number(id), version),
      ),
    };
  }
}
