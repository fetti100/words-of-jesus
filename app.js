/* Words of Jesus — client logic
   - Theme toggle
   - Load quotes.json
   - Chips (categories) + search
   - Virtualized append (initial render 60, then append 60 as user scrolls)
*/

(function () {
  'use strict';

  // ------- Theme toggle -------
  const themeToggle = document.querySelector('[data-theme-toggle]');
  const root = document.documentElement;

  const sunIcon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>`;
  const moonIcon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;

  let currentTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  root.setAttribute('data-theme', currentTheme);

  function applyThemeIcon() {
    if (!themeToggle) return;
    themeToggle.innerHTML = currentTheme === 'dark' ? sunIcon : moonIcon;
    themeToggle.setAttribute(
      'aria-label',
      'Switch to ' + (currentTheme === 'dark' ? 'light' : 'dark') + ' mode'
    );
  }
  applyThemeIcon();

  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', currentTheme);
      applyThemeIcon();
    });
  }

  // ------- Sticky header shadow on scroll -------
  const siteHeader = document.getElementById('site-header');
  let lastScroll = 0;
  window.addEventListener(
    'scroll',
    () => {
      const y = window.scrollY;
      if (y > 8) siteHeader.classList.add('is-scrolled');
      else siteHeader.classList.remove('is-scrolled');
      lastScroll = y;
    },
    { passive: true }
  );

  // ------- Load data -------
  const chipsEl = document.getElementById('chips');
  const listEl = document.getElementById('quotes-list');
  const searchInput = document.getElementById('search-input');
  const loadMoreEl = document.getElementById('load-more');
  const emptyState = document.getElementById('empty-state');
  const metaEl = document.getElementById('quotes-meta');
  const noteEl = document.getElementById('category-note');
  const noteLabelEl = document.getElementById('category-note-label');
  const noteTextEl = document.getElementById('category-note-text');

  const state = {
    quotes: [],
    categories: [],
    activeCategory: 'all', // 'all' or category id
    search: '',
    filteredIndices: [], // indices into state.quotes matching current filter
    rendered: 0,
    pageSize: 60,
  };

  fetch('./quotes.json')
    .then((r) => {
      if (!r.ok) throw new Error('Failed to load quotes');
      return r.json();
    })
    .then((data) => {
      state.quotes = data.quotes;
      state.categories = data.categories;
      renderChips();
      applyFilter();
    })
    .catch((err) => {
      console.error(err);
      listEl.innerHTML =
        '<p style="padding:2rem 0;font-family:var(--font-body);color:var(--color-text-muted)">Could not load the quotes file. Please refresh.</p>';
    });

  // ------- Chips -------
  function renderChips() {
    const chips = [
      { id: 'all', label: 'All quotes', count: state.quotes.length },
      ...state.categories.map((c) => ({
        id: c.id,
        label: c.label,
        count: c.count,
      })),
    ];

    chipsEl.innerHTML = chips
      .map(
        (c) =>
          `<button class="chip${c.id === state.activeCategory ? ' is-active' : ''}"
                    data-cat="${c.id}"
                    role="tab"
                    aria-selected="${c.id === state.activeCategory}">
             <span>${c.label}</span>
             <span class="chip__count">${c.count.toLocaleString()}</span>
           </button>`
      )
      .join('');

    chipsEl.querySelectorAll('.chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.activeCategory = btn.dataset.cat;
        // Update visual state
        chipsEl.querySelectorAll('.chip').forEach((b) => {
          const on = b.dataset.cat === state.activeCategory;
          b.classList.toggle('is-active', on);
          b.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        applyFilter();
        // Scroll list into view (below the sticky filter bar)
        const target = document.getElementById('quotes-section');
        if (target) {
          const y = target.getBoundingClientRect().top + window.scrollY - 4;
          window.scrollTo({ top: y, behavior: 'smooth' });
        }
      });
    });
  }

  // ------- Search -------
  let searchTimer = null;
  searchInput.addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = e.target.value.trim().toLowerCase();
      applyFilter();
    }, 150);
  });

  // ------- Filtering -------
  function applyFilter() {
    let baseIndices;
    let activeCat = null;
    if (state.activeCategory === 'all') {
      baseIndices = state.quotes.map((_, i) => i);
    } else {
      activeCat = state.categories.find((c) => c.id === state.activeCategory);
      baseIndices = activeCat ? activeCat.indices.slice() : [];
    }

    if (state.search) {
      const needle = state.search;
      baseIndices = baseIndices.filter((i) => {
        return state.quotes[i].t.toLowerCase().includes(needle);
      });
    }

    state.filteredIndices = baseIndices;
    state.rendered = 0;

    // Update category note
    if (activeCat) {
      noteEl.hidden = false;
      noteLabelEl.textContent = activeCat.label;
      noteTextEl.textContent = activeCat.description;
    } else {
      noteEl.hidden = true;
    }

    // Update meta
    const total = state.filteredIndices.length;
    const scope =
      state.activeCategory === 'all'
        ? 'reading in canonical order'
        : `filtered by ${activeCat.label}`;
    if (total === 0) {
      metaEl.textContent = '';
      emptyState.hidden = false;
    } else {
      emptyState.hidden = true;
      metaEl.textContent = `${total.toLocaleString()} ${
        total === 1 ? 'verse' : 'verses'
      } · ${scope}`;
    }

    listEl.innerHTML = '';
    renderNextPage();
  }

  // ------- Rendering -------
  const BOOK_LABELS = {
    Matthew: 'Matthew',
    Mark: 'Mark',
    Luke: 'Luke',
    John: 'John',
    Acts: 'Acts',
    Revelation: 'Revelation',
  };

  function highlight(text, needle) {
    if (!needle) return escapeHtml(text);
    // Escape both first, then highlight
    const esc = escapeHtml(text);
    const escNeedle = escapeHtml(needle).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(' + escNeedle + ')', 'ig');
    return esc.replace(re, '<mark>$1</mark>');
  }

  function escapeHtml(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderNextPage() {
    const end = Math.min(state.rendered + state.pageSize, state.filteredIndices.length);
    const frag = document.createDocumentFragment();

    let prevBook = null;
    let prevChapter = null;

    // Look back at last rendered quote to determine break state
    if (state.rendered > 0) {
      const prevIdx = state.filteredIndices[state.rendered - 1];
      const prev = state.quotes[prevIdx];
      prevBook = prev.b;
      prevChapter = prev.c;
    }

    const showBreaks = state.activeCategory === 'all' && !state.search;

    for (let i = state.rendered; i < end; i++) {
      const idx = state.filteredIndices[i];
      const q = state.quotes[idx];

      if (showBreaks) {
        // Book break — only when the book changes (skip the very first)
        if (prevBook !== null && prevBook !== q.b) {
          const bookDiv = document.createElement('div');
          bookDiv.className = 'book-break';
          bookDiv.innerHTML = `
            <div class="book-break__ornament">✦ ✦ ✦</div>
            <div class="book-break__title">${BOOK_LABELS[q.b]}</div>
            <div class="book-break__count">The words continue</div>
          `;
          frag.appendChild(bookDiv);
        } else if (prevBook !== null && prevChapter !== null && prevChapter !== q.c) {
          // Chapter break within same book — subtle
          const chapDiv = document.createElement('div');
          chapDiv.className = 'chapter-break';
          chapDiv.innerHTML = `<span class="chapter-break__label">${BOOK_LABELS[q.b]} ${q.c}</span>`;
          frag.appendChild(chapDiv);
        } else if (prevBook === null && i === 0) {
          // Very first render — introduce with the first book title
          const bookDiv = document.createElement('div');
          bookDiv.className = 'book-break';
          bookDiv.style.paddingTop = '0';
          bookDiv.innerHTML = `
            <div class="book-break__ornament">✦ ✦ ✦</div>
            <div class="book-break__title">${BOOK_LABELS[q.b]}</div>
            <div class="book-break__count">His first recorded words</div>
          `;
          frag.appendChild(bookDiv);
        }
      }

      const article = document.createElement('article');
      article.className = 'quote';
      article.innerHTML = `
        <div class="quote__ref">
          <span class="quote__ref-book">${BOOK_LABELS[q.b]}</span>
          <span class="quote__ref-cv">${q.c}:${q.v}</span>
        </div>
        <div class="quote__text">${highlight(q.t, state.search)}</div>
      `;
      frag.appendChild(article);

      prevBook = q.b;
      prevChapter = q.c;
    }

    listEl.appendChild(frag);
    state.rendered = end;

    // Show or hide load-more sentinel
    if (state.rendered < state.filteredIndices.length) {
      loadMoreEl.hidden = false;
      observeLoadMore();
    } else {
      loadMoreEl.hidden = true;
    }
  }

  // ------- IntersectionObserver for infinite scroll -------
  let ioAttached = false;
  let io = null;
  function observeLoadMore() {
    if (ioAttached) return;
    if (!('IntersectionObserver' in window)) {
      // Fallback: click-to-load
      loadMoreEl.style.cursor = 'pointer';
      loadMoreEl.addEventListener('click', renderNextPage);
      ioAttached = true;
      return;
    }
    io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) renderNextPage();
        });
      },
      { rootMargin: '600px 0px' }
    );
    io.observe(loadMoreEl);
    ioAttached = true;
  }

  // ------- Reveal on scroll for stats -------
  if ('IntersectionObserver' in window) {
    const revealTargets = document.querySelectorAll('.hero__title, .theory__title, .stats');
    const revealer = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add('is-visible');
            revealer.unobserve(e.target);
          }
        });
      },
      { threshold: 0.15 }
    );
    revealTargets.forEach((t) => {
      t.classList.add('reveal');
      revealer.observe(t);
    });
  }
})();
