import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { ApiCommonHeaders } from '@/common/decorators/ApiCommonHeaders';
import { LedgerWorkspaceGuard } from '../Workspaces/LedgerWorkspace.guard';
import { ExtRecordKind } from '../LedgerExt.constants';
import { ExtPartiesService } from './ExtParties.service';
import { UpsertLedgerVendorDto } from './LedgerVendor.dto';

@ApiTags('Ledger: Vendors')
@Controller('ledger/vendors')
@ApiCommonHeaders()
@UseGuards(LedgerWorkspaceGuard)
export class LedgerVendorsController {
  constructor(private readonly parties: ExtPartiesService) {}

  @Post()
  @ApiOperation({
    summary:
      'Create a vendor, or replace the fields of the one carrying the external id',
  })
  async upsert(
    @Body() dto: UpsertLedgerVendorDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { party, created } = await this.parties.upsert(
      ExtRecordKind.Vendor,
      dto,
    );

    response.status(created ? 201 : 200);
    return { data: party };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Read a vendor' })
  async get(@Param('id') id: string) {
    return { data: await this.parties.get(ExtRecordKind.Vendor, Number(id)) };
  }
}

@ApiTags('Ledger: Customers')
@Controller('ledger/customers')
@ApiCommonHeaders()
@UseGuards(LedgerWorkspaceGuard)
export class LedgerCustomersController {
  constructor(private readonly parties: ExtPartiesService) {}

  @Post()
  @ApiOperation({
    summary:
      'Create a customer, or replace the fields of the one carrying the external id',
  })
  async upsert(
    @Body() dto: UpsertLedgerVendorDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { party, created } = await this.parties.upsert(
      ExtRecordKind.Customer,
      dto,
    );
    response.status(created ? 201 : 200);
    return { data: party };
  }

  @Get()
  @ApiOperation({ summary: 'List customers, in the order they were made' })
  list(@Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.parties.list(ExtRecordKind.Customer, { page, pageSize });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Read a customer' })
  async get(@Param('id') id: string) {
    return { data: await this.parties.get(ExtRecordKind.Customer, Number(id)) };
  }
}
