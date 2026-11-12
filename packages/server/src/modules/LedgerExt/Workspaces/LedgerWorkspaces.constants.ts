export const WORKSPACE_ERRORS = {
  WORKSPACE_NOT_FOUND: 'WORKSPACE_NOT_FOUND',
  WORKSPACE_INACTIVE: 'WORKSPACE_INACTIVE',
  WORKSPACE_NOT_READY: 'WORKSPACE_NOT_READY',
  WORKSPACE_BUILD_FAILED: 'WORKSPACE_BUILD_FAILED',
};

export enum WorkspaceStatus {
  Building = 'building',
  Ready = 'ready',
  Failed = 'failed',
}

export enum ReportingBasis {
  Accrual = 'accrual',
  Cash = 'cash',
}

/** Keys of the extension settings written when a workspace is provisioned. */
export const WORKSPACE_SETTINGS = {
  PROVISIONED: 'workspace_provisioned',
  GENERIC_ITEM_ID: 'generic_item_id',
  PLACEHOLDER_CUSTOMER_ID: 'placeholder_customer_id',
  PLACEHOLDER_VENDOR_ID: 'placeholder_vendor_id',
};

/**
 * How long a create waits for the organization database to be built before
 * answering that the workspace is still building, in milliseconds.
 */
export const DEFAULT_BUILD_WAIT_MS = 20_000;
