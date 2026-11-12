import {
  ChartAccountInput,
  findChartProblems,
  parentsFirst,
  validateChart,
} from './chart';

const account = (over: Partial<ChartAccountInput>): ChartAccountInput => ({
  code: '1000',
  name: 'Cash',
  accountType: 'cash',
  ...over,
});

describe('chart validation', () => {
  it('accepts a chart with repeated names, a tree and predefined accounts', () => {
    const chart = [
      account({ code: '1000', name: 'Cash' }),
      account({ code: '1010', name: 'Cash', parentCode: '1000' }),
      account({
        code: '1200',
        name: 'Receivables',
        accountType: 'accounts-receivable',
      }),
      account({
        code: '2010',
        name: 'Payables',
        accountType: 'accounts-payable',
      }),
      account({
        code: '3900',
        name: 'Opening',
        accountType: 'equity',
        slug: 'opening-balance-equity',
      }),
      account({
        code: '3949',
        name: 'Retained',
        accountType: 'equity',
        slug: 'retained-earnings',
      }),
      account({
        code: '1500',
        name: 'Equipment',
        accountType: 'fixed-asset',
        parentCode: '1010',
      }),
    ];
    expect(findChartProblems(chart)).toEqual([]);
    expect(() => validateChart(chart)).not.toThrow();
  });

  it('reports a repeated code', () => {
    const problems = findChartProblems([
      account({}),
      account({ name: 'Other' }),
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ index: 1, code: '1000' });
  });

  it('reports an unknown account type', () => {
    expect(findChartProblems([account({ accountType: 'asset' })])).toHaveLength(
      1,
    );
  });

  it('reports a second receivable or payable account', () => {
    const problems = findChartProblems([
      account({ code: '1200', accountType: 'accounts-receivable' }),
      account({ code: '1201', accountType: 'accounts-receivable' }),
      account({ code: '2010', accountType: 'accounts-payable' }),
      account({ code: '2011', accountType: 'accounts-payable' }),
    ]);
    expect(problems.map((p) => p.index)).toEqual([1, 3]);
  });

  it('reports a predefined slug that is unknown, mistyped or repeated', () => {
    const problems = findChartProblems([
      account({ code: '1', accountType: 'equity', slug: 'no-such-account' }),
      account({ code: '2', accountType: 'expense', slug: 'retained-earnings' }),
      account({
        code: '3',
        accountType: 'equity',
        slug: 'opening-balance-equity',
      }),
      account({
        code: '4',
        accountType: 'equity',
        slug: 'opening-balance-equity',
      }),
    ]);
    expect(problems.map((p) => p.index)).toEqual([0, 1, 3]);
  });

  it('accepts the accounts the extension posts to, marked by slug', () => {
    expect(
      findChartProblems([
        account({
          code: '2100',
          accountType: 'other-current-liability',
          slug: 'payments-out-clearing',
        }),
        account({
          code: '1300',
          accountType: 'other-current-asset',
          slug: 'payments-in-clearing',
        }),
        account({
          code: '6900',
          accountType: 'other-expense',
          slug: 'uncategorized-expense',
        }),
        account({ code: '4000', accountType: 'income', slug: 'sales' }),
      ]),
    ).toEqual([]);
  });

  it('reports a marked account of the wrong root type, or marked twice', () => {
    const problems = findChartProblems([
      account({
        code: '1',
        accountType: 'cash',
        slug: 'payments-out-clearing',
      }),
      account({ code: '2', accountType: 'income', slug: 'sales' }),
      account({ code: '3', accountType: 'other-income', slug: 'sales' }),
    ]).map((p) => [p.code, p.problem]);

    expect(problems).toEqual([
      [
        '1',
        'The account marked "payments-out-clearing" must be of root type liability.',
      ],
      ['3', '"sales" is marked on more than one account.'],
    ]);
  });

  it('reports a missing parent and a cycle', () => {
    const problems = findChartProblems([
      account({ code: 'a', parentCode: 'missing' }),
      account({ code: 'b', parentCode: 'c' }),
      account({ code: 'c', parentCode: 'b' }),
      account({ code: 'd', parentCode: 'd' }),
    ]);
    expect(problems.map((p) => p.index)).toEqual([0, 1, 2, 3]);
  });

  it('reports a parent of another root type, and allows another type of the same root', () => {
    const problems = findChartProblems([
      account({ code: '1000', accountType: 'cash' }),
      account({ code: '1500', accountType: 'fixed-asset', parentCode: '1000' }),
      account({ code: '6000', accountType: 'expense', parentCode: '1000' }),
    ]);
    expect(problems.map((p) => p.index)).toEqual([2]);
  });

  it('throws one error carrying every problem', () => {
    try {
      validateChart([account({ accountType: 'nope' }), account({})]);
      throw new Error('expected a failure');
    } catch (error: any) {
      expect(error.errorType).toBe('CHART_INVALID');
      expect(error.payload.problems).toHaveLength(2);
    }
  });
});

describe('parentsFirst', () => {
  it('puts every parent before its children and keeps the given order otherwise', () => {
    const ordered = parentsFirst([
      account({ code: 'grandchild', parentCode: 'child' }),
      account({ code: 'child', parentCode: 'root' }),
      account({ code: 'other' }),
      account({ code: 'root' }),
    ]).map((a) => a.code);
    expect(ordered).toEqual(['other', 'root', 'child', 'grandchild']);
  });
});
