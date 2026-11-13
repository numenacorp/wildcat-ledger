import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsIn, IsISO8601, IsNumberString, IsOptional } from 'class-validator';
import { ApiCommonHeaders } from '@/common/decorators/ApiCommonHeaders';
import { OpaqueKeys } from '@/common/decorators/OpaqueKeys';
import { StrictDto } from '@/common/decorators/StrictDto';
import { ExtAuditService } from '../common/ExtAudit.service';
import { toInstant } from '../common/timestamps';
import { ExtRecordKind } from '../LedgerExt.constants';
import { LedgerWorkspaceGuard } from '../Workspaces/LedgerWorkspace.guard';

@StrictDto()
export class ListLedgerAuditLogQueryDto {
  @ApiProperty({
    description: 'Only rows of this kind of record',
    enum: ExtRecordKind,
    required: false,
  })
  @IsOptional()
  @IsIn(Object.values(ExtRecordKind))
  subject?: string;

  @ApiProperty({
    description: 'With subject: only rows of the record with this id',
    required: false,
  })
  @IsOptional()
  @IsNumberString({ no_symbols: true })
  subjectId?: string;

  @ApiProperty({
    description: 'Rows written at or after this instant',
    required: false,
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @ApiProperty({
    description: 'Rows written before this instant',
    required: false,
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumberString({ no_symbols: true })
  page?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumberString({ no_symbols: true })
  pageSize?: string;
}

@ApiTags('Ledger: Audit log')
@Controller('ledger/audit-log')
@ApiCommonHeaders()
@UseGuards(LedgerWorkspaceGuard)
@OpaqueKeys('metadata')
export class LedgerAuditController {
  constructor(private readonly audit: ExtAuditService) {}

  @Get()
  @ApiOperation({
    summary:
      'Every create, edit, void and delete of the ledger records, newest first, with the record before and after',
  })
  list(@Query() query: ListLedgerAuditLogQueryDto) {
    return this.audit.list({
      ...query,
      from: query.from ? toInstant(query.from) : undefined,
      to: query.to ? toInstant(query.to) : undefined,
    });
  }
}
