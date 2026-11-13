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
import { created as answer, VersionDto } from '../common/Version.dto';
import { CreditApplicationsService } from './CreditApplications.service';
import {
  LedgerBillApplicationDto,
  LedgerBillDto,
  LedgerCreditNoteDto,
  LedgerInvoiceApplicationDto,
  ListLedgerCreditNotesQueryDto,
  ListLedgerVendorCreditsQueryDto,
} from './LedgerBill.dto';
import {
  TradeDocumentInput,
  TradeDocumentsService,
} from './TradeDocuments.service';
import { CREDIT_NOTES, VENDOR_CREDITS } from './trade.config';
import {
  presentApplication,
  presentCreditNote,
  presentVendorCredit,
} from './tradePresenters';

const vendorCreditInput = (dto: LedgerBillDto): TradeDocumentInput => {
  const { vendorId, vendorExternalId, ...rest } = dto;
  return { ...rest, partyId: vendorId, partyExternalId: vendorExternalId };
};

const creditNoteInput = (dto: LedgerCreditNoteDto): TradeDocumentInput => {
  const { customerId, customerExternalId, creditNoteNumber, ...rest } = dto;
  return {
    ...rest,
    partyId: customerId,
    partyExternalId: customerExternalId,
    number: creditNoteNumber,
  };
};

@ApiTags('Ledger: Vendor Credits')
@Controller('ledger/vendor-credits')
@ApiCommonHeaders()
@UseGuards(LedgerWorkspaceGuard)
@OpaqueKeys('metadata')
export class LedgerVendorCreditsController {
  constructor(
    private readonly documents: TradeDocumentsService,
    private readonly applications: CreditApplicationsService,
  ) {}

  @Post()
  @ApiOperation({
    summary:
      'Create a vendor credit, its amounts positive. A repeat of an external id with the same body answers the credit; with another body it is refused',
  })
  async create(
    @Body() dto: LedgerBillDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { document, created, replayed } = await this.documents.create(
      VENDOR_CREDITS,
      vendorCreditInput(dto),
    );
    response.status(created ? 201 : 200);
    return answer(presentVendorCredit(document), replayed);
  }

  @Get()
  @ApiOperation({ summary: 'List vendor credits, oldest first' })
  async list(@Query() query: ListLedgerVendorCreditsQueryDto) {
    const { vendorId, ...rest } = query;
    const { data, pagination } = await this.documents.list(VENDOR_CREDITS, {
      ...rest,
      partyId: vendorId,
    });
    return { data: data.map(presentVendorCredit), pagination };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Read a vendor credit' })
  async get(@Param('id') id: string) {
    return {
      data: presentVendorCredit(
        await this.documents.get(VENDOR_CREDITS, Number(id)),
      ),
    };
  }

  @Put(':id')
  @ApiOperation({ summary: 'Replace a vendor credit with the one given' })
  async edit(@Param('id') id: string, @Body() dto: LedgerBillDto) {
    return {
      data: presentVendorCredit(
        await this.documents.edit(
          VENDOR_CREDITS,
          Number(id),
          vendorCreditInput(dto),
        ),
      ),
    };
  }

  @Post(':id/void')
  @HttpCode(200)
  @ApiOperation({ summary: 'Void a vendor credit' })
  async void(@Param('id') id: string, @Body() dto: VersionDto) {
    return {
      data: presentVendorCredit(
        await this.documents.void(VENDOR_CREDITS, Number(id), dto?.version),
      ),
    };
  }

  @Post(':id/applications')
  @ApiOperation({
    summary: 'Apply a vendor credit to a bill of the same vendor',
  })
  async apply(
    @Param('id') id: string,
    @Body() dto: LedgerBillApplicationDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { billId, ...rest } = dto;
    const { application, replayed } = await this.applications.apply(
      { config: VENDOR_CREDITS, id: Number(id) },
      { ...rest, documentId: billId },
      async () =>
        presentVendorCredit(
          await this.documents.get(VENDOR_CREDITS, Number(id)),
        ),
    );
    response.status(replayed ? 200 : 201);
    return answer(presentApplication(application), replayed);
  }
}

@ApiTags('Ledger: Credit Notes')
@Controller('ledger/credit-notes')
@ApiCommonHeaders()
@UseGuards(LedgerWorkspaceGuard)
@OpaqueKeys('metadata')
export class LedgerCreditNotesController {
  constructor(
    private readonly documents: TradeDocumentsService,
    private readonly applications: CreditApplicationsService,
  ) {}

  @Post()
  @ApiOperation({
    summary:
      'Create a customer credit note, its amounts positive. A repeat of an external id with the same body answers the credit note; with another body it is refused',
  })
  async create(
    @Body() dto: LedgerCreditNoteDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { document, created, replayed } = await this.documents.create(
      CREDIT_NOTES,
      creditNoteInput(dto),
    );
    response.status(created ? 201 : 200);
    return answer(presentCreditNote(document), replayed);
  }

  @Get()
  @ApiOperation({ summary: 'List credit notes, oldest first' })
  async list(@Query() query: ListLedgerCreditNotesQueryDto) {
    const { customerId, ...rest } = query;
    const { data, pagination } = await this.documents.list(CREDIT_NOTES, {
      ...rest,
      partyId: customerId,
    });
    return { data: data.map(presentCreditNote), pagination };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Read a credit note' })
  async get(@Param('id') id: string) {
    return {
      data: presentCreditNote(
        await this.documents.get(CREDIT_NOTES, Number(id)),
      ),
    };
  }

  @Put(':id')
  @ApiOperation({ summary: 'Replace a credit note with the one given' })
  async edit(@Param('id') id: string, @Body() dto: LedgerCreditNoteDto) {
    return {
      data: presentCreditNote(
        await this.documents.edit(
          CREDIT_NOTES,
          Number(id),
          creditNoteInput(dto),
        ),
      ),
    };
  }

  @Post(':id/void')
  @HttpCode(200)
  @ApiOperation({ summary: 'Void a credit note' })
  async void(@Param('id') id: string, @Body() dto: VersionDto) {
    return {
      data: presentCreditNote(
        await this.documents.void(CREDIT_NOTES, Number(id), dto?.version),
      ),
    };
  }

  @Post(':id/applications')
  @ApiOperation({
    summary: 'Apply a credit note to an invoice of the same customer',
  })
  async apply(
    @Param('id') id: string,
    @Body() dto: LedgerInvoiceApplicationDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { invoiceId, ...rest } = dto;
    const { application, replayed } = await this.applications.apply(
      { config: CREDIT_NOTES, id: Number(id) },
      { ...rest, documentId: invoiceId },
      async () =>
        presentCreditNote(await this.documents.get(CREDIT_NOTES, Number(id))),
    );
    response.status(replayed ? 200 : 201);
    return answer(presentApplication(application), replayed);
  }
}

@ApiTags('Ledger: Credit Applications')
@Controller('ledger/credit-applications')
@ApiCommonHeaders()
@UseGuards(LedgerWorkspaceGuard)
export class LedgerCreditApplicationsController {
  constructor(private readonly applications: CreditApplicationsService) {}

  @Get(':id')
  @ApiOperation({ summary: 'Read a credit application' })
  async get(@Param('id') id: string) {
    return {
      data: presentApplication(await this.applications.get(Number(id))),
    };
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a credit application' })
  async delete(@Param('id') id: string, @Query('version') version?: string) {
    return {
      data: presentApplication(
        await this.applications.delete(Number(id), version),
      ),
    };
  }
}
