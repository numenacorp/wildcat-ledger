/** The most values put in one SQL `IN (...)` list. */
export const IN_LIST_MAX = 5000;

/**
 * Splits a list into runs of at most the given size.
 */
export const chunks = <T>(values: T[], size = IN_LIST_MAX): T[][] => {
  const runs: T[][] = [];

  for (let i = 0; i < values.length; i += size) {
    runs.push(values.slice(i, i + size));
  }
  return runs;
};

/**
 * Runs a query once per run of values and joins the rows, so that no query
 * carries an unbounded `IN (...)` list.
 */
export const inChunks = async <T, R>(
  values: T[],
  query: (run: T[]) => PromiseLike<R[]>,
  size = IN_LIST_MAX,
): Promise<R[]> => {
  const rows: R[] = [];

  for (const run of chunks(values, size)) {
    rows.push(...(await query(run)));
  }
  return rows;
};
