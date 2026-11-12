import { collationOf, resolveDatabaseCharset } from './database-charset';

describe('database charset', () => {
  it('defaults to utf8mb4', () => {
    expect(resolveDatabaseCharset(undefined, '')).toBe('utf8mb4');
  });
  it('takes the first value given', () => {
    expect(resolveDatabaseCharset(undefined, 'utf8')).toBe('utf8');
    expect(resolveDatabaseCharset(' UTF8MB4 ', 'utf8')).toBe('utf8mb4');
  });
  it('refuses anything that is not a UTF-8 set', () => {
    expect(() => resolveDatabaseCharset('latin1')).toThrow();
    expect(() => resolveDatabaseCharset('utf8; DROP DATABASE x')).toThrow();
  });
  it('pairs each set with its collation', () => {
    expect(collationOf('utf8mb4')).toBe('utf8mb4_unicode_ci');
    expect(collationOf('utf8')).toBe('utf8_general_ci');
  });
});
