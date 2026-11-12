import { isDeadlock, isDuplicateKey } from './dbErrors';

describe('database error recognition', () => {
  const native = (code: string, sqlMessage: string) => ({ code, sqlMessage });

  it('recognizes a deadlock from the driver and from the ORM wrapper', () => {
    const error = native(
      'ER_LOCK_DEADLOCK',
      'Deadlock found when trying to get lock',
    );
    expect(isDeadlock(error)).toBe(true);
    expect(isDeadlock({ name: 'DBError', nativeError: error })).toBe(true);
    expect(
      isDeadlock(
        new Error('insert into `X` - ER_LOCK_DEADLOCK: Deadlock found'),
      ),
    ).toBe(true);
    expect(isDeadlock(native('ER_DUP_ENTRY', 'Duplicate entry'))).toBe(false);
    expect(isDeadlock(undefined)).toBe(false);
  });

  it('recognizes a duplicate key, and tells indexes apart', () => {
    const error = native(
      'ER_DUP_ENTRY',
      "Duplicate entry 'a-b-1' for key 'EXT_EXTERNAL_IDS_LIVE_UNIQUE'",
    );
    expect(isDuplicateKey(error)).toBe(true);
    expect(isDuplicateKey(error, 'ext_external_ids_live_unique')).toBe(true);
    expect(isDuplicateKey(error, 'some_other_index')).toBe(false);
    expect(
      isDuplicateKey({ nativeError: error }, 'ext_external_ids_live_unique'),
    ).toBe(true);
    expect(isDuplicateKey(native('ER_LOCK_DEADLOCK', 'x'))).toBe(false);
  });
});
