import 'reflect-metadata';

const OPAQUE_KEYS_METADATA = 'serialize:opaque-keys';

/**
 * Names properties whose values the serialize interceptor must pass through
 * untouched, on the requests and responses of a controller.
 *
 * The interceptor rewrites every key of a body between snake_case and
 * camelCase, at any depth. That is wrong for a value that belongs to the
 * caller, such as free-form metadata: its keys are data, not field names.
 */
export const OpaqueKeys =
  (...keys: string[]): ClassDecorator =>
  (target) => {
    Reflect.defineMetadata(OPAQUE_KEYS_METADATA, keys, target);
  };

export const getOpaqueKeys = (target: unknown): string[] =>
  (typeof target === 'function' &&
    Reflect.getMetadata(OPAQUE_KEYS_METADATA, target)) ||
  [];

const TOKEN_PREFIX = '\u0000opaque:';

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

/**
 * Applies a key-rewriting function to a value while keeping the values of the
 * opaque keys exactly as they are. Each such value is swapped for a token
 * before the rewrite and put back after it.
 */
export function withOpaqueKeys<T>(
  value: T,
  keys: string[],
  rewrite: (value: T) => T,
): T {
  if (keys.length === 0 || value === null || typeof value !== 'object') {
    return rewrite(value);
  }
  const held: unknown[] = [];

  const hide = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(hide);
    if (!isPlainObject(node)) return node;

    return Object.fromEntries(
      Object.entries(node).map(([key, child]) => {
        if (keys.includes(key) && child !== null && typeof child === 'object') {
          held.push(child);
          return [key, `${TOKEN_PREFIX}${held.length - 1}`];
        }
        return [key, hide(child)];
      }),
    );
  };
  const restore = (node: unknown): unknown => {
    if (typeof node === 'string' && node.startsWith(TOKEN_PREFIX)) {
      return held[Number(node.slice(TOKEN_PREFIX.length))];
    }
    if (Array.isArray(node)) return node.map(restore);
    if (!isPlainObject(node)) return node;

    return Object.fromEntries(
      Object.entries(node).map(([key, child]) => [key, restore(child)]),
    );
  };
  return restore(rewrite(hide(value) as T)) as T;
}
