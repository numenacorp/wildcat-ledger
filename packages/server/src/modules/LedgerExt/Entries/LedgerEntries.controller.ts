import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { isISO8601 } from 'class-validator';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiCommonHeaders } from '@/common/decorators/ApiCommonHeaders';
import { LedgerWorkspaceGuard } from '../Workspaces/LedgerWorkspace.guard';
import { LedgerEntriesService } from './LedgerEntries.service';

@ApiTags('Ledger: Entries')
@Controller('ledger')
@ApiCommonHeaders()
@UseGuards(LedgerWorkspaceGuard)
export class LedgerEntriesController {
  constructor(private readonly entries: LedgerEntriesService) {}

  @Get('entries')
  @ApiOperation({
    summary: 'The ledger entries of every kind of document, newest first',
  })
  feed(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('order') order?: string,
    @Query('basis') basis?: 'accrual' | 'cash',
    @Query('sort') sort?: string,
    @Query('includeBeforeStart') includeBeforeStart?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    if (sort !== undefined && sort !== 'posted_at') {
      throw new BadRequestException('Entries are sorted by posted_at only.');
    }
    [from, to].forEach((instant) => {
      if (instant !== undefined && !isISO8601(instant, { strict: true })) {
        throw new BadRequestException(
          'from and to must be ISO-8601 timestamps.',
        );
      }
    });
    return this.entries.feed({
      page,
      pageSize,
      order,
      basis,
      includeBeforeStart,
      from,
      to,
    });
  }

  @Get('accounts/:id/lines')
  @ApiOperation({ summary: 'The ledger lines on an account, newest first' })
  accountLines(
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('basis') basis?: 'accrual' | 'cash',
    @Query('includeBeforeStart') includeBeforeStart?: string,
  ) {
    return this.entries.accountLines(Number(id), {
      page,
      pageSize,
      basis,
      includeBeforeStart,
    });
  }
}
