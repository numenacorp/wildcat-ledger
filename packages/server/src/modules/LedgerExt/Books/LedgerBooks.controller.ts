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
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiCommonHeaders } from '@/common/decorators/ApiCommonHeaders';
import { OpaqueKeys } from '@/common/decorators/OpaqueKeys';
import { LedgerWorkspaceGuard } from '../Workspaces/LedgerWorkspace.guard';
import { LedgerFixedAssetsService } from './LedgerFixedAssets.service';
import { LedgerLoansService } from './LedgerLoans.service';
import { LedgerOpeningBalancesService } from './LedgerOpeningBalances.service';
import {
  CreateLedgerFixedAssetDto,
  CreateLedgerLoanDto,
  CreateLedgerValueUpdateDto,
  EditLedgerFixedAssetDto,
  ImportLedgerOpeningBalancesDto,
} from './LedgerBooks.dto';

@ApiTags('Ledger: Fixed assets')
@Controller('ledger/fixed-assets')
@ApiCommonHeaders()
@UseGuards(LedgerWorkspaceGuard)
@OpaqueKeys('metadata')
export class LedgerFixedAssetsController {
  constructor(private readonly assets: LedgerFixedAssetsService) {}

  @Post('value-updates')
  @ApiOperation({
    summary:
      'Record a fall in the value of a fixed asset, or return the update carrying the external id',
  })
  async createValueUpdate(@Body() dto: CreateLedgerValueUpdateDto) {
    return { data: await this.assets.createValueUpdate(dto) };
  }

  @Get('value-updates')
  @ApiOperation({ summary: 'List value updates, oldest dated first' })
  listValueUpdates(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('assetId') assetId?: string,
  ) {
    return this.assets.listValueUpdates({ page, pageSize, assetId });
  }

  @Post()
  @ApiOperation({
    summary:
      'Create a fixed asset with its own account, or return the one carrying the external id',
  })
  async create(@Body() dto: CreateLedgerFixedAssetDto) {
    return { data: await this.assets.create(dto) };
  }

  @Get()
  @ApiOperation({ summary: 'List fixed assets, oldest made first' })
  list(@Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.assets.list({ page, pageSize });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Read a fixed asset' })
  async get(@Param('id') id: string) {
    return { data: await this.assets.get(Number(id)) };
  }

  @Put(':id')
  @ApiOperation({ summary: 'Change the fields given of a fixed asset' })
  async edit(@Param('id') id: string, @Body() dto: EditLedgerFixedAssetDto) {
    return { data: await this.assets.edit(Number(id), dto) };
  }
}

@ApiTags('Ledger: Loans')
@Controller('ledger/loans')
@ApiCommonHeaders()
@UseGuards(LedgerWorkspaceGuard)
@OpaqueKeys('metadata')
export class LedgerLoansController {
  constructor(private readonly loans: LedgerLoansService) {}

  @Post()
  @ApiOperation({
    summary:
      'Create a loan with its own account, or return the one carrying the external id',
  })
  async create(@Body() dto: CreateLedgerLoanDto) {
    return { data: await this.loans.create(dto) };
  }

  @Get()
  @ApiOperation({ summary: 'List loans, oldest made first' })
  list(@Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.loans.list({ page, pageSize });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Read a loan' })
  async get(@Param('id') id: string) {
    return { data: await this.loans.get(Number(id)) };
  }
}

@ApiTags('Ledger: Opening balances')
@Controller('ledger/opening-balances')
@ApiCommonHeaders()
@UseGuards(LedgerWorkspaceGuard)
export class LedgerOpeningBalancesController {
  constructor(private readonly openings: LedgerOpeningBalancesService) {}

  @Post()
  @ApiOperation({
    summary: 'Import the opening balance of each account, all or none',
  })
  async import(@Body() dto: ImportLedgerOpeningBalancesDto) {
    return { data: { balances: await this.openings.import(dto) } };
  }

  @Get()
  @ApiOperation({ summary: 'Read the imported opening balances' })
  async list() {
    return { data: { balances: await this.openings.list() } };
  }

  @Delete()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Take the imported opening balances out of the books',
  })
  async delete() {
    await this.openings.delete();
    return { data: { balances: [] } };
  }
}
