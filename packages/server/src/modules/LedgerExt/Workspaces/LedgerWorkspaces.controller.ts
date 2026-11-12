import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { TenantAgnosticRoute } from '@/modules/Tenancy/TenancyGlobal.guard';
import { IgnoreUserVerifiedRoute } from '@/modules/Auth/guards/EnsureUserVerified.guard';
import { IgnoreTenantInitializedRoute } from '@/modules/Tenancy/EnsureTenantIsInitialized.guard';
import { IgnoreTenantSeededRoute } from '@/modules/Tenancy/EnsureTenantIsSeeded.guards';
import { IgnoreTenantModelsInitialize } from '@/modules/Tenancy/TenancyInitializeModels.guard';
import { OpaqueKeys } from '@/common/decorators/OpaqueKeys';
import { LedgerWorkspacesService } from './LedgerWorkspaces.service';
import {
  CreateLedgerWorkspaceDto,
  LedgerWorkspaceResponseDto,
  UpdateLedgerWorkspaceDto,
} from './LedgerWorkspace.dto';

/**
 * Workspaces are addressed by their own id, so none of these routes takes the
 * `organization-id` header.
 */
@ApiTags('Ledger: Workspaces')
@Controller('ledger/workspaces')
@OpaqueKeys('metadata')
@TenantAgnosticRoute()
@IgnoreUserVerifiedRoute()
@IgnoreTenantInitializedRoute()
@IgnoreTenantSeededRoute()
@IgnoreTenantModelsInitialize()
export class LedgerWorkspacesController {
  constructor(
    private readonly workspaces: LedgerWorkspacesService,
    private readonly cls: ClsService,
  ) {}

  private get userId(): number {
    return this.cls.get<number>('userId');
  }

  @Post()
  @ApiOperation({
    summary:
      'Create a workspace with its chart of accounts, or return the one carrying the external id',
  })
  @ApiResponse({ status: 201, type: LedgerWorkspaceResponseDto })
  @ApiResponse({
    status: 200,
    description: 'A workspace with this external id already existed',
    type: LedgerWorkspaceResponseDto,
  })
  async create(
    @Body() dto: CreateLedgerWorkspaceDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { workspace, created } = await this.workspaces.create(
      this.userId,
      dto,
    );

    response.status(created ? 201 : 200);
    return { data: workspace };
  }

  @Get()
  @ApiOperation({ summary: 'List workspaces, optionally by external id' })
  list(
    @Query('externalId') externalId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.workspaces.list(this.userId, {
      externalId,
      page: Number(page),
      pageSize: Number(pageSize),
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Retrieve a workspace' })
  async get(@Param('id') id: string) {
    return { data: await this.workspaces.get(this.userId, Number(id)) };
  }

  @Put(':id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Update a workspace' })
  async update(@Param('id') id: string, @Body() dto: UpdateLedgerWorkspaceDto) {
    return { data: await this.workspaces.update(this.userId, Number(id), dto) };
  }

  @Put(':id/inactivate')
  @HttpCode(200)
  @ApiOperation({ summary: 'Inactivate a workspace' })
  async inactivate(@Param('id') id: string) {
    return { data: await this.workspaces.inactivate(this.userId, Number(id)) };
  }

  @Put(':id/activate')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reactivate a workspace' })
  async activate(@Param('id') id: string) {
    return { data: await this.workspaces.activate(this.userId, Number(id)) };
  }

  @Delete(':id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Delete a workspace and its books' })
  async delete(@Param('id') id: string) {
    await this.workspaces.delete(this.userId, Number(id));
    return { data: { id: Number(id), deleted: true } };
  }
}
