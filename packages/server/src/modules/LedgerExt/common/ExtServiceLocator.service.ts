import { Injectable, Type } from '@nestjs/common';
import { ContextIdFactory, ModuleRef } from '@nestjs/core';

/**
 * Resolves Bigcapital's own services for the extension.
 *
 * Most of the services the extension calls (create a bill, create an item and
 * so on) are not exported by the modules that provide them. Resolving them by
 * class through the application container lets the extension call them as
 * they are, without editing each of those modules to export them.
 *
 * Many of those services are request-scoped, directly or through something
 * they depend on, so each is resolved in a context of its own rather than
 * fetched as a singleton. The organization they act on still comes from the
 * tenancy context of the running call.
 */
@Injectable()
export class ExtServiceLocator {
  constructor(private readonly moduleRef: ModuleRef) {}

  /** Fetches a provider registered under a token, wherever it is provided. */
  public get<T = unknown>(token: string | symbol): T {
    return this.moduleRef.get(token, { strict: false });
  }

  public resolve<T>(token: Type<T>): Promise<T> {
    return this.moduleRef.resolve(token, ContextIdFactory.create(), {
      strict: false,
    });
  }
}
