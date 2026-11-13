import {
  Body,
  Controller,
  Get,
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
import { LedgerWorkspaceGuard } from '../Workspaces/LedgerWorkspace.guard';
import { ExtRecordKind } from '../LedgerExt.constants';
import { ExtPartiesService } from './ExtParties.service';
import {
  UpdateLedgerVendorDto,
  UpsertLedgerVendorDto,
} from './LedgerVendor.dto';
import { created as answer } from '../common/Version.dto';

@ApiTags('Ledger: Vendors')
@Controller('ledger/vendors')
@ApiCommonHeaders()
@UseGuards(LedgerWorkspaceGuard)
export class LedgerVendorsController {
  constructor(private readonly parties: ExtPartiesService) {}

  @Post()
  @ApiOperation({
    summary:
      'Create a vendor. A repeat of an external id with the same fields answers the vendor; with other fields it is refused',
  })
  async create(
    @Body() dto: UpsertLedgerVendorDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { party, created, replayed } = await this.parties.create(
      ExtRecordKind.Vendor,
      dto,
    );

    response.status(created ? 201 : 200);
    return answer(party, replayed);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Replace the fields of a vendor' })
  async update(@Param('id') id: string, @Body() dto: UpdateLedgerVendorDto) {
    const { externalId: _externalId, ...fields } = dto;
    return {
      data: await this.parties.update(ExtRecordKind.Vendor, Number(id), fields),
    };
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
      'Create a customer. A repeat of an external id with the same fields answers the customer; with other fields it is refused',
  })
  async create(
    @Body() dto: UpsertLedgerVendorDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { party, created, replayed } = await this.parties.create(
      ExtRecordKind.Customer,
      dto,
    );
    response.status(created ? 201 : 200);
    return answer(party, replayed);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Replace the fields of a customer' })
  async update(@Param('id') id: string, @Body() dto: UpdateLedgerVendorDto) {
    const { externalId: _externalId, ...fields } = dto;
    return {
      data: await this.parties.update(
        ExtRecordKind.Customer,
        Number(id),
        fields,
      ),
    };
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
