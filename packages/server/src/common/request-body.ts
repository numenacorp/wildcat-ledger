import { NestExpressApplication } from '@nestjs/platform-express';

/** The largest JSON body a ledger route accepts, unless REQUEST_BODY_LIMIT says otherwise. */
export const DEFAULT_REQUEST_BODY_LIMIT = '20mb';

/**
 * Sets the largest JSON request body the ledger's routes accept. The
 * framework's own default is 100 KB, which a request creating a few hundred
 * records exceeds.
 *
 * The larger limit is for the routes under `prefix` alone. Every other route,
 * those that need no sign-in among them, keeps the framework's default, so
 * that nobody can make the server read large bodies without signing in.
 */
export const applyRequestBodyLimit = (
  app: NestExpressApplication,
  prefix: string,
): void => {
  // The web framework under Nest is a dependency of Nest's adapter, not of
  // this package, so it is found through the adapter.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { json } = require(
    require.resolve('express', {
      paths: [require.resolve('@nestjs/platform-express')],
    }),
  );
  const parse = json({
    limit: process.env.REQUEST_BODY_LIMIT || DEFAULT_REQUEST_BODY_LIMIT,
    verify: (request: any, _response: unknown, buffer: Buffer) => {
      request.rawBody = buffer;
    },
  });
  // Registered before the framework's own parser, which leaves a body that
  // is already parsed alone. It is wrapped under a name of its own: the
  // framework does not add its parser when it finds one of the usual name
  // registered, and every other route would then be left with none.
  app.use(
    prefix,
    function ledgerJsonBody(request: any, response: any, next: any) {
      parse(request, response, next);
    },
  );
};
