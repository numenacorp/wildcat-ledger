import { chunks, inChunks } from './chunks';

describe('chunks', () => {
  it('splits a list into runs of the size given, the last one shorter', () => {
    expect(chunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunks([1, 2], 2)).toEqual([[1, 2]]);
    expect(chunks([], 2)).toEqual([]);
  });

  it('runs a query per run and joins the rows in order', async () => {
    const seen: number[][] = [];
    const rows = await inChunks(
      [1, 2, 3],
      async (run) => {
        seen.push(run);
        return run.map((n) => n * 10);
      },
      2,
    );
    expect(seen).toEqual([[1, 2], [3]]);
    expect(rows).toEqual([10, 20, 30]);
  });

  it('runs nothing for an empty list', async () => {
    const query = jest.fn(async () => [1]);
    expect(await inChunks([], query)).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});
