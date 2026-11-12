import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
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
import { LedgerTrackingDto } from '../ManualJournals/LedgerManualJournal.dto';
import {
  DOCUMENT_MAX_ENTRIES,
  PAYMENT_MAX_ALLOCATIONS,
  ALLOCATION_MEMO_MAX_LENGTH,
} from './trade.constants';

/** A decimal with up to six decimals, which may be negative. */
export const SIGNED_DECIMAL_PATTERN = /^-?\d{1,12}(\.\d{1,6})?$/;

/** A non-negative amount of money with up to two decimals. */
export const MONEY_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;

const present = (key: string) => (dto: Record<string, unknown>) =>
  dto[key] !== null && dto[key] !== undefined;

@StrictDto()
export class LedgerBillEntryDto {
  @ApiProperty({ required: false })
  @ValidateIf(present('externalId'))
  @IsString()
  @IsNotEmpty()
  @MaxLength(EXTERNAL_ID_MAX_LENGTH)
  externalId?: string | null;

  @ApiProperty({ description: 'The account the line posts to' })
  @IsInt()
  accountId: number;

  @ApiProperty({ required: false, description: 'What was bought, by name' })
  @ValidateIf(present('item'))
  @IsString()
  @MaxLength(255)
  item?: string | null;

  @ApiProperty({ required: false })
  @ValidateIf(present('description'))
  @IsString()
  @MaxLength(65535)
  description?: string | null;

  @ApiProperty({
    description: 'The price of one, a decimal string; may be negative',
  })
  @IsString()
  @Matches(SIGNED_DECIMAL_PATTERN)
  rate: string;

  @ApiProperty({ description: 'How many, a decimal string', default: '1' })
  @ValidateIf(present('quantity'))
  @IsString()
  @Matches(SIGNED_DECIMAL_PATTERN)
  quantity?: string | null;

  @ApiProperty({ required: false })
  @ValidateIf(present('metadata'))
  @IsObject()
  metadata?: Record<string, unknown> | null;

  @ApiProperty({ type: [LedgerTrackingDto], required: false })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LedgerTrackingDto)
  tracking?: LedgerTrackingDto[];
}

@StrictDto()
export class LedgerBillDto {
  @ApiProperty({ required: false })
  @ValidateIf(present('externalId'))
  @IsString()
  @IsNotEmpty()
  @MaxLength(EXTERNAL_ID_MAX_LENGTH)
  externalId?: string | null;

  @ApiProperty({ required: false, description: 'The id of the vendor' })
  @ValidateIf(present('vendorId'))
  @IsInt()
  vendorId?: number | null;

  @ApiProperty({
    required: false,
    description:
      'The external id of the vendor, made with no name when there is none yet',
  })
  @ValidateIf(present('vendorExternalId'))
  @IsString()
  @IsNotEmpty()
  @MaxLength(EXTERNAL_ID_MAX_LENGTH)
  vendorExternalId?: string | null;

  @ApiProperty({ description: 'The instant the bill was received' })
  @IsISO8601({ strict: true })
  postedAt: string;

  @ApiProperty({ required: false })
  @ValidateIf(present('dueAt'))
  @IsISO8601({ strict: true })
  dueAt?: string | null;

  @ApiProperty({
    required: false,
    description: 'With `due_on_receipt` the bill is due when it was received',
  })
  @ValidateIf(present('terms'))
  @IsString()
  @MaxLength(40)
  terms?: string | null;

  @ApiProperty({ required: false })
  @ValidateIf(present('reference'))
  @IsString()
  @MaxLength(255)
  reference?: string | null;

  @ApiProperty({ required: false })
  @ValidateIf(present('note'))
  @IsString()
  @MaxLength(65535)
  note?: string | null;

  @ApiProperty({ required: false })
  @ValidateIf(present('metadata'))
  @IsObject()
  metadata?: Record<string, unknown> | null;

  @ApiProperty({ type: [LedgerBillEntryDto], required: false })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(DOCUMENT_MAX_ENTRIES)
  @ValidateNested({ each: true })
  @Type(() => LedgerBillEntryDto)
  entries?: LedgerBillEntryDto[];
}

