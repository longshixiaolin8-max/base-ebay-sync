interface PaginationProps {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  pageSize: number;
  onPageSizeChange: (size: number) => void;
  pageSizeOptions?: number[];
  totalCount: number;
}

/** Builds the page-number list with ellipses: always shows page 1 and the last page, plus a
 *  window of pages around the current one -- e.g. for page 3 of 125: 1 2 3 4 5 ... 125. */
function buildPageList(page: number, totalPages: number): Array<number | "ellipsis"> {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
  const windowStart = Math.max(2, page - 1);
  const windowEnd = Math.min(totalPages - 1, page + 1);
  const pages: Array<number | "ellipsis"> = [1];
  if (windowStart > 2) pages.push("ellipsis");
  for (let p = windowStart; p <= windowEnd; p++) pages.push(p);
  if (windowEnd < totalPages - 1) pages.push("ellipsis");
  pages.push(totalPages);
  return pages;
}

export function Pagination({ page, totalPages, onPageChange, pageSize, onPageSizeChange, pageSizeOptions = [10, 30, 50, 100], totalCount }: PaginationProps) {
  if (totalCount === 0) return null;
  const pages = buildPageList(page, totalPages);

  return (
    <div className="pagination">
      <div className="pagination-summary">
        全{totalCount.toLocaleString()}件中 {(page - 1) * pageSize + 1}-{Math.min(page * pageSize, totalCount).toLocaleString()}件を表示
      </div>
      <div className="pagination-controls">
        <button type="button" className="icon-button" disabled={page <= 1} onClick={() => onPageChange(page - 1)} aria-label="前のページ">
          ‹
        </button>
        {pages.map((p, i) =>
          p === "ellipsis" ? (
            <span key={`e${i}`} className="pagination-ellipsis">
              …
            </span>
          ) : (
            <button
              key={p}
              type="button"
              className="pagination-page"
              data-active={p === page}
              onClick={() => onPageChange(p)}
              aria-current={p === page ? "page" : undefined}
            >
              {p}
            </button>
          ),
        )}
        <button
          type="button"
          className="icon-button"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
          aria-label="次のページ"
        >
          ›
        </button>
      </div>
      <label className="pagination-page-size">
        表示件数
        <select value={pageSize} onChange={(e) => onPageSizeChange(Number(e.target.value))}>
          {pageSizeOptions.map((n) => (
            <option key={n} value={n}>
              {n}件
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
