/* Ask Jesus — client application
 *
 * Views: home, conversation, read, books, book
 * Router: hash-based (#/, #/ask, #/read, #/books, #/read/matthew)
 * Ask: SSE streaming from /api/ask
 */

(() => {
  'use strict';

  // ============================== State ==============================

  const state = {
    quotes: [],
    byBook: {},               // { Matthew: [verses], Mark: [...] }
    bookOrder: ['Matthew', 'Mark', 'Luke', 'John', 'Acts', 'Revelation'],
    bookMeta: {
      Matthew:    { number: 'i',   lede: 'The kingdom sermons, the parables, the great commission. My longest recorded voice.' },
      Mark:       { number: 'ii',  lede: 'The urgent, action-driven account. My words in Mark are shorter, sharper, more direct.' },
      Luke:       { number: 'iii', lede: 'The gospel of outsiders — Samaritans, sinners, the poor. Where I say the most about who I came for.' },
      John:       { number: 'iv',  lede: 'The intimate discourses. Long, layered conversations about who I am and why I came.' },
      Acts:       { number: 'v',   lede: 'A few words after the resurrection — final instructions to my followers, and a voice from heaven.' },
      Revelation: { number: 'vi',  lede: 'Letters to seven churches and the closing vision. My voice as the risen Christ, speaking to the future.' },
    },
    view: 'home',
    theme: 'dark',
    // Conversation state (persisted)
    currentChat: null,        // { id, name, exchanges: [{q, a, at}], createdAt, updatedAt }
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // ========================== Storage (30-day TTL) ==========================

  const STORAGE_KEY = 'woj.chats.v1';
  const RETENTION_DAYS = 30;
  const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

  // In-memory fallback for sandboxed contexts where localStorage throws.
  const memoryStore = {};
  function safeGet(key) {
    try { return localStorage.getItem(key); }
    catch (_) { return memoryStore[key] || null; }
  }
  function safeSet(key, value) {
    try { localStorage.setItem(key, value); return true; }
    catch (_) { memoryStore[key] = value; return true; }
  }

  const storage = {
    // Returns array of chats, purging any older than 30 days.
    list() {
      const raw = safeGet(STORAGE_KEY);
      if (!raw) return [];
      let chats = [];
      try { chats = JSON.parse(raw) || []; }
      catch (_) { return []; }
      const cutoff = Date.now() - RETENTION_MS;
      const kept = chats.filter(c => (c.updatedAt || c.createdAt || 0) >= cutoff);
      if (kept.length !== chats.length) safeSet(STORAGE_KEY, JSON.stringify(kept));
      // Newest first
      return kept.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    },
    get(id) {
      return this.list().find(c => c.id === id) || null;
    },
    upsert(chat) {
      const all = this.list();
      const idx = all.findIndex(c => c.id === chat.id);
      chat.updatedAt = Date.now();
      if (idx >= 0) all[idx] = chat;
      else all.unshift(chat);
      safeSet(STORAGE_KEY, JSON.stringify(all));
      return chat;
    },
    remove(id) {
      const all = this.list().filter(c => c.id !== id);
      safeSet(STORAGE_KEY, JSON.stringify(all));
    },
    hasAny() { return this.list().length > 0; },
  };

  function newChatId() {
    // Short, sortable, unique enough for local use.
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function ensureCurrentChat() {
    if (!state.currentChat) {
      state.currentChat = {
        id: newChatId(),
        name: null,
        exchanges: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    }
    return state.currentChat;
  }

  function persistCurrentChat() {
    if (!state.currentChat) return;
    // Only persist if it's been named (opted-in) OR has at least one exchange (autosave for restore-on-refresh)
    if (!state.currentChat.exchanges.length) return;
    storage.upsert(state.currentChat);
    refreshHomeHistoryDoor();
    refreshSaveButton();
  }

  function refreshHomeHistoryDoor() {
    const door = $('#home-history-door');
    if (!door) return;
    door.hidden = !storage.hasAny();
  }

  // ============================== Theme ==============================

  const root = document.documentElement;
  const themeBtn = $('[data-theme-toggle]');

  const sunIcon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>`;
  const moonIcon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;

  function initTheme() {
    // Default: dark (per design). User can toggle to light.
    state.theme = 'dark';
    root.setAttribute('data-theme', state.theme);
    paintThemeBtn();
  }
  function paintThemeBtn() {
    if (!themeBtn) return;
    themeBtn.innerHTML = state.theme === 'dark' ? sunIcon : moonIcon;
    themeBtn.setAttribute('aria-label', `Switch to ${state.theme === 'dark' ? 'light' : 'dark'} mode`);
  }
  themeBtn?.addEventListener('click', () => {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', state.theme);
    paintThemeBtn();
  });

  // ============================ Chrome scroll ==========================

  const chrome = $('#chrome');
  window.addEventListener('scroll', () => {
    if (window.scrollY > 8) chrome.classList.add('is-scrolled');
    else chrome.classList.remove('is-scrolled');
  }, { passive: true });

  // ============================== Router ==============================

  function parseRoute() {
    const hash = window.location.hash.replace(/^#/, '') || '/';
    const parts = hash.split('/').filter(Boolean);
    if (parts.length === 0) return { name: 'home' };
    if (parts[0] === 'ask') {
      if (parts[1]) return { name: 'conversation', chatId: parts[1] };
      return { name: 'conversation' };
    }
    if (parts[0] === 'history') return { name: 'history' };
    if (parts[0] === 'read') {
      if (parts[1]) return { name: 'book', book: prettyBook(parts[1]) };
      return { name: 'read' };
    }
    if (parts[0] === 'books') return { name: 'books' };
    return { name: 'home' };
  }

  function prettyBook(slug) {
    const map = { matthew: 'Matthew', mark: 'Mark', luke: 'Luke', john: 'John', acts: 'Acts', revelation: 'Revelation' };
    return map[slug.toLowerCase()] || null;
  }
  function slugBook(name) { return name.toLowerCase(); }

  function showView(name) {
    state.view = name;
    document.body.setAttribute('data-current-view', name);
    $$('.view').forEach(el => {
      const match = el.dataset.view === name;
      el.hidden = !match;
    });
    // Chrome nav active state
    $$('.chrome__nav a').forEach(a => {
      const target = a.dataset.nav;
      const isActive = (name === 'home' && target === 'ask')
        || (name === 'conversation' && target === 'ask')
        || (name === 'history' && target === 'ask')
        || (name === 'read' && target === 'read')
        || (name === 'book' && target === 'read')
        || (name === 'books' && target === 'books');
      a.classList.toggle('is-active', isActive);
    });
    // Scroll to top on nav
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  function route() {
    const r = parseRoute();
    switch (r.name) {
      case 'home':
        showView('home');
        renderHomeExamples();
        refreshHomeHistoryDoor();
        setTimeout(() => $('#ask-input')?.focus({ preventScroll: true }), 400);
        break;
      case 'conversation':
        showView('conversation');
        // Restore a saved chat if the URL includes its id
        if (r.chatId) {
          const saved = storage.get(r.chatId);
          if (saved) {
            state.currentChat = saved;
            paintConversation();
          } else {
            // Chat doesn't exist (maybe expired) — fall back to a new chat
            state.currentChat = null;
            paintConversation();
          }
        }
        refreshSaveButton();
        break;
      case 'history':
        showView('history');
        renderHistory();
        break;
      case 'read':
        showView('read');
        renderRead();
        break;
      case 'books':
        showView('books');
        renderBooks();
        break;
      case 'book':
        if (!r.book) { window.location.hash = '#/books'; return; }
        showView('book');
        renderBook(r.book);
        break;
    }
  }

  window.addEventListener('hashchange', route);

  // ============================== Data =================================

  async function loadQuotes() {
    try {
      const res = await fetch('./quotes.json');
      const data = await res.json();
      // Data is packed as {b, c, v, t} — expand for readability
      state.quotes = (data.quotes || []).map(q => ({
        book: q.b || q.book,
        chapter: q.c ?? q.chapter,
        verse: q.v ?? q.verse,
        text: q.t || q.text || '',
      }));
      state.byBook = {};
      for (const q of state.quotes) {
        (state.byBook[q.book] ||= []).push(q);
      }
    } catch (err) {
      console.error('Failed to load quotes', err);
    }
  }

  // ============================== HOME ================================

  const HOME_EXAMPLES = [
    { q: 'What did you say about money?',                                    hint: 'Wealth, giving, treasure' },
    { q: 'Do you love me even when I have hurt people?',                     hint: 'Forgiveness, mercy, grace' },
    { q: 'Did you talk about the end of the world?',                         hint: 'Judgment, signs, return' },
    { q: 'What did you say about my enemies?',                               hint: 'Love, retaliation, forgiveness' },
    { q: 'Did you address homosexuality?',                                   hint: 'Sexuality, marriage' },
    { q: 'What did you say about doubt?',                                    hint: 'Faith, questions, unbelief' },
    { q: 'Did you talk about immigrants and foreigners?',                    hint: 'Neighbor, stranger, kingdom' },
    { q: 'What did you say to people who felt worthless?',                   hint: 'Value, worth, belonging' },
    { q: 'Did you address rich people directly?',                            hint: 'Wealth, camel, needle' },
    { q: 'How did you talk to religious leaders?',                           hint: 'Pharisees, hypocrisy, law' },
  ];

  function renderHomeExamples() {
    const wrap = $('#home-examples');
    if (!wrap) return;
    // Pick 3 fresh ones each visit (but stable within a session)
    if (!wrap.dataset.rendered) {
      const shuffled = [...HOME_EXAMPLES].sort(() => Math.random() - 0.5).slice(0, 3);
      wrap.innerHTML = shuffled.map(ex =>
        `<button type="button" class="home__example" data-q="${escapeAttr(ex.q)}"><span>${escapeHtml(ex.q)}</span></button>`
      ).join('');
      wrap.dataset.rendered = '1';
      wrap.addEventListener('click', (e) => {
        const btn = e.target.closest('.home__example');
        if (!btn) return;
        const q = btn.dataset.q;
        $('#ask-input').value = q;
        askQuestion(q);
      });
    }
  }

  // ============================== Ask ==================================

  const askForm = $('#ask-form');
  const askInput = $('#ask-input');
  const askSubmit = $('#ask-submit');
  const convForm = $('#conv-form');
  const convInput = $('#conv-input');
  const convThread = $('#conv-thread');

  // "New chat" link — clear current chat state so we don't append to a previous one
  document.addEventListener('click', (e) => {
    const backLink = e.target.closest('.conv__back');
    if (backLink) {
      state.currentChat = null;
    }
  });

  function autoGrow(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 192) + 'px';
  }
  askInput?.addEventListener('input', () => autoGrow(askInput));
  convInput?.addEventListener('input', () => autoGrow(convInput));

  askInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      askForm.requestSubmit();
    }
  });
  convInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      convForm.requestSubmit();
    }
  });

  askForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = askInput.value.trim();
    if (!q) return;
    askQuestion(q);
  });
  convForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = convInput.value.trim();
    if (!q) return;
    convInput.value = '';
    autoGrow(convInput);
    if (saveForm && !saveForm.hidden) saveForm.hidden = true;
    addExchange(q);
    refreshSaveButton();
    streamAnswer(q);
  });

  function askQuestion(q) {
    // Fresh chat when starting from home
    state.currentChat = null;
    // Navigate to conversation view, then add the exchange
    if (state.view !== 'conversation') {
      window.location.hash = '#/ask';
      // Wait one frame for the view to render
      setTimeout(() => {
        addExchange(q);
        streamAnswer(q);
      }, 60);
    } else {
      addExchange(q);
      streamAnswer(q);
    }
  }

  function addExchange(question) {
    ensureCurrentChat();
    // Record the question in state; the answer is filled in as it streams
    state.currentChat.exchanges.push({ q: question, a: '', at: Date.now() });

    const wrap = document.createElement('div');
    wrap.className = 'exchange';
    wrap.innerHTML = `
      <blockquote class="exchange__question">${escapeHtml(question)}</blockquote>
      <div class="exchange__answer" data-answer>
        <div class="exchange__pending"><span></span><span></span><span></span></div>
      </div>
    `;
    convThread.appendChild(wrap);
    // Scroll the question to top of viewport (natural conversation flow)
    setTimeout(() => {
      wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);
    return wrap;
  }

  // Re-render the whole thread from state.currentChat (used when restoring a saved chat)
  function paintConversation() {
    if (!convThread) return;
    convThread.innerHTML = '';
    if (!state.currentChat || !state.currentChat.exchanges.length) {
      refreshSaveButton();
      return;
    }
    state.currentChat.exchanges.forEach(ex => {
      const wrap = document.createElement('div');
      wrap.className = 'exchange';
      wrap.innerHTML = `
        <blockquote class="exchange__question">${escapeHtml(ex.q)}</blockquote>
        <div class="exchange__answer" data-answer>${renderMarkdown(ex.a || '')}</div>
      `;
      convThread.appendChild(wrap);
    });
    refreshSaveButton();
  }

  async function streamAnswer(question) {
    const exchange = convThread.lastElementChild;
    const answerEl = exchange.querySelector('[data-answer]');

    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
        body: JSON.stringify({ question }),
      });
      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Server returned ${res.status}. ${errText.slice(0, 200)}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullText = '';

      // Clear pending, start rendering
      answerEl.innerHTML = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() || '';
        for (const evt of events) {
          const lines = evt.split('\n');
          let eventName = 'message';
          let dataPayload = '';
          for (const line of lines) {
            if (line.startsWith('event:')) eventName = line.slice(6).trim();
            else if (line.startsWith('data:')) dataPayload += line.slice(5).trim();
          }
          if (!dataPayload) continue;

          if (eventName === 'token') {
            // data is a JSON-encoded string chunk
            try {
              const chunk = JSON.parse(dataPayload);
              fullText += chunk;
              answerEl.innerHTML = renderMarkdown(fullText);
            } catch (_) {}
          } else if (eventName === 'error') {
            try {
              const err = JSON.parse(dataPayload);
              throw new Error(err.message || 'The connection was interrupted.');
            } catch (parseErr) {
              if (parseErr instanceof SyntaxError) throw new Error('The connection was interrupted.');
              throw parseErr;
            }
          } else if (eventName === 'done') {
            // finalize below
          }
          // 'verses' event is currently ignored on the client
        }
      }

      // Final render pass
      answerEl.innerHTML = renderMarkdown(fullText || '');

      // Persist the answer into the current chat
      if (state.currentChat && state.currentChat.exchanges.length) {
        const last = state.currentChat.exchanges[state.currentChat.exchanges.length - 1];
        last.a = fullText || '';
        persistCurrentChat();
      }
    } catch (err) {
      console.error(err);
      answerEl.innerHTML = `<div class="exchange__error">Something interrupted the connection. ${escapeHtml(err.message || 'Try again in a moment.')}</div>`;
    }
  }

  // ---- Markdown-ish renderer (safe, small, verse-friendly) ----
  function renderMarkdown(text) {
    // 1. Escape all HTML first
    let s = escapeHtml(text);

    // 2. Blockquotes: consecutive lines starting with "> " become <blockquote>
    // Split into paragraphs (double newline)
    const paragraphs = s.split(/\n\s*\n/);
    const rendered = paragraphs.map(para => {
      const trimmed = para.trim();
      if (!trimmed) return '';

      // Blockquote paragraph
      if (trimmed.split('\n').every(line => line.trim().startsWith('&gt;'))) {
        const inner = trimmed
          .split('\n')
          .map(line => line.trim().replace(/^&gt;\s?/, ''))
          .join(' ');
        // Split off reference if it's on its own line inside — treat trailing italic as ref
        return `<blockquote>${inlineFmt(inner)}</blockquote>`;
      }

      return `<p>${inlineFmt(trimmed.replace(/\n/g, ' '))}</p>`;
    }).join('\n');

    return rendered;
  }

  function inlineFmt(s) {
    // Bold
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // Italic
    s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
    // Verse ref pattern: (Matthew 5:3) or (Matt. 5:3)
    return s;
  }

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
  function escapeAttr(s) { return escapeHtml(s); }

  // ========================= Save chat + History ==========================

  const saveBtn = $('#save-chat-btn');
  const saveLabel = $('#save-chat-label');
  const saveForm = $('#save-form');
  const saveFormEl = $('#save-form-el');
  const saveNameInput = $('#save-name');
  const saveCancel = $('#save-cancel');

  function refreshSaveButton() {
    if (!saveBtn) return;
    const chat = state.currentChat;
    const hasContent = chat && chat.exchanges && chat.exchanges.length > 0;
    saveBtn.disabled = !hasContent;
    saveBtn.style.opacity = hasContent ? '' : '0.5';
    saveBtn.style.pointerEvents = hasContent ? '' : 'none';

    if (chat && chat.name) {
      saveBtn.classList.add('is-saved');
      saveLabel.textContent = 'Saved as “' + chat.name + '”';
    } else {
      saveBtn.classList.remove('is-saved');
      saveLabel.textContent = 'Save this chat';
    }
  }

  saveBtn?.addEventListener('click', () => {
    if (!state.currentChat || !state.currentChat.exchanges.length) return;
    saveForm.hidden = false;
    saveNameInput.value = state.currentChat.name || '';
    setTimeout(() => saveNameInput.focus(), 50);
  });

  saveCancel?.addEventListener('click', () => {
    saveForm.hidden = true;
  });

  saveFormEl?.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = saveNameInput.value.trim();
    if (!name) { saveNameInput.focus(); return; }
    ensureCurrentChat();
    state.currentChat.name = name;
    persistCurrentChat();
    saveForm.hidden = true;
  });

  function formatChatDate(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const dayMs = 24 * 60 * 60 * 1000;
    const diff = now.getTime() - d.getTime();
    if (diff < dayMs && now.getDate() === d.getDate()) {
      return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }
    if (diff < 7 * dayMs) {
      return d.toLocaleDateString([], { weekday: 'short' }) + ', ' +
             d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function chatPreview(chat) {
    if (!chat.exchanges || !chat.exchanges.length) return '';
    const first = chat.exchanges[0];
    return first.q || '';
  }

  function chatDisplayName(chat) {
    if (chat.name) return chat.name;
    // Fallback — unsaved auto-persisted chats show the first question as their handle
    const prev = chatPreview(chat);
    if (prev) return prev.length > 60 ? prev.slice(0, 60) + '…' : prev;
    return 'Untitled chat';
  }

  const historyList = $('#history-list');
  const historyEmpty = $('#history-empty');

  function renderHistory() {
    if (!historyList) return;
    const chats = storage.list();
    if (!chats.length) {
      historyList.innerHTML = '';
      if (historyEmpty) historyEmpty.hidden = false;
      return;
    }
    if (historyEmpty) historyEmpty.hidden = true;

    historyList.innerHTML = chats.map(chat => {
      const name = chatDisplayName(chat);
      const preview = chatPreview(chat);
      const meta = formatChatDate(chat.updatedAt || chat.createdAt);
      const count = chat.exchanges.length;
      const countLabel = count === 1 ? '1 exchange' : count + ' exchanges';
      return `
        <a class="history-card" href="#/ask/${encodeURIComponent(chat.id)}">
          <div class="history-card__body">
            <h3 class="history-card__name">${escapeHtml(name)}</h3>
            <p class="history-card__preview">${escapeHtml(preview)}</p>
            <div class="history-card__meta">
              <span>${escapeHtml(meta)}</span>
              <span class="dot">·</span>
              <span>${countLabel}</span>
            </div>
          </div>
          <button type="button" class="history-card__delete"
                  data-delete-chat="${escapeAttr(chat.id)}"
                  aria-label="Delete this chat">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>
            </svg>
          </button>
        </a>`;
    }).join('');
  }

  historyList?.addEventListener('click', (e) => {
    const delBtn = e.target.closest('[data-delete-chat]');
    if (!delBtn) return;
    e.preventDefault();
    e.stopPropagation();
    const id = delBtn.getAttribute('data-delete-chat');
    storage.remove(id);
    // If we just deleted the chat currently loaded, clear state
    if (state.currentChat && state.currentChat.id === id) {
      state.currentChat = null;
    }
    renderHistory();
    refreshHomeHistoryDoor();
  });

  // ============================== READ ================================

  const readList = $('#read-list');
  const readSearch = $('#read-search');
  const readEmpty = $('#read-empty');
  const jumpToggle = $('#read-jump-toggle');
  const jumpMenu = $('#read-jump-menu');

  let readRendered = false;
  let readSearchTerm = '';

  function renderRead() {
    if (readRendered) {
      applyReadFilter();
      renderJumpMenu();
      return;
    }
    if (!state.quotes.length) {
      readList.innerHTML = '<p style="color:var(--ink-muted);padding:2rem 0;text-align:center;font-family:var(--body)">Loading the verses…</p>';
      return;
    }

    const frag = document.createDocumentFragment();
    let lastBook = null;
    let lastChapter = null;

    for (const q of state.quotes) {
      if (q.book !== lastBook) {
        const div = document.createElement('div');
        div.className = 'book-divider';
        div.dataset.book = q.book;
        div.id = `read-book-${slugBook(q.book)}`;
        div.innerHTML = `
          <div class="book-divider__eyebrow">Book ${(state.bookMeta[q.book]?.number || '').toUpperCase()}</div>
          <div class="book-divider__name">${escapeHtml(q.book)}</div>
        `;
        frag.appendChild(div);
        lastBook = q.book;
        lastChapter = null;
      }
      if (q.chapter !== lastChapter) {
        const cdiv = document.createElement('div');
        cdiv.className = 'chapter-divider';
        cdiv.innerHTML = `
          <div class="chapter-divider__ornament">
            <span class="chapter-divider__label">Chapter ${q.chapter}</span>
          </div>
        `;
        frag.appendChild(cdiv);
        lastChapter = q.chapter;
      }

      const v = document.createElement('div');
      v.className = 'verse';
      v.dataset.text = (q.text || '').toLowerCase();
      v.innerHTML = `
        <div class="verse__ref">${escapeHtml(q.book)} ${q.chapter}:${q.verse}</div>
        <p class="verse__text">${escapeHtml(q.text)}</p>
      `;
      frag.appendChild(v);
    }

    readList.innerHTML = '';
    readList.appendChild(frag);
    readRendered = true;
    renderJumpMenu();
  }

  function renderJumpMenu() {
    jumpMenu.innerHTML = state.bookOrder
      .filter(b => state.byBook[b])
      .map(b => `
        <button type="button" data-book="${escapeAttr(b)}">
          <span>${escapeHtml(b)}</span>
          <span class="book-count">${state.byBook[b].length}</span>
        </button>
      `).join('');
  }

  jumpToggle?.addEventListener('click', (e) => {
    e.stopPropagation();
    jumpMenu.hidden = !jumpMenu.hidden;
  });
  jumpMenu?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-book]');
    if (!btn) return;
    const book = btn.dataset.book;
    jumpMenu.hidden = true;
    const target = document.getElementById(`read-book-${slugBook(book)}`);
    if (target) {
      const y = target.getBoundingClientRect().top + window.scrollY - 80;
      window.scrollTo({ top: y, behavior: 'smooth' });
    }
  });
  document.addEventListener('click', () => { if (jumpMenu) jumpMenu.hidden = true; });

  readSearch?.addEventListener('input', () => {
    readSearchTerm = readSearch.value.trim().toLowerCase();
    applyReadFilter();
  });

  function applyReadFilter() {
    if (!readRendered) return;
    const term = readSearchTerm;
    const verses = readList.querySelectorAll('.verse');
    let matchCount = 0;
    verses.forEach(v => {
      const match = !term || v.dataset.text.includes(term);
      v.style.display = match ? '' : 'none';
      if (match) matchCount++;
    });
    // Hide book/chapter dividers with no visible verses
    const books = readList.querySelectorAll('.book-divider');
    books.forEach(b => {
      // Look ahead to next book-divider; count visible verses in between
      let el = b.nextElementSibling;
      let visible = 0;
      while (el && !el.classList.contains('book-divider')) {
        if (el.classList.contains('verse') && el.style.display !== 'none') visible++;
        el = el.nextElementSibling;
      }
      b.style.display = visible ? '' : 'none';
    });
    const chapters = readList.querySelectorAll('.chapter-divider');
    chapters.forEach(c => {
      let el = c.nextElementSibling;
      let visible = 0;
      while (el && !el.classList.contains('chapter-divider') && !el.classList.contains('book-divider')) {
        if (el.classList.contains('verse') && el.style.display !== 'none') visible++;
        el = el.nextElementSibling;
      }
      c.style.display = visible ? '' : 'none';
    });

    readEmpty.hidden = matchCount > 0 || !term;
  }

  // ============================== BOOKS ================================

  const booksGrid = $('#books-grid');

  function renderBooks() {
    if (!state.quotes.length) {
      booksGrid.innerHTML = '<p style="padding:2rem 0;color:var(--ink-muted);text-align:center">Loading…</p>';
      return;
    }
    booksGrid.innerHTML = state.bookOrder.map((b) => {
      const verses = state.byBook[b] || [];
      const meta = state.bookMeta[b];
      const chapterSet = new Set(verses.map(v => v.chapter));
      const chapters = chapterSet.size;
      const words = verses.reduce((sum, v) => sum + (v.text || '').split(/\s+/).length, 0);
      return `
        <a href="#/read/${slugBook(b)}" class="book-card">
          <div class="book-card__number">Book ${meta?.number || ''}</div>
          <h3 class="book-card__name">${escapeHtml(b)}</h3>
          <div class="book-card__meta">
            <span class="book-card__count">${verses.length.toLocaleString()}</span> verses ·
            ${chapters} ${chapters === 1 ? 'chapter' : 'chapters'} ·
            <span class="book-card__count">${words.toLocaleString()}</span> words
          </div>
        </a>
      `;
    }).join('');
  }

  // ============================ SINGLE BOOK ===========================

  function renderBook(bookName) {
    const verses = state.byBook[bookName] || [];
    const meta = state.bookMeta[bookName] || {};
    $('#book-eyebrow').textContent = `Book ${(meta.number || '').toUpperCase()}`;
    $('#book-title').textContent = bookName;
    $('#book-lede').textContent = meta.lede || '';

    const list = $('#book-list');
    if (!verses.length) {
      list.innerHTML = '<p style="color:var(--ink-muted);padding:2rem 0">Loading…</p>';
      return;
    }
    let lastChapter = null;
    let html = '';
    for (const q of verses) {
      if (q.chapter !== lastChapter) {
        html += `
          <div class="chapter-divider">
            <div class="chapter-divider__ornament">
              <span class="chapter-divider__label">Chapter ${q.chapter}</span>
            </div>
          </div>
        `;
        lastChapter = q.chapter;
      }
      html += `
        <div class="verse">
          <div class="verse__ref">${escapeHtml(q.book)} ${q.chapter}:${q.verse}</div>
          <p class="verse__text">${escapeHtml(q.text)}</p>
        </div>
      `;
    }
    list.innerHTML = html;
  }

  // ============================== Init ================================

  initTheme();
  // Route immediately for the home view; other views wait on quotes.
  route();
  loadQuotes().then(() => {
    // If we're on a data-dependent view, re-render now that data is loaded.
    if (state.view === 'read' || state.view === 'books' || state.view === 'book') {
      route();
    }
  });
})();