@StrictDto()
export class ListLedgerBillsQueryDto {
  @ApiProperty({
    required: false,
    description: 'One status or several, separated by commas',
  })
  @IsOptional()
  @IsString()
  @Matches(
    /^(open|partially_paid|paid|voided)(,(open|partially_paid|paid|voided))*$/,
  )
  status?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(EXTERNAL_ID_MAX_LENGTH)
  externalId?: string;

  @ApiProperty({ required: false, description: 'Received at or after' })
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @ApiProperty({ required: false, description: 'Received at or before' })
  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @Matches(/^\d{1,9}$/)
  page?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @Matches(/^\d{1,9}$/)
  pageSize?: string;
}

@StrictDto()
export class LedgerBillAllocationDto {
  @ApiProperty()
  @IsInt()
  billId: number;

  @ApiProperty({ description: 'A decimal string' })
  @IsString()
  @Matches(MONEY_PATTERN)
  amount: string;
}

@StrictDto()
export class LedgerBillPaymentDto {
  @ApiProperty({ required: false })
  @ValidateIf(present('externalId'))
  @IsString()
  @IsNotEmpty()
  @MaxLength(EXTERNAL_ID_MAX_LENGTH)
  externalId?: string | null;

  @ApiProperty({ description: 'The instant the money moved' })
  @IsISO8601({ strict: true })
  paidAt: string;

  @ApiProperty({ required: false, description: 'Kept as sent' })
  @ValidateIf(present('method'))
  @IsString()
  @MaxLength(60)
  method?: string | null;

  @ApiProperty({ required: false, description: 'Kept as sent' })
  @ValidateIf(present('processor'))
  @IsString()
  @MaxLength(60)
  processor?: string | null;

  @ApiProperty({ description: 'A decimal string' })
  @IsString()
  @Matches(MONEY_PATTERN)
  amount: string;

  @ApiProperty({
    required: false,
    description:
      'The account the money left; without one it waits in the clearing account',
  })
  @ValidateIf(present('accountId'))
  @IsInt()
  accountId?: number | null;

  @ApiProperty({ required: false })
  @ValidateIf(present('reference'))
  @IsString()
  @MaxLength(255)
  reference?: string | null;

  @ApiProperty({ required: false })
  @ValidateIf(present('note'))
  @IsString()
  @MaxLength(65535)
  note?: string | null;

  @ApiProperty({ required: false })
  @ValidateIf(present('metadata'))
  @IsObject()
  metadata?: Record<string, unknown> | null;

  @ApiProperty({ type: [LedgerBillAllocationDto], required: false })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(PAYMENT_MAX_ALLOCATIONS)
  @ValidateNested({ each: true })
  @Type(() => LedgerBillAllocationDto)
  allocations?: LedgerBillAllocationDto[];
}

@StrictDto()
export class LedgerInvoiceDto {
  @ApiProperty({ required: false })
  @ValidateIf(present('externalId'))
  @IsString()
  @IsNotEmpty()
  @MaxLength(EXTERNAL_ID_MAX_LENGTH)
  externalId?: string | null;

  @ApiProperty({ required: false, description: 'The id of the customer' })
  @ValidateIf(present('customerId'))
  @IsInt()
  customerId?: number | null;

  @ApiProperty({
    required: false,
    description: 'The external id of the customer, who must exist',
  })
  @ValidateIf(present('customerExternalId'))
  @IsString()
  @IsNotEmpty()
  @MaxLength(EXTERNAL_ID_MAX_LENGTH)
  customerExternalId?: string | null;

  @ApiProperty({ description: 'The instant the invoice was sent' })
  @IsISO8601({ strict: true })
  postedAt: string;

  @ApiProperty({ required: false })
  @ValidateIf(present('dueAt'))
  @IsISO8601({ strict: true })
  dueAt?: string | null;

  @ApiProperty({
    required: false,
    description: 'With `due_on_receipt` the invoice is due when it was sent',
  })
  @ValidateIf(present('terms'))
  @IsString()
  @MaxLength(40)
  terms?: string | null;

  @ApiProperty({
    required: false,
    description: 'Kept as sent; one is issued when none is sent',
  })
  @ValidateIf(present('invoiceNumber'))
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  invoiceNumber?: string | null;

