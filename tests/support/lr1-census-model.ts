// Test-support model of the small-cell protection of the LR-1 census SQL (v3).
// It mirrors the SQL semantics of Q1 (status counts) and Q2 (non-completed rows
// by UTC quarter, cells below 5 merged into one '(suppressed)' row) so that the
// differencing property can be checked exhaustively without a database. It is
// NOT proof of PostgreSQL behaviour; the tests tie it to the SQL text by parsing
// the bucket table out of the SQL file.
export interface BucketRow {
  lo: bigint
  hi: bigint
  label: string
}

export const MAX_BIGINT = BigInt('9223372036854775807')

export function bucketLabel(n: number, table: readonly BucketRow[]): string {
  const v = BigInt(n)
  const row = table.find((b) => v >= b.lo && v < b.hi)
  if (!row) throw new Error(`no bucket for ${n}`)
  return row.label
}

/** cells[i] = number of rows of one (tool, status) group in quarter i (0 = no such cell). */
export function publishQ1(cells: readonly number[], table: readonly BucketRow[]): string {
  const total = cells.reduce((a, b) => a + b, 0)
  return bucketLabel(total, table)
}

export function publishQ2(cells: readonly number[], table: readonly BucketRow[], merge = true): string[] {
  const rows: string[] = []
  let suppressed = 0
  cells.forEach((n, quarter) => {
    if (n === 0) return
    if (merge && n < 5) {
      suppressed += n
      return
    }
    rows.push(`q${quarter}:${bucketLabel(n, table)}`)
  })
  if (suppressed > 0) rows.push(`(suppressed):${bucketLabel(suppressed, table)}`)
  return rows.sort()
}

export function publishedKey(cells: readonly number[], table: readonly BucketRow[], merge = true): string {
  return JSON.stringify([publishQ1(cells, table), publishQ2(cells, table, merge)])
}

/** Parses the (lo, hi, label) bucket VALUES lists out of the SQL text (one entry per query that carries one). */
export function parseBucketTables(sql: string): BucketRow[][] {
  const tables: BucketRow[][] = []
  const re = /WITH bucket\(lo, hi, label\) AS \(\s*VALUES([\s\S]*?)\n\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(sql)) !== null) {
    const rows: BucketRow[] = []
    const rowRe = /\(\s*(\d+)(?:::bigint)?\s*,\s*(\d+)(?:::bigint)?\s*,\s*'([^']+)'\s*\)/g
    let r: RegExpExecArray | null
    while ((r = rowRe.exec(m[1])) !== null) rows.push({ lo: BigInt(r[1]), hi: BigInt(r[2]), label: r[3] })
    tables.push(rows)
  }
  return tables
}
