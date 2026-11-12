import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { StrictDto } from '@/common/decorators/StrictDto';
import { EXTERNAL_ID_MAX_LENGTH } from '../LedgerExt.constants';

/** The most tracking options one balance request may name. */
export const BALANCE_MAX_TRACKING_OPTIONS = 1000;

/** Longest account number accepted. */
export const ACCOUNT_CODE_MAX_LENGTH = 60;

@StrictDto()
export class CreateLedgerAccountDto {
  @ApiProperty({ description: 'The name shown for the account' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  @ApiProperty({ description: 'The account number', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(ACCOUNT_CODE_MAX_LENGTH)
  code?: string | null;

  @ApiProperty({ description: 'The account type key', example: 'expense' })
  @IsString()
  @IsNotEmpty()
  accountType: string;

  @ApiProperty({ description: 'The id of the parent account', required: false })
  @IsOptional()
  @IsInt()
  parentId?: number | null;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(EXTERNAL_ID_MAX_LENGTH)
  externalId?: string;

  @ApiProperty({
    description: 'Free-form data kept with the account',
    required: false,
  })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

@StrictDto()
export class CreateLedgerChildAccountDto {
  @ApiProperty({ description: 'The name shown for the account' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  @ApiProperty({ description: 'The account number', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(ACCOUNT_CODE_MAX_LENGTH)
  code?: string | null;

  @ApiProperty({
    description: "Keys laid over the parent account's metadata",
    required: false,
  })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

@StrictDto()
export class EditLedgerAccountDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name?: string;

  @ApiProperty({
    description: 'The account number; null clears it',
    required: false,
  })
  @ValidateIf((dto) => dto.code !== null && dto.code !== undefined)
  @IsString()
  @MaxLength(ACCOUNT_CODE_MAX_LENGTH)
  code?: string | null;

  @ApiProperty({
    description:
      'The id of the new parent; null moves the account to the top level',
    required: false,
  })
  @ValidateIf((dto) => dto.parentId !== null && dto.parentId !== undefined)
  @IsInt()
  parentId?: number | null;

  @ApiProperty({
    description: 'Replaces the metadata; null removes it',
    required: false,
  })
  @ValidateIf((dto) => dto.metadata !== null && dto.metadata !== undefined)
  @IsObject()
  metadata?: Record<string, unknown> | null;
}

@StrictDto()
export class ListLedgerAccountsQueryDto {
  @ApiProperty({
    description: 'Start of the balance range, inclusive',
    required: false,
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @ApiProperty({
    description: 'End of the balance range, exclusive',
    required: false,
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;

  @ApiProperty({ enum: ['accrual', 'cash'], required: false })
  @IsOptional()
  @IsIn(['accrual', 'cash'])
  basis?: 'accrual' | 'cash';

  @ApiProperty({
    description:
      "Count entries dated before the workspace's books start, which are left out otherwise",
    enum: ['true', 'false'],
    required: false,
  })
  @IsOptional()
  @IsIn(['true', 'false'])
  includeBeforeStart?: 'true' | 'false';

  @ApiProperty({
    description:
      'Count only the entries carrying an option of this tracking category',
    required: false,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  trackingCategory?: string;

  @ApiProperty({
    description:
      'With trackingCategory: count only the entries carrying one of these options of it. May be repeated.',
    required: false,
    type: [String],
  })
  @IsOptional()
  @Transform(({ value }) => (Array.isArray(value) ? value : [value]))
  @IsArray()
  @ArrayMaxSize(BALANCE_MAX_TRACKING_OPTIONS)
  @IsString({ each: true })
  @MaxLength(255, { each: true })
  trackingOption?: string[];
}

export class LedgerAccountResponseDto {
  @ApiProperty()
  id: number;

  @ApiProperty({ nullable: true })
  code: string | null;

  @ApiProperty()
  name: string;

  @ApiProperty()
  accountType: string;

  @ApiProperty({ nullable: true })
  parentId: number | null;

  @ApiProperty({ nullable: true })
  externalId: string | null;

  @ApiProperty({ nullable: true })
  metadata: Record<string, unknown> | null;

  @ApiProperty({ description: 'Whether the account can be deleted' })
  deletable: boolean;

  @ApiProperty({ description: 'Debits less credits, with every descendant' })
  balance: string;

  @ApiProperty({ description: 'Debits less credits of the account alone' })
  ownBalance: string;

  @ApiProperty({
    description:
      'Debits less credits of everything before `from`, with every descendant. Present when `from` is sent.',
    required: false,
  })
  openingBalance?: string;

  @ApiProperty({
    description:
      'Debits less credits of everything before `from`, of the account alone. Present when `from` is sent.',
    required: false,
  })
  ownOpeningBalance?: string;
}
