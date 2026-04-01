// ============================================================
// flashcards.js
// ============================================================

let allCards = [];
let currentView = 'review';
let currentDueIndex = 0;
let currentCard = null;

document.addEventListener('DOMContentLoaded', async () => {
  await loadCards();
  applyUrlView();
  initListeners();
  render();
});

// ── URL / view ────────────────────────────────────────────────
function applyUrlView() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('view') === 'notebook') currentView = 'notebook';
}

// ── Event listeners ───────────────────────────────────────────
function initListeners() {
  document.getElementById('nav-review').addEventListener('click', () => switchView('review'));
  document.getElementById('nav-notebook').addEventListener('click', () => switchView('notebook'));

  const cardEl = document.getElementById('review-card');
  cardEl.addEventListener('click', onCardClick);
  cardEl.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onCardClick(); }
  });

  document.getElementById('flip-btn').addEventListener('click', () => flipCard());
  document.getElementById('next-btn').addEventListener('click', () => nextCard());
  document.getElementById('wrong-btn').addEventListener('click', () => gradeCard(false));
  document.getElementById('correct-btn').addEventListener('click', () => gradeCard(true));

  document.getElementById('nb-search').addEventListener('input', (e) => renderNotebook(e.target.value));

  document.getElementById('nb-pdf')?.addEventListener('click', () => downloadNotebookPdf());
}

function downloadNotebookPdf() {
  const prevView = currentView;
  const prevQuery = document.getElementById('nb-search')?.value || '';

  // Ensure notebook content is visible before printing.
  if (currentView !== 'notebook') switchView('notebook');
  else renderNotebook(prevQuery);

  const afterPrint = () => {
    window.removeEventListener('afterprint', afterPrint);
    if (prevView !== 'notebook') switchView(prevView);
    else renderNotebook(prevQuery);
  };
  window.addEventListener('afterprint', afterPrint);

  requestAnimationFrame(() => {
    // Expand everything for PDF output.
    document.querySelectorAll('.nb-entry').forEach(el => el.classList.add('expanded'));
    window.print();
  });
}

function switchView(view) {
  currentView = view;
  document.getElementById('nav-review').classList.toggle('active', view === 'review');
  document.getElementById('nav-notebook').classList.toggle('active', view === 'notebook');
  render();
}

// ── Storage ───────────────────────────────────────────────────
async function loadCards() {
  try {
    const res = await chrome.storage.local.get(['flashcards']);
    allCards = (res.flashcards || []).map(migrateCard);
    await chrome.storage.local.set({ flashcards: allCards });
  } catch (err) {
    console.error('loadCards error:', err);
    allCards = [];
  }
}

async function persistCards() {
  await chrome.storage.local.set({ flashcards: allCards });
}

// ── Render ────────────────────────────────────────────────────
function render() {
  document.getElementById('review-view').classList.toggle('hidden', currentView !== 'review');
  document.getElementById('notebook-view').classList.toggle('hidden', currentView !== 'notebook');
  if (currentView === 'review') renderReview();
  else renderNotebook(document.getElementById('nb-search').value);
}

// ── Review rendering ──────────────────────────────────────────
function renderReview() {
  const due = getDueCards();
  const emptyEl = document.getElementById('review-empty');
  const cardWrap = document.getElementById('card-wrap');
  const controls = document.getElementById('review-controls');
  const counter = document.getElementById('review-counter');

  if (!due.length) {
    currentCard = null;
    emptyEl.classList.remove('hidden');
    cardWrap.classList.add('hidden');
    controls.classList.add('hidden');
    counter.textContent = '';
    return;
  }

  emptyEl.classList.add('hidden');
  cardWrap.classList.remove('hidden');
  controls.classList.remove('hidden');

  // Keep index stable
  const prevWord = currentCard?.word;
  if (prevWord) {
    const idx = due.findIndex(c => c.word === prevWord);
    if (idx >= 0) currentDueIndex = idx;
  }
  if (currentDueIndex >= due.length) currentDueIndex = 0;
  currentCard = due[currentDueIndex];

  counter.textContent = `${currentDueIndex + 1} / ${due.length} due`;
  document.getElementById('next-btn').disabled = due.length <= 1;

  const cardEl = document.getElementById('review-card');
  cardEl.classList.remove('flipped');
  setGradeEnabled(false);

  // Front
  document.getElementById('card-front').innerHTML =
    `<div class="card-word">${escHtml(currentCard.word)}</div>
     <div class="card-hint">press to reveal</div>`;

  // Back
  document.getElementById('card-back').innerHTML = buildCardBack(currentCard);
}

