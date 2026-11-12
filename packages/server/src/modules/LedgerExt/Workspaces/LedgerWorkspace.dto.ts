import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsISO31661Alpha2,
  IsISO4217CurrencyCode,
  IsISO8601,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import * as momentTz from 'moment-timezone';
import { ApiProperty } from '@nestjs/swagger';
import { StrictDto } from '@/common/decorators/StrictDto';
import { EXTERNAL_ID_MAX_LENGTH } from '../LedgerExt.constants';
import { ReportingBasis } from './LedgerWorkspaces.constants';

/** The most accounts a chart supplied at creation may hold. */
export const CHART_MAX_ACCOUNTS = 2000;

@StrictDto()
export class WorkspaceChartAccountDto {
  @ApiProperty({ description: 'The account number', example: '1810' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  code: string;

  @ApiProperty({ description: 'The name shown for the account' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  @ApiProperty({ description: 'The account type key', example: 'fixed-asset' })
  @IsString()
  @IsNotEmpty()
  accountType: string;

  @ApiProperty({
    description: 'The code of the parent account',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  parentCode?: string;

  @ApiProperty({
    description:
      'The slug of a predefined account this entry stands for, in place of creating a second one',
    required: false,
    example: 'retained-earnings',
  })
  @IsOptional()
  @IsString()
  slug?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(65535)
  description?: string;

  @ApiProperty({
    description: 'Free-form data kept with the account',
    required: false,
  })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

@StrictDto()
export class CreateLedgerWorkspaceDto {
  @ApiProperty({ description: "The caller's own id of the workspace" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(EXTERNAL_ID_MAX_LENGTH)
  externalId: string;

  @ApiProperty({ description: 'The name of the organization' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  @ApiProperty({ example: 'US' })
  @IsISO31661Alpha2()
  country: string;

  @ApiProperty({ example: 'USD' })
  @IsISO4217CurrencyCode()
  baseCurrency: string;

  @ApiProperty({ example: 'America/Chicago' })
  @IsIn(momentTz.tz.names())
  timezone: string;

  @ApiProperty({ enum: ReportingBasis, required: false })
  @IsOptional()
  @IsIn(Object.values(ReportingBasis))
  reportingBasis?: ReportingBasis;

  @ApiProperty({
    description: 'The instant the books start, as an ISO-8601 timestamp',
    required: false,
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  booksStartAt?: string;

  @ApiProperty({
    description:
      'The chart of accounts to create. Without one, the default chart is used.',
    type: [WorkspaceChartAccountDto],
    required: false,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(CHART_MAX_ACCOUNTS)
  @ValidateNested({ each: true })
  @Type(() => WorkspaceChartAccountDto)
  accounts?: WorkspaceChartAccountDto[];
}

@StrictDto()
export class UpdateLedgerWorkspaceDto {
  @ApiProperty({
    description: 'The instant the books start, as an ISO-8601 timestamp',
    required: false,
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  booksStartAt?: string;

  @ApiProperty({ enum: ReportingBasis, required: false })
  @IsOptional()
  @IsIn(Object.values(ReportingBasis))
  reportingBasis?: ReportingBasis;
}

export class LedgerWorkspaceResponseDto {
  @ApiProperty({ description: 'The id of the workspace' })
  id: number;

  @ApiProperty({
    description: 'The value of the `organization-id` header for calls under it',
  })
  organizationId: string;

  @ApiProperty()
  externalId: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  country: string;

  @ApiProperty()
  baseCurrency: string;

  @ApiProperty()
  timezone: string;

  @ApiProperty({ enum: ReportingBasis })
  reportingBasis: ReportingBasis;

  @ApiProperty({ nullable: true })
  booksStartAt: string | null;

  @ApiProperty({ nullable: true })
  inactiveAt: string | null;

  @ApiProperty({ enum: ['building', 'ready', 'failed'] })
  status: string;
}
