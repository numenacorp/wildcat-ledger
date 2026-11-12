import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiCommonHeaders } from '@/common/decorators/ApiCommonHeaders';
import { LedgerWorkspaceGuard } from '../Workspaces/LedgerWorkspace.guard';

/** The most bank lines one page will hold, once there are any. */
export const BANK_LINES_MAX_PAGE_SIZE = 200;

/**
 * The bank feed's place in the API, before there is a bank feed.
 *
 * A workspace has no bank accounts and no bank lines yet. These routes say
 * so in the shape the lists will have, so that a caller's bank pages open on
 * empty lists and do not fail.
 */
@ApiTags('Ledger: Bank')
@Controller('ledger/bank')
@ApiCommonHeaders()
@UseGuards(LedgerWorkspaceGuard)
export class LedgerBankController {
  @Get('transactions')
  @ApiOperation({ summary: 'List bank lines: none yet' })
  transactions(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return {
      data: [],
      pagination: {
        total: 0,
        page: Math.max(1, Number(page) || 1),
        pageSize: Math.min(
          Math.max(1, Number(pageSize) || 50),
          BANK_LINES_MAX_PAGE_SIZE,
        ),
      },
    };
  }

  @Get('accounts')
  @ApiOperation({ summary: 'List connected bank accounts: none yet' })
  accounts() {
    return { data: [] };
  }

  @Get('manual-accounts')
  @ApiOperation({ summary: 'List bank accounts kept by hand: none yet' })
  manualAccounts() {
    return { data: [] };
  }
}