function buildCardBack(card) {
  const meanings = (card.meanings || []).slice(0, 2);
  if (!meanings.length) return `<div class="card-def">No definition saved.</div>`;

  const items = meanings.map(m => {
    const pos = m.partOfSpeech ? `<span class="card-pos">${escHtml(m.partOfSpeech)}</span>` : '';
    const def = m.definition ? `<div class="card-def">${escHtml(norm(m.definition))}</div>` : '';

    const exArr = (m.examples || []).map(e => norm(e)).filter(Boolean).slice(0, 2);
    const exHtml = exArr.length
      ? `<span class="card-section-label">examples</span>
         <div class="card-examples">${exArr.map(e => `<div class="card-example">${escHtml(e)}</div>`).join('')}</div>`
      : '';

    const synArr = (m.synonyms || []).map(s => norm(s)).filter(Boolean).slice(0, 8);
    const synHtml = synArr.length
      ? `<span class="card-section-label">synonyms</span>
         <div class="card-syns">${synArr.map(s => `<span class="card-syn">${escHtml(s)}</span>`).join('')}</div>`
      : '';

    return `<div class="card-meaning">${pos}${def}${exHtml}${synHtml}</div>`;
  }).join('');

  const noteHtml = card.note
    ? `<div class="card-note">${escHtml(card.note)}</div>`
    : '';

  const llmHtml = buildLlmHtml(card.llm);

  return `<div class="card-meanings">${items}</div>${llmHtml}${noteHtml}`;
}

function buildLlmHtml(llm) {
  if (!llm || typeof llm !== 'object') return '';
  const where = norm(llm.whereToUse || '');
  const usage = norm(llm.usageNotes || '');
  const register = norm(llm.register || '');
  const examples = Array.isArray(llm.examples) ? llm.examples.map(e => norm(e)).filter(Boolean).slice(0, 3) : [];
  const tips = Array.isArray(llm.tips) ? llm.tips.map(t => norm(t)).filter(Boolean).slice(0, 4) : [];

  let out = '';
  if (where) out += `<span class="card-section-label">where to use</span><div class="card-llm-text">${escHtml(where)}</div>`;
  if (usage) out += `<span class="card-section-label">how to use</span><div class="card-llm-text">${escHtml(usage)}</div>`;
  if (register) out += `<span class="card-section-label">tone</span><div class="card-llm-text">${escHtml(register)}</div>`;
  if (examples.length) {
    out += `<span class="card-section-label">llm examples</span>`;
    out += `<div class="card-llm-list">${examples.map(e => `<div class="card-example">${escHtml(e)}</div>`).join('')}</div>`;
  }
  if (tips.length) {
    out += `<span class="card-section-label">tips</span>`;
    out += `<div class="card-llm-list">${tips.map(t => `<div class="card-llm-tip">${escHtml(t)}</div>`).join('')}</div>`;
  }
  if (!out) return '';
  return `<div class="card-llm">${out}</div>`;
}

function onCardClick() {
  if (!currentCard) return;
  flipCard();
}

function flipCard() {
  const cardEl = document.getElementById('review-card');
  cardEl.classList.toggle('flipped');
  setGradeEnabled(cardEl.classList.contains('flipped'));
}

