import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { ApiCommonHeaders } from '@/common/decorators/ApiCommonHeaders';
import { LedgerWorkspaceGuard } from '../Workspaces/LedgerWorkspace.guard';
import { LedgerTrackingCategoriesService } from './LedgerTrackingCategories.service';
import { LedgerTrackingLinksService } from './LedgerTrackingLinks.service';
import {
  CreateLedgerTrackingCategoryDto,
  CreateLedgerTrackingLinksDto,
  LedgerTrackingOptionDto,
  RemoveLedgerTrackingLinksDto,
  RenameLedgerTrackingOptionDto,
} from './LedgerTracking.dto';

@ApiTags('Ledger: Tracking')
@Controller('ledger/tracking-categories')
@ApiCommonHeaders()
@UseGuards(LedgerWorkspaceGuard)
export class LedgerTrackingCategoriesController {
  constructor(private readonly categories: LedgerTrackingCategoriesService) {}

  @Get()
  @ApiOperation({ summary: 'List every tracking category with its options' })
  async list() {
    return { data: await this.categories.list() };
  }

  @Post()
  @ApiOperation({
    summary:
      'Create a tracking category, or add the missing options to the one of that name',
  })
  async create(
    @Body() dto: CreateLedgerTrackingCategoryDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { category, created } = await this.categories.create(dto);

    response.status(created ? 201 : 200);
    return { data: category };
  }

  @Get('by-name/:name')
  @ApiOperation({ summary: 'Read a tracking category by its name' })
  async getByName(@Param('name') name: string) {
    return { data: await this.categories.getByName(name) };
  }

  @Post(':id/options')
  @ApiOperation({
    summary: 'Add an option to a category, or return the one of that name',
  })
  async addOption(
    @Param('id') id: string,
    @Body() dto: LedgerTrackingOptionDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { option, created } = await this.categories.addOption(
      Number(id),
      dto,
    );
    response.status(created ? 201 : 200);
    return { data: option };
  }

  @Put(':id/options/:optionId')
  @ApiOperation({
    summary:
      'Change the name an option is shown under, or archive or restore it',
  })
  async updateOption(
    @Param('id') id: string,
    @Param('optionId') optionId: string,
    @Body() dto: RenameLedgerTrackingOptionDto,
  ) {
    return {
      data: await this.categories.updateOption(Number(id), Number(optionId), {
        displayName: dto.displayName,
        active: dto.active,
      }),
    };
  }
}

@ApiTags('Ledger: Tracking')
@Controller('ledger/tracking-links')
@ApiCommonHeaders()
@UseGuards(LedgerWorkspaceGuard)
export class LedgerTrackingLinksController {
  constructor(private readonly links: LedgerTrackingLinksService) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Give lines of journals, bills or invoices tracking options',
  })
  async create(@Body() dto: CreateLedgerTrackingLinksDto) {
    return { data: await this.links.create(dto) };
  }

  @Post('remove')
  @HttpCode(200)
  @ApiOperation({ summary: 'Remove tracking links by id' })
  async remove(@Body() dto: RemoveLedgerTrackingLinksDto) {
    await this.links.remove(dto.ids);
    return { data: null };
  }
}
