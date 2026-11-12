import { BadRequestException } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, ValidateNested } from 'class-validator';
import { StrictDto } from '@/common/decorators/StrictDto';
import { ValidationPipe } from './ClassValidation.pipe';

class LooseDto {
  @IsString()
  name: string;
}

class LineDto {
  @IsInt()
  amount: number;
}

@StrictDto()
class StrictParentDto {
  @IsString()
  name: string;

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => LineDto)
  lines?: LineDto[];
}

class StrictChildDto extends StrictParentDto {}

describe('ValidationPipe', () => {
  const pipe = new ValidationPipe();
  const run = (metatype: any, value: any) =>
    pipe.transform(value, { type: 'body', metatype });

  it('drops an unknown property of an ordinary DTO', async () => {
    const result = await run(LooseDto, { name: 'a', extra: 1 });
    expect(result).toEqual({ name: 'a' });
  });

  it('refuses an unknown property of a strict DTO', async () => {
    await expect(
      run(StrictParentDto, { name: 'a', extra: 1 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts a strict DTO with only declared properties', async () => {
    const result = await run(StrictParentDto, {
      name: 'a',
      lines: [{ amount: 1 }],
    });
    expect(result).toEqual({ name: 'a', lines: [{ amount: 1 }] });
  });

  it('refuses an unknown property of a nested object', async () => {
    await expect(
      run(StrictParentDto, { name: 'a', lines: [{ amount: 1, extra: true }] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('treats a class extending a strict DTO as strict', async () => {
    await expect(
      run(StrictChildDto, { name: 'a', extra: 1 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
