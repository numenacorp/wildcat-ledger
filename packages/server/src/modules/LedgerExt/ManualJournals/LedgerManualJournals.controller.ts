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
import { LedgerManualJournalsService } from './LedgerManualJournals.service';
import {
  BulkLedgerManualJournalsDto,
  LedgerManualJournalDto,
  ListLedgerManualJournalsQueryDto,
} from './LedgerManualJournal.dto';

import { created as answer } from '../common/Version.dto';
@ApiTags('Ledger: Manual Journals')
@Controller('ledger/manual-journals')
@ApiCommonHeaders()
@UseGuards(LedgerWorkspaceGuard)
@OpaqueKeys('metadata')
export class LedgerManualJournalsController {
  constructor(private readonly journals: LedgerManualJournalsService) {}

  @Post()
  @ApiOperation({
    summary:
      'Create a published manual journal. A repeat of an external id with the same body answers the journal; with another body it is refused',
  })
  async create(
    @Body() dto: LedgerManualJournalDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { journal, created, replayed } = await this.journals.create(dto);

    response.status(created ? 201 : 200);
    return answer(journal, replayed);
  }

  @Post('bulk')
  @HttpCode(201)
  @ApiOperation({ summary: 'Create several manual journals, all or none' })
  async createBulk(@Body() dto: BulkLedgerManualJournalsDto) {
    return { data: { journals: await this.journals.createBulk(dto.journals) } };
  }

  @Get()
  @ApiOperation({ summary: 'List manual journals, oldest first' })
  list(@Query() query: ListLedgerManualJournalsQueryDto) {
    return this.journals.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Retrieve a manual journal' })
  async get(@Param('id') id: string) {
    return { data: await this.journals.get(Number(id)) };
  }

  @Put(':id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Replace a manual journal, keeping its id' })
  async edit(@Param('id') id: string, @Body() dto: LedgerManualJournalDto) {
    return { data: await this.journals.edit(Number(id), dto) };
  }

  @Delete(':id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Delete a manual journal' })
  async delete(@Param('id') id: string, @Query('version') version?: string) {
    await this.journals.delete(Number(id), version);
    return { data: { id: Number(id), deleted: true } };
  }
}
