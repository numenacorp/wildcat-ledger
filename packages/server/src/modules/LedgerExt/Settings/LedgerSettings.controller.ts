import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import {
  IsIn,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { ClsService } from 'nestjs-cls';
import { ApiCommonHeaders } from '@/common/decorators/ApiCommonHeaders';
import { StrictDto } from '@/common/decorators/StrictDto';
import { LedgerWorkspaceGuard } from '../Workspaces/LedgerWorkspace.guard';
import { LedgerWorkspacesService } from '../Workspaces/LedgerWorkspaces.service';
import {
  ExtLockService,
  LOCK_REASON_MAX_LENGTH,
} from '../Lock/ExtLock.service';

@StrictDto()
export class UpdateLedgerSettingsDto {
  @ApiProperty({
    description:
      'The last locked day, a plain date: nothing dated on or before it can be written. Null clears the lock',
    required: false,
    nullable: true,
  })
  @ValidateIf(
    (dto) => dto.lockedThrough !== null && dto.lockedThrough !== undefined,
  )
  @IsString()
  lockedThrough?: string | null;

  @ApiProperty({ enum: ['accrual', 'cash'], required: false })
  @IsOptional()
  @IsIn(['accrual', 'cash'])
  reportingBasis?: 'accrual' | 'cash';
}

@StrictDto()
export class CreateLockExceptionDto {
  @ApiProperty({ description: 'The first day opened, a plain date' })
  @IsString()
  from: string;

  @ApiProperty({ description: 'The last day opened, a plain date' })
  @IsString()
  to: string;

  @ApiProperty({ description: 'Why the days are opened' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(LOCK_REASON_MAX_LENGTH)
  reason: string;

  @ApiProperty({ description: 'When the exception ends, a timestamp' })
  @IsISO8601({ strict: true })
  expiresAt: string;
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
    summary: 'The last locked day and the reporting basis of the books',
  })
  async get() {
    return { data: await this.read() };
  }

  @Put()
  @HttpCode(200)
  @ApiOperation({ summary: 'Set the last locked day or the reporting basis' })
  async update(@Body() dto: UpdateLedgerSettingsDto) {
    if (dto.lockedThrough !== undefined) {
      await this.lock.setLockedThrough(dto.lockedThrough);
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
      lockedThrough: await this.lock.getLockedThrough(),
      reportingBasis: workspace?.reportingBasis ?? 'accrual',
    };
  }
}

@ApiTags('Ledger: Settings')
@Controller('ledger/lock-exceptions')
@ApiCommonHeaders()
@UseGuards(LedgerWorkspaceGuard)
export class LedgerLockExceptionsController {
  constructor(private readonly lock: ExtLockService) {}

  @Get()
  @ApiOperation({ summary: 'Every lock exception, active or not' })
  async list() {
    return { data: await this.lock.listExceptions() };
  }

  @Post()
  @ApiOperation({
    summary: 'Open a range of locked days until a time, for a correction',
  })
  async create(@Body() dto: CreateLockExceptionDto) {
    return { data: await this.lock.createException(dto) };
  }

  @Post(':id/revoke')
  @HttpCode(200)
  @ApiOperation({ summary: 'End a lock exception before it expires' })
  async revoke(@Param('id', ParseIntPipe) id: number) {
    return { data: await this.lock.revokeException(id) };
  }
}
