import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { StrictDto } from '@/common/decorators/StrictDto';
import { EXTERNAL_ID_MAX_LENGTH } from '../LedgerExt.constants';
import { MONEY_PATTERN } from '../Trade/LedgerBill.dto';
import { OPENING_MAX_BALANCES } from './books.constants';

const present = (key: string) => (dto: Record<string, unknown>) =>
  dto[key] !== null && dto[key] !== undefined;

const optional =
  (...decorators: PropertyDecorator[]) =>
  (target: object, key: string) => {
    ApiProperty({ required: false, nullable: true })(target, key);
    ValidateIf(present(key))(target, key);
    decorators.forEach((decorator) => decorator(target, key));
  };

const money = () => (target: object, key: string) => {
  IsString()(target, key);
  Matches(MONEY_PATTERN)(target, key);
};

export const FUNDING_SOURCES = ['opening', 'account'] as const;
export type FundingSource = (typeof FUNDING_SOURCES)[number];

/**
 * The entry a fixed asset or a loan is recorded with, and where its other
 * side goes.
 */
@StrictDto()
export class LedgerFundingDto {
  @ApiProperty({ description: 'A decimal string' })
  @IsString()
  @Matches(MONEY_PATTERN)
  amount: string;

  @ApiProperty({ description: 'The instant the entry is dated at' })
  @IsString()
  postedOn: string;

  @ApiProperty({
    enum: FUNDING_SOURCES,
    description:
      '`account`: the other side goes to the account named, such as the bank account an asset was bought from or a loan was received into. `opening`: it was held when the books began, and the other side goes to opening balance equity; refused when dated after the day the books start.',
  })
  @IsIn(FUNDING_SOURCES as unknown as string[])
  from: FundingSource;

  @optional(IsInt())
  accountId?: number | null;
}

@StrictDto()
export class CreateLedgerFixedAssetDto {
  @optional(IsString(), IsNotEmpty(), MaxLength(EXTERNAL_ID_MAX_LENGTH))
  externalId?: string | null;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  @ApiProperty({ description: 'Kept as sent' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  assetType: string;

  @ApiProperty({ description: 'A decimal string' })
  @IsString()
  @Matches(MONEY_PATTERN)
  cost: string;

  @optional(money())
  salvageValue?: string | null;

  @optional(IsInt(), Min(0))
  usefulLifeMonths?: number | null;

  @optional(IsInt())
  accumulatedAccountId?: number | null;

  @optional(IsString(), IsNotEmpty(), MaxLength(60))
  accumulatedAccountSlug?: string | null;

  @optional(IsObject())
  metadata?: Record<string, unknown> | null;

  @optional(ValidateNested(), Type(() => LedgerFundingDto))
  funding?: LedgerFundingDto | null;
}

@StrictDto()
export class EditLedgerFixedAssetDto {
  @ApiProperty({
    required: false,
    description: 'The version of the asset the change was made from',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name?: string;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @ValidateIf(present('salvageValue'))
  @IsString()
  @Matches(MONEY_PATTERN)
  salvageValue?: string | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @ValidateIf(present('usefulLifeMonths'))
  @IsInt()
  @Min(0)
  usefulLifeMonths?: number | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @ValidateIf(present('accumulatedAccountId'))
  @IsInt()
  accumulatedAccountId?: number | null;

  @optional(IsString(), IsNotEmpty(), MaxLength(60))
  accumulatedAccountSlug?: string | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @ValidateIf(present('metadata'))
  @IsObject()
  metadata?: Record<string, unknown> | null;
}

@StrictDto()
export class CreateLedgerValueUpdateDto {
  @optional(IsString(), IsNotEmpty(), MaxLength(EXTERNAL_ID_MAX_LENGTH))
  externalId?: string | null;

  @ApiProperty()
  @IsInt()
  assetId: number;

  @ApiProperty({ description: 'A decimal string' })
  @IsString()
  @Matches(MONEY_PATTERN)
  amount: string;

  @ApiProperty({ description: 'Kept as sent' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  updateType: string;

  @ApiProperty()
  @IsString()
  postedOn: string;

  @optional(IsString(), MaxLength(65535))
  note?: string | null;

  @optional(IsInt())
  counterAccountId?: number | null;

  @optional(IsString(), IsNotEmpty(), MaxLength(60))
  counterAccountSlug?: string | null;
}

@StrictDto()
export class CreateLedgerLoanDto {
  @optional(IsString(), IsNotEmpty(), MaxLength(EXTERNAL_ID_MAX_LENGTH))
  externalId?: string | null;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  @ApiProperty({ description: 'Kept as sent' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  loanType: string;

  @optional(IsISO8601({ strict: true }))
  originationDate?: string | null;

  @optional(money())
  originalPrincipal?: string | null;

  @optional(money())
  creditLimit?: string | null;

  @optional(IsInt(), Min(0))
  loanTermMonths?: number | null;

  @optional(IsObject())
  metadata?: Record<string, unknown> | null;

  @optional(ValidateNested(), Type(() => LedgerFundingDto))
  funding?: LedgerFundingDto | null;
}

@StrictDto()
export class LedgerOpeningBalanceRowDto {
  @optional(IsString(), MaxLength(255))
  code?: string | null;

  @optional(IsString(), MaxLength(255))
  name?: string | null;

  @ApiProperty({ description: 'A decimal string' })
  @IsString()
  @Matches(MONEY_PATTERN)
  debit: string;

  @ApiProperty({ description: 'A decimal string' })
  @IsString()
  @Matches(MONEY_PATTERN)
  credit: string;
}

@StrictDto()
export class ImportLedgerOpeningBalancesDto {
  @ApiProperty({ description: 'The instant every opening entry is dated at' })
  @IsString()
  postedOn: string;

  @ApiProperty({ type: [LedgerOpeningBalanceRowDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(OPENING_MAX_BALANCES)
  @ValidateNested({ each: true })
  @Type(() => LedgerOpeningBalanceRowDto)
  balances: LedgerOpeningBalanceRowDto[];
}
