import 'reflect-metadata';

const STRICT_DTO_METADATA = 'dto:strict';

/**
 * Marks a request DTO as strict: a request carrying a property the DTO does
 * not declare is refused, instead of having the property silently dropped.
 *
 * Classes extending a strict DTO are strict too.
 */
export const StrictDto = (): ClassDecorator => (target) => {
  Reflect.defineMetadata(STRICT_DTO_METADATA, true, target);
};

export const isStrictDto = (metatype: unknown): boolean =>
  typeof metatype === 'function' &&
  Reflect.getMetadata(STRICT_DTO_METADATA, metatype) === true;
