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
  LedgerBillDto,
  LedgerBillPaymentDto,
  LedgerInvoiceDto,
  LedgerInvoicePaymentDto,
  ListLedgerBillsQueryDto,
  ListLedgerInvoicesQueryDto,
} from './LedgerBill.dto';
import {
  TradeDocumentInput,
  TradeDocumentsService,
} from './TradeDocuments.service';
import { TradePaymentsService } from './TradePayments.service';
import { LedgerInvoicePdfService } from './LedgerInvoicePdf.service';
import { BILLS, INVOICES } from './trade.config';
import {
  presentBill,
  presentBillPayment,
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
  constructor(private readonly documents: TradeDocumentsService) {}

  @Post()
  @ApiOperation({
    summary: 'Create a bill, or replace the one carrying the external id',
  })
  async create(
    @Body() dto: LedgerBillDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { document, created } = await this.documents.create(
      BILLS,
      billInput(dto),
    );
    response.status(created ? 201 : 200);
    return { data: presentBill(document) };
  }

  @Get()
  @ApiOperation({ summary: 'List bills, oldest first' })
  async list(@Query() query: ListLedgerBillsQueryDto) {
    const { data, pagination } = await this.documents.list(BILLS, query);
    return { data: data.map(presentBill), pagination };
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
  async void(@Param('id') id: string) {
    return { data: presentBill(await this.documents.void(BILLS, Number(id))) };
  }
}

@ApiTags('Ledger: Bill Payments')
@Controller('ledger/bill-payments')
@ApiCommonHeaders()
@UseGuards(LedgerWorkspaceGuard)
@OpaqueKeys('metadata')
export class LedgerBillPaymentsController {
  constructor(private readonly payments: TradePaymentsService) {}

  @Post()
  @ApiOperation({
    summary:
      'Create a bill payment, or replace the one carrying the external id',
  })
  async create(
    @Body() dto: LedgerBillPaymentDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { allocations, ...rest } = dto;
    const { payment, created } = await this.payments.create(BILLS, {
      ...rest,
      allocations: (allocations ?? []).map((a) => ({
        documentId: a.billId,
        amount: a.amount,
      })),
    });
    response.status(created ? 201 : 200);
    return { data: presentBillPayment(payment) };
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
  async delete(@Param('id') id: string) {
    return {
      data: presentBillPayment(await this.payments.delete(BILLS, Number(id))),
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
    summary: 'Create an invoice, or replace the one carrying the external id',
  })
  async create(
    @Body() dto: LedgerInvoiceDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { document, created } = await this.documents.create(
      INVOICES,
      invoiceInput(dto),
    );
    response.status(created ? 201 : 200);
    return { data: presentInvoice(document) };
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
  async void(@Param('id') id: string) {
    return {
      data: presentInvoice(await this.documents.void(INVOICES, Number(id))),
    };
  }
}

@ApiTags('Ledger: Invoice Payments')
@Controller('ledger/invoice-payments')
@ApiCommonHeaders()
@UseGuards(LedgerWorkspaceGuard)
@OpaqueKeys('metadata')
export class LedgerInvoicePaymentsController {
  constructor(private readonly payments: TradePaymentsService) {}

  @Post()
  @ApiOperation({
    summary:
      'Create an invoice payment, or replace the one carrying the external id',
  })
  async create(
    @Body() dto: LedgerInvoicePaymentDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { allocations, customerId, ...rest } = dto;
    const { payment, created } = await this.payments.create(INVOICES, {
      ...rest,
      partyId: customerId,
      allocations: (allocations ?? []).map((a) => ({
        documentId: a.invoiceId ?? null,
        accountId: a.accountId ?? null,
        memo: a.memo ?? null,
        amount: a.amount,
      })),
    });
    response.status(created ? 201 : 200);
    return { data: presentInvoicePayment(payment) };
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
  async delete(@Param('id') id: string) {
    return {
      data: presentInvoicePayment(
        await this.payments.delete(INVOICES, Number(id)),
      ),
    };
  }
}
