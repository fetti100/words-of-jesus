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
    byBook: {},               // { Matthew: [verses], Mark: [...] } — Jesus's words only
    // The full 66-book Bible catalog is loaded from /bible/index.json at boot.
    bibleCatalog: [],         // [{ key, name, testament, order, chapters, verses }, ...]
    bookByKey: {},            // { matthew: {key,name,testament,order,...} }
    bookByName: {},           // { Matthew: {key,name,...} }
    // Extra editorial ledes for the six books where Jesus speaks.
    bookLedes: {
      Matthew:    'The kingdom sermons, the parables, the great commission. Where his voice is longest.',
      Mark:       'The urgent, action-driven account. His words in Mark are shorter, sharper, more direct.',
      Luke:       'The gospel of outsiders — Samaritans, sinners, the poor. Where he says the most about who he came for.',
      John:       'The intimate discourses. Long, layered conversations about who he is and why he came.',
      Acts:       'A few words after the resurrection — final instructions to his followers, and a voice from heaven.',
      Revelation: 'Letters to seven churches and the closing vision. His voice as the risen Christ, speaking to the future.',
    },
    // Cache of loaded WEB books, keyed by URL key (kebab-case for multi-word).
    bibleCache: {},           // { matthew: { chapters: { "1": [{v,t}], ... } }, ... }
    bibleLoading: {},         // in-flight fetch promises, keyed by key
    // Where to return when the reader taps 'Back to conversation' in the book view.
    returnRef: null,          // { hash: '#/ask/<id>' | '#/ask' }
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
    let hash = window.location.hash.replace(/^#/, '') || '/';
    // Split off an optional query string: '/read/matthew?v=5:44' → path + params
    let query = '';
    const qIdx = hash.indexOf('?');
    if (qIdx >= 0) {
      query = hash.slice(qIdx + 1);
      hash = hash.slice(0, qIdx);
    }
    const params = new URLSearchParams(query);
    const parts = hash.split('/').filter(Boolean);
    if (parts.length === 0) return { name: 'home' };
    if (parts[0] === 'ask') {
      if (parts[1]) return { name: 'conversation', chatId: parts[1] };
      return { name: 'conversation' };
    }
    if (parts[0] === 'history') return { name: 'history' };
    if (parts[0] === 'read') {
      if (parts[1]) {
        const verse = params.get('v');   // e.g. "5:44"
        return { name: 'book', book: prettyBook(parts[1]), verse };
      }
      return { name: 'read' };
    }
    if (parts[0] === 'books') return { name: 'books' };
    return { name: 'home' };
  }

  // Book ↔ URL slug lookup. Falls back to a normalized key if the catalog
  // hasn't finished loading yet, so citation links parse deterministically.
  function prettyBook(slug) {
    if (!slug) return null;
    const key = String(slug).toLowerCase();
    if (state.bookByKey[key]) return state.bookByKey[key].name;
    // Fallback (also covers legacy URL slugs like '1corinthians' without hyphen)
    const stripped = key.replace(/[-_\s]/g, '');
    for (const b of state.bibleCatalog) {
      if (b.key.replace(/-/g, '') === stripped) return b.name;
    }
    return null;
  }
  function slugBook(name) {
    if (!name) return '';
    if (state.bookByName[name]) return state.bookByName[name].key;
    // Fallback: normalize display name to kebab-case url slug.
    return String(name).toLowerCase().replace(/\s+/g, '-');
  }
  function bookMetaFor(name) {
    return state.bookByName[name] || null;
  }

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
        state.returnRef = null;
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
        state.returnRef = null;
        showView('history');
        renderHistory();
        break;
      case 'read':
        state.returnRef = null;
        showView('read');
        renderRead();
        break;
      case 'books':
        state.returnRef = null;
        showView('books');
        renderBooks();
        break;
      case 'book':
        if (!r.book) { window.location.hash = '#/books'; return; }
        showView('book');
        renderBook(r.book, r.verse);
        break;
    }
  }

  window.addEventListener('hashchange', route);

  // Track the origin when the user taps a citation link inside a conversation.
  // If we jumped into the book view from within a chat, remember where to
  // return so we can show a 'Back to conversation' pill.
  document.addEventListener(
    'click',
    (ev) => {
      const link = ev.target.closest && ev.target.closest('a.cite');
      if (!link) return;
      const from = window.location.hash;
      // Only capture if we're jumping FROM a chat (or the home ask view).
      if (from.startsWith('#/ask') || from === '' || from === '#/' || from === '#') {
        state.returnRef = { hash: from || '#/' };
      }
    },
    true,
  );

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

    // Is this the first Q&A in the current chat? (addExchange already pushed
    // the pending exchange, so length===1 means this is the opener.)
    const isFirstAnswer = !state.currentChat
      || state.currentChat.exchanges.length <= 1;

    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
        body: JSON.stringify({ question, firstAnswer: isFirstAnswer }),
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
    // Red-letter tradition: any quoted phrase (curly or straight quotes) is Jesus's words.
    // Match "...", “...”, or mixed. Non-greedy, at least one char, no line break inside.
    s = s.replace(/(&quot;|“)([^”“\n]+?)(&quot;|”)/g, '<span class="red-letter">$1$2$3</span>');
    // Book reference at end of a line: " — Matthew 5:44", " — 1 Corinthians 13:4",
    // or " — Song of Solomon 2:1". Turn the em-dash + book + chapter:verse into a
    // link to the Read tab, scrolled to that exact verse.
    s = s.replace(
      /\s*(\u2014|\u2013|--|-)\s*((?:[123]\s)?[A-Z][A-Za-z]+(?:\s+(?:of\s+)?[A-Z][A-Za-z]+)*)\s+(\d+):(\d+)(?:-\d+)?/g,
      (_, _dash, book, ch, v) => {
        const cleaned = book.replace(/\.$/, '').replace(/\s+/g, ' ').trim();
        const key = slugBook(cleaned);
        // If the catalog knows this book, deep-link; otherwise render as plain span.
        if (state.bookByKey[key]) {
          return ` <a class="cite" href="#/read/${key}?v=${ch}:${v}">\u2014 ${cleaned} ${ch}:${v}</a>`;
        }
        return ` <span class="cite">\u2014 ${cleaned} ${ch}:${v}</span>`;
      }
    );
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

  // ============================== Voice input =============================
  // Uses the Web Speech API. Works on iOS Safari 14.5+, macOS Safari,
  // and Chromium. Must call recognition.start() synchronously inside the
  // click handler — iOS silently blocks it otherwise.

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const voiceSupported = !!SpeechRecognition;

  const askMicBtn = $('#ask-mic');
  const convMicBtn = $('#conv-mic');

  // Reveal mic buttons only if the browser supports voice input
  if (voiceSupported) {
    askMicBtn?.removeAttribute('hidden');
    convMicBtn?.removeAttribute('hidden');
  }

  let activeRecognition = null;
  let activeMicBtn = null;
  let activeInputEl = null;
  let recognitionBaseText = '';

  function stopRecognition() {
    if (activeRecognition) {
      try { activeRecognition.stop(); } catch (_) {}
    }
  }

  // Convert spoken punctuation words to marks, and infer a question mark
  // for interrogative sentences that end without one (iOS Web Speech
  // returns unpunctuated text by default).
  const QUESTION_STARTERS = new Set([
    'what','who','whom','whose','where','when','why','how','which',
    'is','are','was','were','am',
    'do','does','did',
    'can','could','will','would','should','shall',
    'may','might','must',
    'have','has','had',
    'am','aren\u2019t','aren\'t','isn\u2019t','isn\'t','wasn\u2019t','wasn\'t','weren\u2019t','weren\'t',
    'don\u2019t','don\'t','doesn\u2019t','doesn\'t','didn\u2019t','didn\'t',
    'won\u2019t','won\'t','wouldn\'t','wouldn\u2019t','couldn\u2019t','couldn\'t','shouldn\u2019t','shouldn\'t',
    'tell','show','give','ask',   // "tell me who..." style
  ]);

  // Chunk-safe variant used for intermediate finalized pieces: does NOT infer
  // terminal punctuation (that would drop periods mid-sentence when more speech
  // is coming). Only substitutes spoken words and cleans up whitespace.
  function humanizeVoiceChunk(raw) {
    if (!raw) return '';
    let text = raw.trim();
    const substitutions = [
      [/\s*\bnew paragraph\b\s*/gi, '\n\n'],
      [/\s*\bnew line\b\s*/gi, '\n'],
      [/\s*\bquestion mark\b\s*/gi, '? '],
      [/\s*\bexclamation (?:point|mark)\b\s*/gi, '! '],
      [/\s*\bperiod\b\s*/gi, '. '],
      [/\s*\bfull stop\b\s*/gi, '. '],
      [/\s*\bcomma\b\s*/gi, ', '],
      [/\s*\bsemicolon\b\s*/gi, '; '],
      [/\s*\bcolon\b\s*/gi, ': '],
      [/\s*\bdash\b\s*/gi, ' \u2014 '],
      [/\s*\bem dash\b\s*/gi, ' \u2014 '],
      [/\s*\bhyphen\b\s*/gi, '-'],
      [/\s*\bopen (?:quote|quotes|quotation mark)\b\s*/gi, ' \u201c'],
      [/\s*\bclose (?:quote|quotes|quotation mark)\b\s*/gi, '\u201d '],
    ];
    for (const [pattern, replacement] of substitutions) {
      text = text.replace(pattern, replacement);
    }
    text = text.replace(/\s+([,.;:!?])/g, '$1');
    text = text.replace(/[ \t]+/g, ' ').trim();
    text = text.replace(/(^|[.!?]\s+)([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());
    text = text.replace(/\bi\b/g, 'I');
    text = text.replace(/\bi'([a-z])/g, (_, c) => "I'" + c);
    return text;
  }

  function humanizeVoice(raw) {
    if (!raw) return '';
    let text = raw.trim();

    // Spoken punctuation → marks. Word boundaries; case-insensitive.
    // Order matters: multi-word phrases first.
    const substitutions = [
      [/\s*\bnew paragraph\b\s*/gi, '\n\n'],
      [/\s*\bnew line\b\s*/gi, '\n'],
      [/\s*\bquestion mark\b\s*/gi, '? '],
      [/\s*\bexclamation (?:point|mark)\b\s*/gi, '! '],
      [/\s*\bperiod\b\s*/gi, '. '],
      [/\s*\bfull stop\b\s*/gi, '. '],
      [/\s*\bcomma\b\s*/gi, ', '],
      [/\s*\bsemicolon\b\s*/gi, '; '],
      [/\s*\bcolon\b\s*/gi, ': '],
      [/\s*\bdash\b\s*/gi, ' \u2014 '],
      [/\s*\bem dash\b\s*/gi, ' \u2014 '],
      [/\s*\bhyphen\b\s*/gi, '-'],
      [/\s*\bopen (?:quote|quotes|quotation mark)\b\s*/gi, ' \u201c'],
      [/\s*\bclose (?:quote|quotes|quotation mark)\b\s*/gi, '\u201d '],
    ];
    for (const [pattern, replacement] of substitutions) {
      text = text.replace(pattern, replacement);
    }

    // Collapse whitespace and clean up spaces around punctuation
    text = text.replace(/\s+([,.;:!?])/g, '$1');
    text = text.replace(/[ \t]+/g, ' ').trim();

    // If the sentence still ends without terminal punctuation, guess one.
    // Look at first word to see whether it opens as a question.
    if (text && !/[.!?\u2026]$/.test(text)) {
      const firstWord = (text.match(/^([A-Za-z\u2019']+)/) || [])[1] || '';
      const isQuestion = QUESTION_STARTERS.has(firstWord.toLowerCase());
      text += isQuestion ? '?' : '.';
    }

    // Sentence-start capitalization
    text = text.replace(/(^|[.!?]\s+)([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());
    // "i" → "I"
    text = text.replace(/\bi\b/g, 'I');
    text = text.replace(/\bi'([a-z])/g, (_, c) => "I'" + c);

    return text;
  }

  function attachMic(micBtn, inputEl) {
    if (!micBtn || !inputEl || !voiceSupported) return;

    micBtn.addEventListener('click', (e) => {
      e.preventDefault();

      // Toggle off if this mic is already listening
      if (activeMicBtn === micBtn && activeRecognition) {
        stopRecognition();
        return;
      }
      // Stop any other mic that might be running
      if (activeRecognition) stopRecognition();

      // Construct fresh recognition each time (iOS is finicky about reuse)
      const rec = new SpeechRecognition();
      rec.lang = navigator.language || 'en-US';
      rec.interimResults = true;
      rec.continuous = false;   // iOS ignores true; keep false for consistency
      rec.maxAlternatives = 1;

      recognitionBaseText = inputEl.value.trim();
      activeRecognition = rec;
      activeMicBtn = micBtn;
      activeInputEl = inputEl;

      rec.onstart = () => {
        micBtn.classList.add('is-listening');
        micBtn.setAttribute('aria-label', 'Stop listening');
      };

      rec.onresult = (event) => {
        let interim = '';
        let finalPiece = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          const transcript = result[0].transcript;
          if (result.isFinal) finalPiece += transcript;
          else interim += transcript;
        }
        if (finalPiece) {
          // When a chunk finalizes, humanize it AND add terminal punctuation
          // to that chunk right away — iOS often chunks per sentence, so this
          // makes the '?' or '.' show up mid-stream instead of only at onend.
          const humanized = humanizeVoice(finalPiece.trim());
          recognitionBaseText = (recognitionBaseText
            ? recognitionBaseText + ' '
            : '') + humanized;
        }
        const composed = interim
          ? (recognitionBaseText ? recognitionBaseText + ' ' + interim : interim)
          : recognitionBaseText;
        inputEl.value = composed.trim();
        autoGrow(inputEl);
      };

      rec.onerror = (event) => {
        console.warn('Voice input error:', event.error);
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
          alert('Microphone permission was denied. To use voice input, allow microphone access in your browser settings.');
        } else if (event.error === 'no-speech') {
          // Silent — user just didn't speak; no need to alarm them
        } else if (event.error === 'audio-capture') {
          alert('No microphone was found. Check that your device has a microphone available.');
        }
      };

      rec.onend = () => {
        micBtn.classList.remove('is-listening');
        micBtn.setAttribute('aria-label', 'Ask by voice');
        if (activeRecognition === rec) {
          activeRecognition = null;
          activeMicBtn = null;
          activeInputEl = null;
        }
        // Final safety net — if any unpunctuated interim text made it into
        // the field, punctuate now that dictation is done.
        const finalText = humanizeVoice(inputEl.value);
        if (finalText !== inputEl.value) {
          inputEl.value = finalText;
          autoGrow(inputEl);
        }
        // Keep focus on the field so the user can either submit or keep typing
        try { inputEl.focus({ preventScroll: true }); } catch (_) {}
      };

      // CRITICAL: start synchronously inside the click handler for iOS Safari
      try {
        rec.start();
      } catch (err) {
        console.warn('Could not start voice recognition:', err);
        micBtn.classList.remove('is-listening');
        activeRecognition = null;
        activeMicBtn = null;
        activeInputEl = null;
      }
    });
  }

  attachMic(askMicBtn, askInput);
  attachMic(convMicBtn, convInput);

  // Stop listening if the user submits or navigates away
  askForm?.addEventListener('submit', stopRecognition);
  convForm?.addEventListener('submit', stopRecognition);
  window.addEventListener('hashchange', stopRecognition);

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

  let readSearchTerm = '';

  /**
   * Renders the Read view as a browsable index of all 66 books, split by
   * Old / New Testament. Books that contain verses spoken by Jesus get a
   * red-letter badge (count of his verses) so readers can find them fast.
   * A search field filters the words-of-Jesus verses; each match links into
   * the full-book view at the exact chapter:verse.
   */
  function renderRead() {
    if (!state.bibleCatalog.length) {
      readList.innerHTML =
        '<p class="book-loading">Loading the Bible…</p>';
      return;
    }
    // Are we in search mode? If so, show verse matches instead of the index.
    if (readSearchTerm) {
      renderReadSearchResults();
      renderJumpMenu();
      return;
    }
    // Otherwise: canonical index of all 66 books.
    const ot = state.bibleCatalog.filter((b) => b.testament === 'OT');
    const nt = state.bibleCatalog.filter((b) => b.testament === 'NT');

    const renderTile = (b) => {
      const jesusVerses = (state.byBook[b.name] || []).length;
      const badge = jesusVerses
        ? `<span class="book-tile__badge" title="${jesusVerses} verses spoken by Jesus">${jesusVerses.toLocaleString()}</span>`
        : '';
      return `
        <a href="#/read/${b.key}" class="book-tile${jesusVerses ? ' book-tile--jesus' : ''}" data-testid="link-book-${b.key}">
          <span class="book-tile__name">${escapeHtml(b.name)}</span>
          <span class="book-tile__meta">${b.chapters} ch</span>
          ${badge}
        </a>`;
    };

    readList.innerHTML = `
      <section class="testament">
        <header class="testament__header">
          <div class="testament__eyebrow">Old Testament</div>
          <div class="testament__count">${ot.length} books</div>
        </header>
        <div class="book-tiles">${ot.map(renderTile).join('')}</div>
      </section>
      <section class="testament">
        <header class="testament__header">
          <div class="testament__eyebrow">New Testament</div>
          <div class="testament__count">${nt.length} books · <span class="testament__jesus-note">6 contain his words</span></div>
        </header>
        <div class="book-tiles">${nt.map(renderTile).join('')}</div>
      </section>`;
    if (readEmpty) readEmpty.hidden = true;
    renderJumpMenu();
  }

  /**
   * When the reader types in the search box, we hunt across the 2,055 verses
   * Jesus spoke. Each hit renders as a compact card that links into the
   * full-book view at the matching chapter:verse.
   */
  function renderReadSearchResults() {
    const term = readSearchTerm;
    const matches = state.quotes.filter((q) =>
      (q.text || '').toLowerCase().includes(term),
    );
    if (!matches.length) {
      readList.innerHTML = '';
      if (readEmpty) readEmpty.hidden = false;
      return;
    }
    if (readEmpty) readEmpty.hidden = true;
    // Group by book for readability.
    const byBook = new Map();
    for (const m of matches) {
      if (!byBook.has(m.book)) byBook.set(m.book, []);
      byBook.get(m.book).push(m);
    }
    const highlight = (text) => {
      const lower = text.toLowerCase();
      const idx = lower.indexOf(term);
      if (idx < 0) return escapeHtml(text);
      return (
        escapeHtml(text.slice(0, idx)) +
        '<mark>' +
        escapeHtml(text.slice(idx, idx + term.length)) +
        '</mark>' +
        escapeHtml(text.slice(idx + term.length))
      );
    };
    let html = `<div class="search-summary">${matches.length.toLocaleString()} verse${matches.length === 1 ? '' : 's'} where Jesus said this.</div>`;
    for (const [bookName, verses] of byBook) {
      const key = slugBook(bookName);
      html += `
        <section class="search-book">
          <header class="search-book__header">${escapeHtml(bookName)}</header>`;
      for (const q of verses) {
        html += `
          <a class="search-hit" href="#/read/${key}?v=${q.chapter}:${q.verse}">
            <div class="search-hit__ref">${escapeHtml(bookName)} ${q.chapter}:${q.verse}</div>
            <p class="search-hit__text">${highlight(q.text)}</p>
          </a>`;
      }
      html += `</section>`;
    }
    readList.innerHTML = html;
  }

  function renderJumpMenu() {
    // Jump menu: every book in the Bible, testament-grouped.
    if (!state.bibleCatalog.length) { jumpMenu.innerHTML = ''; return; }
    const groups = { OT: 'Old Testament', NT: 'New Testament' };
    let html = '';
    for (const t of ['OT', 'NT']) {
      const books = state.bibleCatalog.filter((b) => b.testament === t);
      if (!books.length) continue;
      html += `<div class="jump-group-label">${groups[t]}</div>`;
      html += books.map((b) => {
        const jesus = (state.byBook[b.name] || []).length;
        return `
          <a href="#/read/${b.key}" data-book="${escapeAttr(b.name)}">
            <span>${escapeHtml(b.name)}</span>
            ${jesus ? `<span class="book-count">${jesus}</span>` : ''}
          </a>`;
      }).join('');
    }
    jumpMenu.innerHTML = html;
  }

  jumpToggle?.addEventListener('click', (e) => {
    e.stopPropagation();
    jumpMenu.hidden = !jumpMenu.hidden;
  });
  // Since jump items are now anchors that trigger the router, we just need to
  // close the menu on click. The hashchange listener does the rest.
  jumpMenu?.addEventListener('click', () => { jumpMenu.hidden = true; });
  document.addEventListener('click', () => { if (jumpMenu) jumpMenu.hidden = true; });

  readSearch?.addEventListener('input', () => {
    readSearchTerm = readSearch.value.trim().toLowerCase();
    renderRead();
  });

  // ============================== BOOKS ================================

  const booksGrid = $('#books-grid');

  function renderBooks() {
    if (!state.bibleCatalog.length) {
      booksGrid.innerHTML = '<p class="book-loading">Loading the Bible…</p>';
      return;
    }
    const ot = state.bibleCatalog.filter((b) => b.testament === 'OT');
    const nt = state.bibleCatalog.filter((b) => b.testament === 'NT');

    const renderCard = (b) => {
      const verses = state.byBook[b.name] || [];
      const isJesus = verses.length > 0;
      const lede = state.bookLedes[b.name];
      const stats = isJesus
        ? `<span class="book-card__count">${verses.length.toLocaleString()}</span> verses Jesus spoke · ${b.chapters} chapters`
        : `${b.chapters} ${b.chapters === 1 ? 'chapter' : 'chapters'} · ${b.verses.toLocaleString()} verses`;
      return `
        <a href="#/read/${b.key}" class="book-card${isJesus ? ' book-card--jesus' : ''}" data-testid="card-book-${b.key}">
          <div class="book-card__row">
            <h3 class="book-card__name">${escapeHtml(b.name)}</h3>
            ${isJesus ? '<span class="book-card__mark" aria-label="Contains words of Jesus">•</span>' : ''}
          </div>
          ${lede ? `<p class="book-card__lede">${escapeHtml(lede)}</p>` : ''}
          <div class="book-card__meta">${stats}</div>
        </a>`;
    };

    booksGrid.innerHTML = `
      <section class="books-testament">
        <header class="books-testament__header">
          <div class="books-testament__eyebrow">Old Testament</div>
          <div class="books-testament__count">${ot.length} books</div>
        </header>
        <div class="books-testament__grid">${ot.map(renderCard).join('')}</div>
      </section>
      <section class="books-testament">
        <header class="books-testament__header">
          <div class="books-testament__eyebrow">New Testament</div>
          <div class="books-testament__count">${nt.length} books · <span class="books-testament__jesus-note">six contain his words</span></div>
        </header>
        <div class="books-testament__grid">${nt.map(renderCard).join('')}</div>
      </section>`;
  }

  // ============================ SINGLE BOOK ===========================

  /**
   * Fetch a book's full WEB text (per-book file, ~65–145 KB).
   * Cached in state; concurrent calls share a single in-flight promise.
   */
  function loadBibleBook(bookName) {
    const slug = slugBook(bookName);
    if (state.bibleCache[slug]) return Promise.resolve(state.bibleCache[slug]);
    if (state.bibleLoading[slug]) return state.bibleLoading[slug];
    const p = fetch(`./bible/${slug}.json`)
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load ${slug}: ${res.status}`);
        return res.json();
      })
      .then((data) => {
        state.bibleCache[slug] = data;
        delete state.bibleLoading[slug];
        return data;
      })
      .catch((err) => {
        delete state.bibleLoading[slug];
        throw err;
      });
    state.bibleLoading[slug] = p;
    return p;
  }

  function updateReturnPill() {
    const pill = $('#return-pill');
    if (!pill) return;
    if (state.returnRef && state.returnRef.hash) {
      pill.setAttribute('href', state.returnRef.hash);
      pill.hidden = false;
    } else {
      pill.hidden = true;
    }
  }

  async function renderBook(bookName, targetVerse) {
    const meta = bookMetaFor(bookName);
    const lede = state.bookLedes[bookName] || '';
    $('#book-eyebrow').textContent = meta
      ? (meta.testament === 'OT' ? 'Old Testament' : 'New Testament')
      : '';
    $('#book-title').textContent = bookName;
    $('#book-lede').textContent = lede;
    updateReturnPill();

    const list = $('#book-list');
    list.innerHTML = '<p class="book-loading">Loading the full chapter…</p>';

    // Build a set of "chapter:verse" keys for verses Jesus spoke in this book.
    // Falls back to an empty set if quotes haven't loaded yet.
    const jesusVerses = new Set();
    for (const q of (state.byBook[bookName] || [])) {
      jesusVerses.add(`${q.chapter}:${q.verse}`);
    }

    let book;
    try {
      book = await loadBibleBook(bookName);
    } catch (err) {
      console.error(err);
      list.innerHTML =
        '<p class="book-loading">Couldn’t load this book. Check your connection and refresh.</p>';
      return;
    }

    const chapters = book.chapters || {};
    const chapterKeys = Object.keys(chapters).sort((a, b) => Number(a) - Number(b));

    let html = '';
    for (const ch of chapterKeys) {
      html += `
        <div class="chapter-divider" id="chapter-${ch}">
          <div class="chapter-divider__ornament">
            <span class="chapter-divider__label">Chapter ${ch}</span>
          </div>
        </div>
        <div class="chapter">`;
      for (const { v, t } of chapters[ch]) {
        const isJesus = jesusVerses.has(`${ch}:${v}`);
        html += `
          <p class="passage${isJesus ? ' passage--jesus' : ''}" id="v-${ch}-${v}" data-verse="${ch}:${v}">
            <span class="passage__num" aria-hidden="true">${v}</span><span class="passage__text">${escapeHtml(t)}</span>
          </p>`;
      }
      html += `</div>`;
    }
    list.innerHTML = html;

    // Deep-link: scroll target verse into view + briefly highlight it.
    if (targetVerse) {
      const [ch, vs] = String(targetVerse).split(':');
      const el = document.getElementById(`v-${ch}-${vs}`);
      if (el) {
        // Defer so layout + fonts settle before scrolling.
        requestAnimationFrame(() => {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.classList.add('verse--highlight');
          setTimeout(() => el.classList.remove('verse--highlight'), 2400);
        });
      }
    }
  }

  // ============================== Init ================================

  async function loadCatalog() {
    try {
      const res = await fetch('./bible/index.json');
      const data = await res.json();
      state.bibleCatalog = data.books || [];
      state.bookByKey = {};
      state.bookByName = {};
      for (const b of state.bibleCatalog) {
        state.bookByKey[b.key] = b;
        state.bookByName[b.name] = b;
      }
    } catch (err) {
      console.error('Failed to load Bible catalog', err);
    }
  }

  initTheme();
  // Route immediately for the home view; other views wait on data.
  route();
  // Kick off both loads in parallel; re-render when either finishes.
  Promise.all([loadCatalog(), loadQuotes()]).then(() => {
    // If we're on a data-dependent view, re-render now that data is loaded.
    if (state.view === 'read' || state.view === 'books' || state.view === 'book') {
      route();
    }
  });
})();