function setGradeEnabled(yes) {
  document.getElementById('wrong-btn').disabled = !yes;
  document.getElementById('correct-btn').disabled = !yes;
}

function nextCard() {
  const due = getDueCards();
  if (!due.length) return;
  currentDueIndex = (currentDueIndex + 1) % due.length;
  currentCard = due[currentDueIndex];
  const cardEl = document.getElementById('review-card');
  cardEl.classList.remove('flipped');
  setGradeEnabled(false);
  document.getElementById('card-front').innerHTML =
    `<div class="card-word">${escHtml(currentCard.word)}</div><div class="card-hint">press to reveal</div>`;
  document.getElementById('card-back').innerHTML = buildCardBack(currentCard);
  document.getElementById('review-counter').textContent = `${currentDueIndex + 1} / ${due.length} due`;
  document.getElementById('next-btn').disabled = due.length <= 1;
}

async function gradeCard(isCorrect) {
  const idx = allCards.findIndex(c => c.word === currentCard.word);
  if (idx < 0) return;
  allCards[idx] = { ...allCards[idx], srs: updateSrs(allCards[idx].srs, isCorrect) };
  allCards[idx].nextReview = allCards[idx].srs.due;
  await persistCards();
  currentCard = null;
  renderReview();
}

// ── Notebook rendering ────────────────────────────────────────
function renderNotebook(query = '') {
  const q = query.toLowerCase().trim();
  const sorted = [...allCards]
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .filter(c => !q || c.word.toLowerCase().includes(q) ||
      (c.meanings?.[0]?.definition || '').toLowerCase().includes(q) ||
      (c.note || '').toLowerCase().includes(q));

  const emptyEl = document.getElementById('notebook-empty');
  const listEl  = document.getElementById('nb-list');
  const countEl = document.getElementById('nb-count');

  countEl.textContent = `${sorted.length} word${sorted.length !== 1 ? 's' : ''}`;

  if (!sorted.length) {
    emptyEl.classList.remove('hidden');
    listEl.innerHTML = '';
    return;
  }
  emptyEl.classList.add('hidden');

  const now = Date.now();
  listEl.innerHTML = sorted.map(card => {
    const isDue = (card.srs?.due ?? card.nextReview ?? 0) <= now;
    const reps  = card.srs?.repetitions ?? 0;
    const badgeCls = reps >= 3 ? 'learned' : isDue ? 'due' : '';
    const badgeText = reps >= 3 ? 'learned' : isDue ? 'due' : `in ${timeUntilShort(card.srs?.due)}`;
    const source = card.source === 'gpt4' ? 'gpt-4.1' : 'wiktionary';

    const meaningsHtml = (card.meanings || []).slice(0, 2).map(m => {
      const pos = m.partOfSpeech ? `<span class="nb-pos">${escHtml(m.partOfSpeech)}</span>` : '';
      const def = m.definition ? `<div class="nb-def">${escHtml(norm(m.definition))}</div>` : '';
      const exArr = (m.examples || []).map(e => norm(e)).filter(Boolean).slice(0, 2);
      const exHtml = exArr.length
        ? `<span class="nb-section-label">examples</span>
           <div class="nb-examples">${exArr.map(e => `<div class="nb-example">${escHtml(e)}</div>`).join('')}</div>`
        : '';
      const synArr = (m.synonyms || []).map(s => norm(s)).filter(Boolean).slice(0, 8);
      const synHtml = synArr.length
        ? `<span class="nb-section-label">synonyms</span>
           <div class="nb-syns">${synArr.map(s => `<span class="nb-syn">${escHtml(s)}</span>`).join('')}</div>`
        : '';
      return `<div class="nb-meaning">${pos}${def}${exHtml}${synHtml}</div>`;
    }).join('');

    const llmHtml = buildNotebookLlmHtml(card.llm);

    const noteHtml = `
      <div class="nb-notes-wrap" data-word="${escAttr(card.word)}">
        <span class="nb-section-label">notes</span>
        <div class="nb-note-display">${escHtml(card.note || '')}</div>
        <textarea class="nb-note-textarea" rows="3" placeholder="add a note…">${escHtml(card.note || '')}</textarea>
      </div>`;

    return `
      <div class="nb-entry" data-word="${escAttr(card.word)}">
        <div class="nb-entry-head">
          <div>
            <span class="nb-word">${escHtml(card.word)}</span>
            <span class="nb-source">${source}</span>
          </div>
          <span class="nb-srs-badge ${badgeCls}">${badgeText}</span>
        </div>
        <div class="nb-entry-body">
          ${meaningsHtml}
          ${llmHtml}
          ${noteHtml}
          <div class="nb-entry-actions">
            <button class="nb-action-btn nb-note-edit-btn">edit note</button>
            <button class="nb-action-btn delete nb-delete-btn">delete</button>
          </div>
        </div>
      </div>`;
  }).join('');

  // Attach interactions
  listEl.querySelectorAll('.nb-entry').forEach(entry => {
    const word = entry.getAttribute('data-word');

    // Expand/collapse on head click
    entry.querySelector('.nb-entry-head').addEventListener('click', () => {
      entry.classList.toggle('expanded');
    });

    // Note editing
    const notesWrap = entry.querySelector('.nb-notes-wrap');
    const noteDisplay = entry.querySelector('.nb-note-display');
    const noteTA = entry.querySelector('.nb-note-textarea');
    const editBtn = entry.querySelector('.nb-note-edit-btn');

    const startEdit = () => {
      notesWrap.classList.add('editing');
      noteTA.focus();
      editBtn.textContent = 'save note';
    };
    const saveNote = async () => {
      const val = noteTA.value;
      noteDisplay.textContent = val;
      notesWrap.classList.remove('editing');
      editBtn.textContent = 'edit note';
      const idx = allCards.findIndex(c => c.word === word);
      if (idx >= 0) { allCards[idx].note = val; await persistCards(); }
    };

    noteDisplay.addEventListener('click', (e) => { e.stopPropagation(); entry.classList.add('expanded'); startEdit(); });
    editBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (notesWrap.classList.contains('editing')) await saveNote();
      else startEdit();
    });
    noteTA.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); await saveNote(); }
      e.stopPropagation();
    });

    // Delete
    entry.querySelector('.nb-delete-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${word}"?`)) return;
      allCards = allCards.filter(c => c.word !== word);
      await persistCards();
      renderNotebook(document.getElementById('nb-search').value);
    });
  });
}

