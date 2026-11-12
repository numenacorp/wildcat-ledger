import {
  camelToSnake,
  snakeToCamel,
} from '@/common/interceptors/serialize.interceptor';
import { getOpaqueKeys, OpaqueKeys, withOpaqueKeys } from './OpaqueKeys';

describe('opaque keys', () => {
  const metadata = {
    inServiceDate: '2026-01-01',
    snake_key: 1,
    'X-Ref': 'a',
    nested: { camelKey: true, list: [{ inner_key: 1 }] },
  };

  it('rewrites field names inbound and leaves the opaque value as sent', () => {
    const body = {
      external_id: 'a',
      metadata,
      accounts: [{ account_type: 'cash', metadata: { 'Some-Key': 1 } }],
    };
    expect(withOpaqueKeys(body, ['metadata'], snakeToCamel)).toEqual({
      externalId: 'a',
      metadata,
      accounts: [{ accountType: 'cash', metadata: { 'Some-Key': 1 } }],
    });
  });

  it('rewrites field names outbound and leaves the opaque value as stored', () => {
    const response = { data: [{ externalId: 'a', metadata }] };
    expect(withOpaqueKeys(response, ['metadata'], camelToSnake)).toEqual({
      data: [{ external_id: 'a', metadata }],
    });
  });

  it('is the plain rewrite when no key is opaque', () => {
    expect(
      withOpaqueKeys({ some_key: { other_key: 1 } }, [], snakeToCamel),
    ).toEqual({
      someKey: { otherKey: 1 },
    });
  });

  it('passes null, strings and a null opaque value through', () => {
    expect(withOpaqueKeys(null, ['metadata'], snakeToCamel)).toBeNull();
    expect(
      withOpaqueKeys({ metadata: null, a_b: 1 }, ['metadata'], snakeToCamel),
    ).toEqual({
      metadata: null,
      aB: 1,
    });
  });

  it('reads the keys a controller declares', () => {
    @OpaqueKeys('metadata')
    class Marked {}
    class Plain {}

    expect(getOpaqueKeys(Marked)).toEqual(['metadata']);
    expect(getOpaqueKeys(Plain)).toEqual([]);
  });
});
