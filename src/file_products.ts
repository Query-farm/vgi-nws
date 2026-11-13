/** Small helpers for official directory listings and bounded immutable file pages. */
export function listingLinks(html: string): string[] {
  return [...new Set([...html.matchAll(/\bhref\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1] ?? ""))];
}
export function fileCursor(
  text: string,
  cursor: string | undefined,
  total: number,
  pageSize: unknown,
): { offset: number; size: number; token: (offset: number) => string | undefined } {
  const digest = Bun.hash(text).toString(),
    state = cursor ? JSON.parse(cursor) : { offset: 0, digest };
  const size = Number(pageSize);
  if (!Number.isInteger(size) || size < 1 || size > 1000)
    throw new Error("page_size must be an integer from 1 to 1000");
  if (state.digest !== digest) throw new Error("Source file changed while paging; rerun the query");
  if (!Number.isInteger(state.offset) || state.offset < 0 || state.offset > total)
    throw new Error("Invalid file continuation cursor");
  return {
    offset: state.offset,
    size,
    token: (offset) => (offset < total ? JSON.stringify({ offset, digest }) : undefined),
  };
}