// ── SRS ───────────────────────────────────────────────────────
function getDueCards() {
  const now = Date.now();
  return allCards
    .filter(c => (c.srs?.due ?? c.nextReview ?? 0) <= now)
    .sort((a, b) => (a.srs?.due ?? 0) - (b.srs?.due ?? 0));
}

function updateSrs(srs, isCorrect) {
  const now = Date.now();
  const next = { ...srs };
  const MIN_EF = 1.3;

  if (!isCorrect) {
    next.repetitions = 0;
    next.intervalDays = 0;
    next.easeFactor = Math.max(MIN_EF, (next.easeFactor || 2.5) - 0.2);
    next.due = now + 10 * 60 * 1000; // 10 min
    return next;
  }

  next.repetitions = (next.repetitions || 0) + 1;
  next.easeFactor = Math.max(MIN_EF, (next.easeFactor || 2.5) + 0.1);

  if (next.repetitions === 1)      next.intervalDays = 1;
  else if (next.repetitions === 2) next.intervalDays = 6;
  else next.intervalDays = Math.max(1, Math.round((next.intervalDays || 6) * next.easeFactor));

  next.due = now + next.intervalDays * 86400000;
  return next;
}

// ── Migration ─────────────────────────────────────────────────
function migrateCard(card) {
  const c = { ...card };
  if (!c.timestamp) c.timestamp = Date.now();
  if (!Array.isArray(c.meanings)) c.meanings = [];
  c.meanings = c.meanings.map(m => ({
    partOfSpeech: m.partOfSpeech || '',
    definition: norm(m.definition || ''),
    examples: (m.examples || []).map(e => norm(String(e))).filter(Boolean),
    synonyms: (m.synonyms || []).map(s => norm(String(s))).filter(Boolean)
  }));
  if (!c.srs) {
    c.srs = {
      repetitions: c.learned ? 3 : (c.reviewCount || 0),
      intervalDays: c.learned ? 30 : 0,
      easeFactor: 2.5,
      due: typeof c.nextReview === 'number' ? c.nextReview : Date.now()
    };
  }
  if (typeof c.srs.easeFactor  !== 'number') c.srs.easeFactor  = 2.5;
  if (typeof c.srs.repetitions !== 'number') c.srs.repetitions = 0;
  if (typeof c.srs.intervalDays!== 'number') c.srs.intervalDays= 0;
  if (typeof c.srs.due         !== 'number') c.srs.due         = Date.now();
  c.nextReview = c.srs.due;
  if (!c.note) c.note = '';
  if (c.llm && typeof c.llm !== 'object') c.llm = null;
  return c;
}

