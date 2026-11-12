import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { LedgerWorkspacesService } from './LedgerWorkspaces.service';

/**
 * Guards the extension's routes that act under a workspace: the organization
 * named by the `organization-id` header must be a workspace that is ready and
 * active.
 */
@Injectable()
export class LedgerWorkspaceGuard implements CanActivate {
  constructor(private readonly workspaces: LedgerWorkspacesService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const organizationId = request.headers['organization-id'];

    await this.workspaces.requireUsable(String(organizationId ?? ''));
    return true;
  }
}
