/**
 * Marks the type roots of the chart the ledger extension presents: the
 * headings Assets, Liabilities, Equity, Income and Expenses, which group
 * accounts and take no postings of their own.
 *
 * A chart supplied from now on says which of its entries are roots. In books
 * made before this, a root is found by its place: of the accounts of one
 * root type with no parent, the only one that has accounts beneath it. Where
 * two such accounts have accounts beneath them, neither is marked.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
const ROOT_TYPE_OF = {
  cash: 'asset',
  bank: 'asset',
  'accounts-receivable': 'asset',
  inventory: 'asset',
  'other-current-asset': 'asset',
  'fixed-asset': 'asset',
  'non-current-asset': 'asset',
  'accounts-payable': 'liability',
  'credit-card': 'liability',
  'tax-payable': 'liability',
  'other-current-liability': 'liability',
  'long-term-liability': 'liability',
  'non-current-liability': 'liability',
  equity: 'equity',
  income: 'income',
  'other-income': 'income',
  'cost-of-goods-sold': 'expense',
  expense: 'expense',
  'other-expense': 'expense',
};

exports.up = async function (knex) {
  await knex.schema.alterTable('ext_account_tree', (table) => {
    table.boolean('is_type_root').notNullable().defaultTo(false);
  });
  // A row's keys come back in either case, by the connection that reads it.
  const pick = (row, snake, camel) => row[snake] ?? row[camel];
  const nodes = await knex('ext_account_tree').select(
    'account_id',
    'parent_account_id',
  );
  const accounts = await knex('accounts').select('id', 'account_type');
  const typeOf = new Map(
    accounts.map((account) => [
      Number(account.id),
      ROOT_TYPE_OF[pick(account, 'account_type', 'accountType')],
    ]),
  );
  const parents = new Set(
    nodes
      .map((node) => pick(node, 'parent_account_id', 'parentAccountId'))
      .filter((id) => id !== null && id !== undefined)
      .map(Number),
  );
  const headings = new Map();

  nodes.forEach((node) => {
    const id = Number(pick(node, 'account_id', 'accountId'));
    const parentId = pick(node, 'parent_account_id', 'parentAccountId');
    const rootType = typeOf.get(id);

    if (parentId !== null && parentId !== undefined) return;
    if (!rootType || !parents.has(id)) return;
    headings.set(rootType, [...(headings.get(rootType) ?? []), id]);
  });
  for (const ids of headings.values()) {
    if (ids.length !== 1) continue;
    await knex('ext_account_tree')
      .where('account_id', ids[0])
      .update({ is_type_root: true });
  }
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  await knex.schema.alterTable('ext_account_tree', (table) => {
    table.dropColumn('is_type_root');
  });
};
