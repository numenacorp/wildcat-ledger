import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsOptional, Min } from 'class-validator';
import { StrictDto } from '@/common/decorators/StrictDto';

/** The body of a change that sends nothing but the version it was made from. */
@StrictDto()
export class VersionDto {
  @ApiProperty({
    description: 'The version of the record the change was made from',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;
}

/** What a create answers: the record, and whether this was a retry of an earlier create. */
export const created = <T>(data: T, replayed: boolean) =>
  replayed ? { data, replayed: true } : { data };
