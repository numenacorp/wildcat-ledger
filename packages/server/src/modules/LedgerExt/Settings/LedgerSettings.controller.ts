import {
  Body,
  Controller,
  Get,
  HttpCode,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsIn, IsISO8601, IsOptional, ValidateIf } from 'class-validator';
import { ClsService } from 'nestjs-cls';
import { ApiCommonHeaders } from '@/common/decorators/ApiCommonHeaders';
import { StrictDto } from '@/common/decorators/StrictDto';
import { LedgerWorkspaceGuard } from '../Workspaces/LedgerWorkspace.guard';
import { LedgerWorkspacesService } from '../Workspaces/LedgerWorkspaces.service';
import { ExtLockService } from '../Lock/ExtLock.service';

@StrictDto()
export class UpdateLedgerSettingsDto {
  @ApiProperty({
    description:
      'Everything dated before this instant is locked; null clears the lock',
    required: false,
    nullable: true,
  })
  @ValidateIf((dto) => dto.closingAt !== null && dto.closingAt !== undefined)
  @IsISO8601({ strict: true })
  closingAt?: string | null;

  @ApiProperty({ enum: ['accrual', 'cash'], required: false })
  @IsOptional()
  @IsIn(['accrual', 'cash'])
  reportingBasis?: 'accrual' | 'cash';
}

@ApiTags('Ledger: Settings')
@Controller('ledger/settings')
@ApiCommonHeaders()
@UseGuards(LedgerWorkspaceGuard)
export class LedgerSettingsController {
  constructor(
    private readonly cls: ClsService,
    private readonly lock: ExtLockService,
    private readonly workspaces: LedgerWorkspacesService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'The closing instant and reporting basis of the books',
  })
  async get() {
    return { data: await this.read() };
  }

  @Put()
  @HttpCode(200)
  @ApiOperation({ summary: 'Set the closing instant or the reporting basis' })
  async update(@Body() dto: UpdateLedgerSettingsDto) {
    if (dto.closingAt !== undefined) {
      await this.lock.setClosingAt(dto.closingAt);
    }
    if (dto.reportingBasis !== undefined) {
      await this.workspaces.setReportingBasis(
        this.cls.get('organizationId'),
        dto.reportingBasis,
      );
    }
    return { data: await this.read() };
  }

  private async read() {
    const workspace = await this.workspaces.findByOrganization(
      this.cls.get('organizationId'),
    );
    return {
      closingAt: await this.lock.getClosingAt(),
      reportingBasis: workspace?.reportingBasis ?? 'accrual',
    };
  }
}