  @ApiProperty({ required: false })
  @ValidateIf(present('reference'))
  @IsString()
  @MaxLength(255)
  reference?: string | null;

  @ApiProperty({ required: false })
  @ValidateIf(present('note'))
  @IsString()
  @MaxLength(65535)
  note?: string | null;

  @ApiProperty({ required: false })
  @ValidateIf(present('metadata'))
  @IsObject()
  metadata?: Record<string, unknown> | null;

  @ApiProperty({ type: [LedgerBillEntryDto], required: false })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(DOCUMENT_MAX_ENTRIES)
  @ValidateNested({ each: true })
  @Type(() => LedgerBillEntryDto)
  entries?: LedgerBillEntryDto[];
}

@StrictDto()
export class ListLedgerInvoicesQueryDto extends ListLedgerBillsQueryDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @Matches(/^\d{1,9}$/)
  customerId?: string;
}

@StrictDto()
export class LedgerInvoiceAllocationDto {
  @ApiProperty({
    required: false,
    description: 'The invoice this part pays. A part names this or accountId.',
  })
  @ValidateIf(present('invoiceId'))
  @IsInt()
  invoiceId?: number | null;

  @ApiProperty({
    required: false,
    description:
      'The account this part is paid to in place of an invoice, as the rest of a check kept as credit is',
  })
  @ValidateIf(present('accountId'))
  @IsInt()
  accountId?: number | null;

  @ApiProperty({
    required: false,
    description: 'Kept on a part paid to an account',
  })
  @ValidateIf(present('memo'))
  @IsString()
  @MaxLength(ALLOCATION_MEMO_MAX_LENGTH)
  memo?: string | null;

  @ApiProperty({ description: 'A decimal string' })
  @IsString()
  @Matches(MONEY_PATTERN)
  amount: string;
}

@StrictDto()
export class LedgerInvoicePaymentDto {
  @ApiProperty({ required: false })
  @ValidateIf(present('externalId'))
  @IsString()
  @IsNotEmpty()
  @MaxLength(EXTERNAL_ID_MAX_LENGTH)
  externalId?: string | null;

  @ApiProperty({ description: 'The customer the money came from' })
  @IsInt()
  customerId: number;

  @ApiProperty({ description: 'The instant the money moved' })
  @IsISO8601({ strict: true })
  paidAt: string;

  @ApiProperty({
    required: false,
    description:
      'Kept as sent. `CREDIT_BALANCE` redeems a credit balance and moves no cash.',
  })
  @ValidateIf(present('method'))
  @IsString()
  @MaxLength(60)
  method?: string | null;

  @ApiProperty({ required: false, description: 'Kept as sent' })
  @ValidateIf(present('processor'))
  @IsString()
  @MaxLength(60)
  processor?: string | null;

  @ApiProperty({ description: 'A decimal string' })
  @IsString()
  @Matches(MONEY_PATTERN)
  amount: string;

  @ApiProperty({
    required: false,
    description:
      'The account the money landed in; without one it waits in the clearing account',
  })
  @ValidateIf(present('accountId'))
  @IsInt()
  accountId?: number | null;

  @ApiProperty({
    required: false,
    description: 'The account a redeemed credit balance is taken from',
  })
  @ValidateIf(present('redemptionAccountId'))
  @IsInt()
  redemptionAccountId?: number | null;

  @ApiProperty({ required: false })
  @ValidateIf(present('reference'))
  @IsString()
  @MaxLength(255)
  reference?: string | null;

  @ApiProperty({ required: false })
  @ValidateIf(present('note'))
  @IsString()
  @MaxLength(65535)
  note?: string | null;

  @ApiProperty({ required: false })
  @ValidateIf(present('metadata'))
  @IsObject()
  metadata?: Record<string, unknown> | null;

  @ApiProperty({ type: [LedgerInvoiceAllocationDto], required: false })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(PAYMENT_MAX_ALLOCATIONS)
  @ValidateNested({ each: true })
  @Type(() => LedgerInvoiceAllocationDto)
  allocations?: LedgerInvoiceAllocationDto[];
}