function buildNotebookLlmHtml(llm) {
  if (!llm || typeof llm !== 'object') return '';
  const where = norm(llm.whereToUse || '');
  const usage = norm(llm.usageNotes || '');
  const register = norm(llm.register || '');
  const examples = Array.isArray(llm.examples) ? llm.examples.map(e => norm(e)).filter(Boolean).slice(0, 3) : [];
  const tips = Array.isArray(llm.tips) ? llm.tips.map(t => norm(t)).filter(Boolean).slice(0, 4) : [];

  let html = '<div class="nb-llm">';
  html += '<span class="nb-section-label">ask llm</span>';
  if (where) html += `<div class="nb-llm-text"><span class="nb-llm-k">where</span> ${escHtml(where)}</div>`;
  if (usage) html += `<div class="nb-llm-text"><span class="nb-llm-k">how</span> ${escHtml(usage)}</div>`;
  if (register) html += `<div class="nb-llm-text"><span class="nb-llm-k">tone</span> ${escHtml(register)}</div>`;

  if (examples.length) {
    html += `<div class="nb-llm-list">${examples.map(e => `<div class="nb-example">${escHtml(e)}</div>`).join('')}</div>`;
  }
  if (tips.length) {
    html += `<div class="nb-llm-tips">${tips.map(t => `<div class="nb-llm-tip">${escHtml(t)}</div>`).join('')}</div>`;
  }
  html += '</div>';
  return html;
}

// ── Utils ─────────────────────────────────────────────────────
function norm(text) {
  const s = String(text ?? '');
  if (!s) return '';
  if (!/<\/?[a-z][\s\S]*>/i.test(s) && !s.includes('mw:WikiLink')) return s.replace(/\s+/g, ' ').trim();
  try {
    const doc = new DOMParser().parseFromString(s, 'text/html');
    return (doc.body?.textContent || s).replace(/\s+/g, ' ').trim();
  } catch {
    return s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }
}

function daysUntil(ts) {
  if (!ts) return '?';
  const d = Math.ceil((ts - Date.now()) / 86400000);
  return Math.max(0, d);
}

function timeUntilShort(ts) {
  if (!ts) return '?';
  const ms = ts - Date.now();
  if (ms <= 0) return 'now';

  const min = Math.ceil(ms / 60000);
  if (min < 60) return `${min}m`;

  const hr = Math.ceil(ms / 3600000);
  if (hr < 24) return `${hr}h`;

  const d = Math.ceil(ms / 86400000);
  return `${d}d`;
}

function escHtml(t) {
  return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

function escAttr(t) { return escHtml(t).replace(/\s+/g,' ').trim(); }
