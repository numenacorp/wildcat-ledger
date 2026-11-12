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
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { ApiCommonHeaders } from '@/common/decorators/ApiCommonHeaders';
import { OpaqueKeys } from '@/common/decorators/OpaqueKeys';
import { LedgerWorkspaceGuard } from '../Workspaces/LedgerWorkspace.guard';
import { LedgerAccountsService } from './LedgerAccounts.service';
import {
  CreateLedgerAccountDto,
  CreateLedgerChildAccountDto,
  EditLedgerAccountDto,
  LedgerAccountResponseDto,
  ListLedgerAccountsQueryDto,
} from './LedgerAccount.dto';

@ApiTags('Ledger: Accounts')
@Controller('ledger/accounts')
@ApiCommonHeaders()
@UseGuards(LedgerWorkspaceGuard)
@OpaqueKeys('metadata')
export class LedgerAccountsController {
  constructor(private readonly accounts: LedgerAccountsService) {}

  @Get()
  @ApiOperation({
    summary:
      'List the chart of accounts with balances over a range, on either basis',
  })
  @ApiResponse({ status: 200, type: [LedgerAccountResponseDto] })
  async list(@Query() query: ListLedgerAccountsQueryDto) {
    return { data: await this.accounts.list(query) };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Retrieve an account' })
  async get(@Param('id') id: string) {
    return { data: await this.accounts.get(Number(id)) };
  }

  @Post()
  @ApiOperation({ summary: 'Create an account' })
  async create(
    @Body() dto: CreateLedgerAccountDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { account, created } = await this.accounts.create(dto);

    response.status(created ? 201 : 200);
    return { data: account };
  }

  @Post(':id/children')
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a child of an account' })
  async createChild(
    @Param('id') id: string,
    @Body() dto: CreateLedgerChildAccountDto,
  ) {
    return { data: await this.accounts.createChild(Number(id), dto) };
  }

  @Put(':id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rename, renumber or move an account' })
  async edit(@Param('id') id: string, @Body() dto: EditLedgerAccountDto) {
    return { data: await this.accounts.edit(Number(id), dto) };
  }

  @Delete(':id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Delete an account' })
  async delete(@Param('id') id: string) {
    await this.accounts.delete(Number(id));
    return { data: { id: Number(id), deleted: true } };
  }
}
