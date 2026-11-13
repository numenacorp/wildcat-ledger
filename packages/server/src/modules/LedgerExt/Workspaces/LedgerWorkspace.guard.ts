import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import {
  ACTOR_CLS_KEY,
  ACTOR_HEADER,
  ACTOR_MAX_LENGTH,
} from '../common/ExtAudit.service';
import { LedgerWorkspacesService } from './LedgerWorkspaces.service';

/**
 * Guards the extension's routes that act under a workspace: the organization
 * named by the `organization-id` header must be a workspace that is ready and
 * active.
 *
 * It also notes who the call is made for, from the `x-ledger-actor` header:
 * every call arrives as one platform user, and the audit log needs the
 * caller's own user.
 */
@Injectable()
export class LedgerWorkspaceGuard implements CanActivate {
  constructor(
    private readonly workspaces: LedgerWorkspacesService,
    private readonly cls: ClsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const organizationId = request.headers['organization-id'];

    await this.workspaces.requireUsable(String(organizationId ?? ''));

    const actor = request.headers[ACTOR_HEADER];
    if (typeof actor === 'string' && actor.trim() !== '') {
      this.cls.set(ACTOR_CLS_KEY, actor.trim().slice(0, ACTOR_MAX_LENGTH));
    }
    return true;
  }
}
