import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { StrictDto } from '@/common/decorators/StrictDto';
import { EXTERNAL_ID_MAX_LENGTH } from '../LedgerExt.constants';

/** A non-negative decimal amount with up to three decimal places. */
export const AMOUNT_PATTERN = /^\d{1,10}(\.\d{1,3})?$/;

/** The most lines one journal may hold. */
export const JOURNAL_MAX_ENTRIES = 1000;

/** The most journals one bulk request may create. */
export const BULK_MAX_JOURNALS = 5000;

@StrictDto()
export class LedgerTrackingDto {
  @ApiProperty({ description: 'The name of the tracking category' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  category: string;

  @ApiProperty({ description: 'The name of the option of that category' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  option: string;

  @ApiProperty({
    description:
      'The name the option is shown under; taken when the option is new',
    required: false,
  })
  @ValidateIf((dto) => dto.optionName !== null && dto.optionName !== undefined)
  @IsString()
  @MaxLength(255)
  optionName?: string | null;
}

@StrictDto()
export class LedgerManualJournalEntryDto {
  @ApiProperty()
  @IsInt()
  accountId: number;

  @ApiProperty({
    description: 'A decimal string; zero when the line is a credit',
  })
  @IsString()
  @Matches(AMOUNT_PATTERN)
  debit: string;

  @ApiProperty({
    description: 'A decimal string; zero when the line is a debit',
  })
  @IsString()
  @Matches(AMOUNT_PATTERN)
  credit: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  note?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(EXTERNAL_ID_MAX_LENGTH)
  externalId?: string;

  @ApiProperty({ type: [LedgerTrackingDto], required: false })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LedgerTrackingDto)
  tracking?: LedgerTrackingDto[];
}

@StrictDto()
export class LedgerManualJournalDto {
  @ApiProperty({ required: false })
  @ValidateIf((dto) => dto.externalId !== null && dto.externalId !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxLength(EXTERNAL_ID_MAX_LENGTH)
  externalId?: string | null;

  @ApiProperty({
    description: 'The instant of the journal, as an ISO-8601 timestamp',
  })
  @IsISO8601({ strict: true })
  postedAt: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(65535)
  description?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  reference?: string;

  @ApiProperty({ description: 'Who created the journal', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  createdBy?: string;

  @ApiProperty({
    description: 'Free-form data kept with the journal',
    required: false,
  })
  @ValidateIf((dto) => dto.metadata !== null && dto.metadata !== undefined)
  @IsObject()
  metadata?: Record<string, unknown> | null;

  @ApiProperty({ type: [LedgerManualJournalEntryDto] })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(JOURNAL_MAX_ENTRIES)
  @ValidateNested({ each: true })
  @Type(() => LedgerManualJournalEntryDto)
  entries: LedgerManualJournalEntryDto[];
}

@StrictDto()
export class BulkLedgerManualJournalsDto {
  @ApiProperty({ type: [LedgerManualJournalDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BULK_MAX_JOURNALS)
  @ValidateNested({ each: true })
  @Type(() => LedgerManualJournalDto)
  journals: LedgerManualJournalDto[];
}

@StrictDto()
export class ListLedgerManualJournalsQueryDto {
  @ApiProperty({ description: 'Earliest instant, inclusive', required: false })
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @ApiProperty({ description: 'Latest instant, inclusive', required: false })
  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;

  @ApiProperty({ description: 'Comma-separated external ids', required: false })
  @IsOptional()
  @IsString()
  externalIds?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @Matches(/^\d+$/)
  page?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @Matches(/^\d+$/)
  pageSize?: string;
}
