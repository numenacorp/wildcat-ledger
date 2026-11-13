import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { StrictDto } from '@/common/decorators/StrictDto';
import { LedgerTrackingDto } from '../ManualJournals/LedgerManualJournal.dto';
import {
  CATEGORY_MAX_OPTIONS,
  LINE_TYPES,
  LINKS_MAX_LINES,
  LINKS_MAX_TRACKING,
} from './tracking.constants';

const optionalName = () => (target: object, key: string) => {
  ApiProperty({ required: false, nullable: true })(target, key);
  ValidateIf((dto) => dto[key] !== null && dto[key] !== undefined)(target, key);
  IsString()(target, key);
  IsNotEmpty()(target, key);
  MaxLength(255)(target, key);
};

@StrictDto()
export class LedgerTrackingOptionDto {
  @ApiProperty({ description: 'The name the option is matched by' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  @optionalName()
  displayName?: string | null;
}

@StrictDto()
export class CreateLedgerTrackingCategoryDto {
  @ApiProperty({ description: 'The name the category is matched by' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  @optionalName()
  displayName?: string | null;

  @ApiProperty({ type: [LedgerTrackingOptionDto], required: false })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(CATEGORY_MAX_OPTIONS)
  @ValidateNested({ each: true })
  @Type(() => LedgerTrackingOptionDto)
  options?: LedgerTrackingOptionDto[];
}

@StrictDto()
export class RenameLedgerTrackingOptionDto {
  @ApiProperty({
    description: 'The name the option is shown under',
    required: false,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  displayName?: string;

  @ApiProperty({
    description:
      'False archives the option: it stays on the lines that carry it and takes no new one. True restores it',
    required: false,
  })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

@StrictDto()
export class CreateLedgerTrackingLinksDto {
  @ApiProperty({ enum: Object.keys(LINE_TYPES) })
  @IsIn(Object.keys(LINE_TYPES))
  lineType: string;

  @ApiProperty({ type: [Number] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(LINKS_MAX_LINES)
  @IsInt({ each: true })
  @Min(1, { each: true })
  lineIds: number[];

  @ApiProperty({ type: [LedgerTrackingDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(LINKS_MAX_TRACKING)
  @ValidateNested({ each: true })
  @Type(() => LedgerTrackingDto)
  tracking: LedgerTrackingDto[];
}

@StrictDto()
export class RemoveLedgerTrackingLinksDto {
  @ApiProperty({ type: [Number] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(LINKS_MAX_LINES)
  @IsInt({ each: true })
  @Min(1, { each: true })
  ids: number[];
}
