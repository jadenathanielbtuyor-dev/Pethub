// Page navigation shared by the admin Breed Catalog and the Service activity history: Previous, page numbers, Next and
// "Page X of Y". The pages themselves come from the server (?page=&page_size=), so only one page is ever loaded.
// render(container, { page, total_pages, total }, onPage, { label }) replaces the container's content; onPage(n) is
// called with the page number the user chose.
(function attachPagination(root) {
  function pageList(current, totalPages) {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, index) => index + 1);
    const pages = new Set([1, totalPages, current - 1, current, current + 1]);
    const sorted = [...pages].filter(page => page >= 1 && page <= totalPages).sort((a, b) => a - b);
    const withGaps = [];
    sorted.forEach((page, index) => {
      if (index > 0 && page - sorted[index - 1] > 1) withGaps.push('gap');
      withGaps.push(page);
    });
    return withGaps;
  }

  function render(container, info, onPage, { label = 'Pages' } = {}) {
    if (!container) return;
    const page = Number(info?.page) || 1;
    const totalPages = Math.max(1, Number(info?.total_pages) || 1);
    const total = Number(info?.total) || 0;
    if (total === 0) {
      container.innerHTML = '';
      container.hidden = true;
      return;
    }
    container.hidden = false;
    const button = (target, text, { current = false, disabled = false, aria = '' } = {}) => `<button type="button" class="ph-page-button${current ? ' is-current' : ''}" data-page="${target}"${disabled ? ' disabled' : ''}${current ? ' aria-current="page"' : ''}${aria ? ` aria-label="${aria}"` : ''}>${text}</button>`;
    container.innerHTML = `
      <nav class="ph-pagination" aria-label="${label}">
        ${button(page - 1, '<i class="ri-arrow-left-s-line" aria-hidden="true"></i>Previous', { disabled: page <= 1, aria: 'Previous page' })}
        <span class="ph-page-numbers">${pageList(page, totalPages).map(entry => (entry === 'gap'
          ? '<span class="ph-page-gap" aria-hidden="true">…</span>'
          : button(entry, String(entry), { current: entry === page, aria: `Page ${entry}` }))).join('')}</span>
        ${button(page + 1, 'Next<i class="ri-arrow-right-s-line" aria-hidden="true"></i>', { disabled: page >= totalPages, aria: 'Next page' })}
        <span class="ph-page-status" role="status">Page ${page} of ${totalPages}</span>
      </nav>`;
    container.onclick = event => {
      const target = event.target.closest('[data-page]');
      if (!target || target.disabled) return;
      const next = Number(target.dataset.page);
      if (Number.isInteger(next) && next >= 1 && next <= totalPages && next !== page) onPage(next);
    };
  }

  root.PetHubPagination = Object.freeze({ render, pageList });
})(typeof globalThis !== 'undefined' ? globalThis : window);
