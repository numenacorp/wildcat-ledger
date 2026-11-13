import {
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { StrictDto } from '@/common/decorators/StrictDto';
import { EXTERNAL_ID_MAX_LENGTH } from '../LedgerExt.constants';

const optionalText = (max: number) => (target: object, key: string) => {
  ApiProperty({ required: false, nullable: true })(target, key);
  ValidateIf((dto) => dto[key] !== null && dto[key] !== undefined)(target, key);
  IsString()(target, key);
  MaxLength(max)(target, key);
};

@StrictDto()
export class UpsertLedgerVendorDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(EXTERNAL_ID_MAX_LENGTH)
  externalId?: string;

  @optionalText(255)
  companyName?: string | null;

  @optionalText(255)
  individualName?: string | null;

  @optionalText(255)
  email?: string | null;

  @optionalText(60)
  mobilePhone?: string | null;

  @optionalText(60)
  officePhone?: string | null;

  @optionalText(2000)
  addressString?: string | null;

  @optionalText(10000)
  notes?: string | null;
}

/** A vendor's or a customer's fields replaced, from the version they were read at. */
@StrictDto()
export class UpdateLedgerVendorDto extends UpsertLedgerVendorDto {
  @ApiProperty({
    description: 'The version of the record the change was made from',
    required: false,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;
}
