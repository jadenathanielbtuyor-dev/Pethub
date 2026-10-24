// Server-side pagination shared by the breed catalog and the service activity history: page numbers start at 1,
// the page size is bounded, and a page past the end (after deletions or a narrower filter) is moved to the last page.

function parsePageQuery(query = {}, { defaultSize, maxSize }) {
  const pageNumber = Number.parseInt(String(query.page ?? ''), 10);
  const sizeNumber = Number.parseInt(String(query.page_size ?? ''), 10);
  const page = Number.isInteger(pageNumber) && pageNumber > 0 ? Math.min(pageNumber, 100000) : 1;
  const pageSize = Number.isInteger(sizeNumber) && sizeNumber > 0 ? Math.min(sizeNumber, maxSize) : defaultSize;
  return { page, pageSize };
}

function pageRange(page, pageSize) {
  const from = (page - 1) * pageSize;
  return { from, to: from + pageSize - 1 };
}

function buildPageInfo(total, page, pageSize) {
  const totalPages = Math.max(1, Math.ceil((Number(total) || 0) / pageSize));
  return { page: Math.min(page, totalPages), page_size: pageSize, total: Number(total) || 0, total_pages: totalPages };
}

/**
 * Runs fetchPage(from, to) (a query with { count: 'exact' }) for the requested page; when that page is past the end it
 * asks once more for the last page. Returns { rows, info } or { error }.
 */
async function fetchPage(fetchPageRows, page, pageSize) {
  let first = await fetchPageRows(pageRange(page, pageSize));
  // PostgREST refuses an offset past the last row (416, PGRST103) instead of returning an empty page: count from page 1
  if (first.error?.code === 'PGRST103' && page > 1) first = await fetchPageRows(pageRange(1, pageSize));
  if (first.error) return { error: first.error };
  const info = buildPageInfo(first.count, page, pageSize);
  if (info.page === page || info.total === 0) return { rows: first.data || [], info: { ...info, page: info.total === 0 ? 1 : info.page } };
  const last = await fetchPageRows(pageRange(info.page, pageSize));
  if (last.error) return { error: last.error };
  return { rows: last.data || [], info: buildPageInfo(last.count, info.page, pageSize) };
}

// Text for ilike searches inside a PostgREST or() filter: letters, digits, spaces and a few name characters only
// (commas, parentheses and wildcards would change the filter itself)
function sanitizeSearchText(value, maxLength = 60) {
  return String(value || '').normalize('NFC').replace(/[^\p{L}\p{N} '.&-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

module.exports = {
  parsePageQuery,
  pageRange,
  buildPageInfo,
  fetchPage,
  sanitizeSearchText
};
