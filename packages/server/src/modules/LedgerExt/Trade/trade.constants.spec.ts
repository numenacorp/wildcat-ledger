import { documentStatus } from './trade.constants';

describe('the status of a bill', () => {
  it('is open with nothing paid, and partially paid with something', () => {
    expect(documentStatus(10000n, 0n, false)).toBe('open');
    expect(documentStatus(10000n, 4000n, false)).toBe('partially_paid');
  });

  it('is paid when nothing is owed', () => {
    expect(documentStatus(10000n, 10000n, false)).toBe('paid');
  });

  it('is paid from the start when it totals zero', () => {
    expect(documentStatus(0n, 0n, false)).toBe('paid');
  });

  it('is open when it totals less than zero', () => {
    expect(documentStatus(-500n, 0n, false)).toBe('open');
  });

  it('is voided once voided, whatever is paid', () => {
    expect(documentStatus(10000n, 0n, true)).toBe('voided');
    expect(documentStatus(10000n, 10000n, true)).toBe('voided');
    expect(documentStatus(0n, 0n, true)).toBe('voided');
  });
});
