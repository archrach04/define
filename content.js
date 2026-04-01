// ============================================================
// content.js — injected into every page
// ============================================================

chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'showDefinition') {
    showDefinitionPopup(request.word);
  }
});

// ── Popup state ───────────────────────────────────────────────
let pendingNote = '';
let pendingData = null;
let pendingLlm = null;

// ── Interaction state (dblclick then click) ───────────────────
let armedSelection = null; // { word: string, rect: DOMRect, armedAt: number }
let armedSelectionTimer = null;
let lastPopupOpenedAt = 0;

const ARMED_SELECTION_TIMEOUT_MS = 4500;
const ARMED_RECT_PAD_PX = 6;

const POPUP_VIEWPORT_PAD_PX = 12;

const AUDIO_ICON_SPEAKER = '🔊';
const AUDIO_ICON_STOP = '⏹';

let llmRequestInFlight = false;

// ── Main entry ────────────────────────────────────────────────
async function showDefinitionPopup(word) {
  removeExistingPopup();
  pendingNote = '';
  pendingData = null;
  pendingLlm = null;

  lastPopupOpenedAt = performance.now();

  const popup = createPopup();
  document.body.appendChild(popup);
  positionPopup(popup);
  ensurePopupInViewport(popup);
  makeDraggable(popup, popup.querySelector('.wf-header'));

  popup.querySelector('.wf-close').addEventListener('click', removeExistingPopup);
  popup.querySelector('.wf-open-flashcards')?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: '_openTab', url: 'flashcards.html?view=notebook' });
    removeExistingPopup();
  });

  popup.querySelector('.wf-ask-llm')?.addEventListener('click', async () => {
    if (llmRequestInFlight) return;
    const currentWord = pendingData?.word || word;
    if (!currentWord) return;
    await runAskLlmFlow(popup, currentWord);
  });

  // Audio playback for providers that return an mp3 URL.
  const audioBtn = popup.querySelector('.wf-audio');
  let audioEl = null;
  audioBtn?.addEventListener('click', async () => {
    const url = audioBtn.dataset?.audioUrl || '';
    if (!url) return;

    if (!audioEl) {
      audioEl = new Audio(url);
      audioEl.addEventListener('ended', () => {
        if (audioBtn) audioBtn.textContent = AUDIO_ICON_SPEAKER;
      });
    }

    // Toggle play/pause
    if (!audioEl.paused) {
      audioEl.pause();
      audioEl.currentTime = 0;
      audioBtn.textContent = AUDIO_ICON_SPEAKER;
      return;
    }

    try {
      audioEl.src = url;
      await audioEl.play();
      audioBtn.textContent = AUDIO_ICON_STOP;
    } catch {
      // If playback is blocked/fails, just leave button as-is.
      audioBtn.textContent = AUDIO_ICON_SPEAKER;
    }
  });

  try {
    const resp = await chrome.runtime.sendMessage({ action: 'fetchDefinition', word });
    if (resp.success) {
      renderDefinition(popup, resp.data);
      ensurePopupInViewport(popup);
    } else if (resp.error === 'NO_API_KEY' || resp.error === 'NO_GEMINI_KEY') {
      renderNoApiKey(popup, word, resp.error);
      ensurePopupInViewport(popup);
    } else {
      renderError(popup, resp.error || 'Unknown error');
      ensurePopupInViewport(popup);
    }
  } catch (err) {
    renderError(popup, 'Failed to reach extension background');
    ensurePopupInViewport(popup);
  }
}

function createPopup() {
  const el = document.createElement('div');
  el.id = 'wf-popup';
  el.className = 'wf-popup';
  el.innerHTML = `
    <div class="wf-popup-inner">
      <div class="wf-header">
        <div class="wf-header-left">
          <div class="wf-word">…</div>
        </div>
        <div class="wf-header-actions">
          <button class="wf-audio" type="button" aria-label="Play pronunciation" style="display:none">🔊</button>
          <button class="wf-ask-llm" type="button" aria-label="Ask LLM">ask llm</button>
          <button class="wf-open-flashcards" type="button" aria-label="Open flashcards">flashcards</button>
          <button class="wf-close" type="button" aria-label="Close">✕</button>
        </div>
      </div>
      <div class="wf-body">
        <div class="wf-loader">
          <div class="wf-loader-dots"><span></span><span></span><span></span></div>
          <span>looking up…</span>
        </div>
      </div>
    </div>`;
  return el;
}

async function runAskLlmFlow(popup, text) {
  llmRequestInFlight = true;
  const askBtn = popup?.querySelector?.('.wf-ask-llm');
  if (askBtn) {
    askBtn.disabled = true;
    askBtn.textContent = '…';
  }

  const body = popup.querySelector('.wf-body');
  const section = upsertLlmSection(body);
  section.querySelector('.wf-llm-content').innerHTML = `
    <div class="wf-loader wf-llm-loader">
      <div class="wf-loader-dots"><span></span><span></span><span></span></div>
      <span>thinking…</span>
    </div>`;

  try {
    const keyResp = await chrome.runtime.sendMessage({ action: 'getGeminiKey' });
    const key = keyResp?.key || '';
    if (!key) {
      section.querySelector('.wf-llm-content').innerHTML = '';
      renderInlineGeminiKeyPrompt(section.querySelector('.wf-llm-content'), async () => {
        await runAskLlmFlow(popup, text);
      });
      return;
    }

    const resp = await chrome.runtime.sendMessage({ action: 'askLLM', text });
    if (!resp?.success) {
      if (resp?.error === 'NO_GEMINI_KEY') {
        section.querySelector('.wf-llm-content').innerHTML = '';
        renderInlineGeminiKeyPrompt(section.querySelector('.wf-llm-content'), async () => {
          await runAskLlmFlow(popup, text);
        });
      } else {
        section.querySelector('.wf-llm-content').innerHTML = `<div class="wf-llm-error">${escHtml(resp?.error || 'LLM request failed')}</div>`;
      }
      return;
    }

    pendingLlm = resp.data;
    if (pendingData && typeof pendingData === 'object') pendingData.llm = resp.data;
    renderLlmDeepDive(section.querySelector('.wf-llm-content'), resp.data);

    // If the card already exists in storage, update it immediately so the
    // flashcards page reflects the new LLM notes even before clicking “save card”.
    try {
      const result = await chrome.storage.local.get(['flashcards']);
      const cards = result.flashcards || [];
      const idx = cards.findIndex(c => c.word === (pendingData?.word || text));
      if (idx >= 0) {
        cards[idx] = { ...cards[idx], llm: resp.data };
        await chrome.storage.local.set({ flashcards: cards });
      }
    } catch {
      // ignore
    }
  } catch (e) {
    section.querySelector('.wf-llm-content').innerHTML = `<div class="wf-llm-error">Failed to reach extension background</div>`;
  } finally {
    llmRequestInFlight = false;
    if (askBtn) {
      askBtn.disabled = false;
      askBtn.textContent = 'ask llm';
    }
    ensurePopupInViewport(popup);
  }
}

function upsertLlmSection(bodyEl) {
  let section = bodyEl.querySelector('.wf-llm-section');
  if (section) return section;

  section = document.createElement('div');
  section.className = 'wf-llm-section';
  section.innerHTML = `
    <span class="wf-label">ask llm</span>
    <div class="wf-llm-content"></div>`;
  bodyEl.appendChild(section);
  return section;
}

function renderLlmDeepDive(container, data) {
  const where = normalizeText(data?.whereToUse || '');
  const usage = normalizeText(data?.usageNotes || '');
  const register = normalizeText(data?.register || '');
  const examples = Array.isArray(data?.examples) ? data.examples.map(e => normalizeText(e)).filter(Boolean).slice(0, 3) : [];
  const tips = Array.isArray(data?.tips) ? data.tips.map(t => normalizeText(t)).filter(Boolean).slice(0, 4) : [];

  let html = '';
  if (where) html += `<span class="wf-label">where to use</span><div class="wf-llm-text">${escHtml(where)}</div>`;
  if (usage) html += `<span class="wf-label">how to use</span><div class="wf-llm-text">${escHtml(usage)}</div>`;
  if (register) html += `<span class="wf-label">tone</span><div class="wf-llm-text">${escHtml(register)}</div>`;

  if (examples.length) {
    html += `<span class="wf-label">examples</span><div class="wf-llm-list">`;
    for (const ex of examples) html += `<div class="wf-llm-item">${escHtml(ex)}</div>`;
    html += `</div>`;
  }

  if (tips.length) {
    html += `<span class="wf-label">tips</span><div class="wf-llm-list">`;
    for (const tip of tips) html += `<div class="wf-llm-item">${escHtml(tip)}</div>`;
    html += `</div>`;
  }

  if (!html) html = `<div class="wf-llm-error">No LLM notes returned</div>`;
  container.innerHTML = html;
}

function renderInlineGeminiKeyPrompt(container, onSaved) {
  container.innerHTML = `
    <div class="wf-llm-key">
      <div class="wf-llm-key-title">Gemini API key required</div>
      <div class="wf-llm-key-row">
        <input class="wf-llm-key-input" type="password" placeholder="AIza..." />
        <button class="wf-llm-key-save" type="button">save</button>
      </div>
    </div>`;

  container.querySelector('.wf-llm-key-save').addEventListener('click', async () => {
    const key = container.querySelector('.wf-llm-key-input').value.trim();
    if (!key) return;
    await chrome.runtime.sendMessage({ action: 'saveGeminiKey', key });
    onSaved?.();
  });
}

function removeExistingPopup() {
  document.getElementById('wf-popup')?.remove();
}

function ensurePopupInViewport(popup) {
  if (!popup) return;
  const pad = POPUP_VIEWPORT_PAD_PX;

  const pr = popup.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Current numeric position (fallback to current rect values)
  const currentTop = Number.parseFloat(popup.style.top) || pr.top;
  const currentLeft = Number.parseFloat(popup.style.left) || pr.left;

  const maxLeft = Math.max(pad, vw - pr.width - pad);
  const maxTop = Math.max(pad, vh - pr.height - pad);

  const nextLeft = Math.min(Math.max(pad, currentLeft), maxLeft);
  const nextTop = Math.min(Math.max(pad, currentTop), maxTop);

  popup.style.top = `${nextTop}px`;
  popup.style.left = `${nextLeft}px`;
}

function clearArmedSelection() {
  armedSelection = null;
  if (armedSelectionTimer) {
    clearTimeout(armedSelectionTimer);
    armedSelectionTimer = null;
  }
}

function isEditableTarget(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  return false;
}

function isLikelySingleWord(text) {
  const t = String(text || '').trim().replace(/\s+/g, ' ');
  if (!t) return false;
  if (t.length > 50) return false;
  // Allow letters/numbers with internal apostrophes or hyphens.
  if (/\s/.test(t)) return false;
  return /^[\p{L}\p{N}]+([\-’'][\p{L}\p{N}]+)*$/u.test(t);
}

function isClickInsideRect(e, rect, padPx) {
  const pad = padPx || 0;
  const x = e.clientX;
  const y = e.clientY;
  return (
    x >= rect.left - pad &&
    x <= rect.right + pad &&
    y >= rect.top - pad &&
    y <= rect.bottom + pad
  );
}

// ── Rendering ─────────────────────────────────────────────────
function renderDefinition(popup, data) {
  popup.querySelector('.wf-word').textContent = data.word;

  const sourceBadge =
    data.source === 'gpt4' ? 'gpt-4.1' :
    data.source === 'gemini' ? 'gemini' :
    data.source === 'dictionaryapi' ? '' :
    'wiktionary';
  const headerLeft = popup.querySelector('.wf-header-left');
  if (sourceBadge) {
    const badgeEl = document.createElement('div');
    badgeEl.className = 'wf-source-badge';
    badgeEl.textContent = sourceBadge;
    headerLeft.appendChild(badgeEl);
  }

  // Audio button
  const audioBtn = popup.querySelector('.wf-audio');
  const audioUrl = String(data.audioUrl || '').trim();
  if (audioBtn) {
    audioBtn.dataset.audioUrl = audioUrl;
    audioBtn.style.display = audioUrl ? '' : 'none';
    audioBtn.textContent = AUDIO_ICON_SPEAKER;
  }

  const body = popup.querySelector('.wf-body');
  body.innerHTML = '';

  const meanings = Array.isArray(data.meanings) ? data.meanings.slice(0, 2) : [];

  for (const m of meanings) {
    const block = document.createElement('div');
    block.className = 'wf-meaning';

    const pos = m.partOfSpeech || '';
    const def = m.definition ? normalizeText(m.definition) : '';
    const examples = (m.examples || []).map(e => normalizeText(e)).filter(Boolean).slice(0, 2);
    const synonyms = (m.synonyms || []).map(s => normalizeText(s)).filter(Boolean).slice(0, 8);

    let html = pos ? `<span class="wf-pos">${escHtml(pos)}</span>` : '';
    if (def) html += `<div class="wf-definition">${escHtml(def)}</div>`;

    if (examples.length) {
      html += `<span class="wf-label">examples</span><div class="wf-examples">`;
      for (const ex of examples) {
        html += `<div class="wf-example-text">${escHtml(ex)}</div>`;
      }
      html += `</div>`;
    }

    if (synonyms.length) {
      html += `<span class="wf-label">synonyms</span><div class="wf-synonyms-list">`;
      for (const syn of synonyms) {
        html += `<span class="wf-syn">${escHtml(syn)}</span>`;
      }
      html += `</div>`;
    }

    block.innerHTML = html;
    body.appendChild(block);
  }

  // Notes
  const notesSection = document.createElement('div');
  notesSection.className = 'wf-notes-section';
  notesSection.innerHTML = `<span class="wf-label">notes</span><textarea class="wf-notes" placeholder="add a note…" rows="2"></textarea>`;
  body.appendChild(notesSection);

  // Pre-fill existing note if any
  chrome.storage.local.get(['flashcards'], (result) => {
    const cards = result.flashcards || [];
    const existing = cards.find(c => c.word === data.word);
    if (existing?.note) {
      notesSection.querySelector('.wf-notes').value = existing.note;
    }
  });

  notesSection.querySelector('.wf-notes').addEventListener('input', (e) => {
    pendingNote = e.target.value;
  });

  pendingData = data;

  // Footer
  const inner = popup.querySelector('.wf-popup-inner');
  const footer = document.createElement('div');
  footer.className = 'wf-footer';
  footer.innerHTML = `
    <button class="wf-btn wf-btn-save">save card</button>`;
  inner.appendChild(footer);

  footer.querySelector('.wf-btn-save').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const noteVal = popup.querySelector('.wf-notes')?.value || '';
    await saveFlashcard(data, noteVal);
    btn.textContent = 'saved ✓';
    btn.classList.add('saved');
    setTimeout(() => { btn.textContent = 'save card'; btn.classList.remove('saved'); }, 2200);
  });
}

function renderNoApiKey(popup, word, errCode) {
  popup.querySelector('.wf-word').textContent = word;
  const body = popup.querySelector('.wf-body');
  const isGemini = errCode === 'NO_GEMINI_KEY';
  const title = isGemini ? 'gemini api key required' : 'api key required';
  const msg = isGemini
    ? 'Enter your Gemini API key to look up phrases and idioms.'
    : 'Enter your GitHub Models API key to look up phrases and as fallback.';
  const placeholder = isGemini ? 'AIza... (Gemini API key)' : 'ghp_... or GitHub Models token';
  const saveAction = isGemini ? 'saveGeminiKey' : 'saveApiKey';

  body.innerHTML = `
    <div class="wf-error">
      <span class="wf-error-code">${escHtml(title)}</span>
      <div class="wf-error-msg">${escHtml(msg)}</div>
      <div class="wf-error-key-form">
        <input class="wf-key-input" type="password" placeholder="${escHtml(placeholder)}" />
        <button class="wf-key-save-btn">save</button>
      </div>
    </div>`;

  body.querySelector('.wf-key-save-btn').addEventListener('click', async () => {
    const key = body.querySelector('.wf-key-input').value.trim();
    if (!key) return;
    await chrome.runtime.sendMessage({ action: saveAction, key });
    // retry
    removeExistingPopup();
    showDefinitionPopup(word);
  });
}

function renderError(popup, msg) {
  const body = popup.querySelector('.wf-body');
  body.innerHTML = `
    <div class="wf-error">
      <span class="wf-error-code">error</span>
      <div class="wf-error-msg">${escHtml(msg)}</div>
    </div>`;
}

// ── Save flashcard ─────────────────────────────────────────────
async function saveFlashcard(data, note) {
  try {
    const result = await chrome.storage.local.get(['flashcards']);
    const cards = result.flashcards || [];
    const now = Date.now();
    const existingIdx = cards.findIndex(c => c.word === data.word);
    const existing = existingIdx >= 0 ? cards[existingIdx] : null;

    const card = {
      word: data.word,
      source: data.source || 'wiktionary',
      meanings: (data.meanings || []).map(m => ({
        partOfSpeech: m.partOfSpeech || '',
        definition: normalizeText(m.definition || ''),
        examples: (m.examples || []).map(e => normalizeText(e)).filter(Boolean).slice(0, 2),
        synonyms: (m.synonyms || []).map(s => normalizeText(s)).filter(Boolean).slice(0, 8)
      })),
      llm: pendingLlm || data.llm || existing?.llm || null,
      note: note || existing?.note || '',
      timestamp: existing?.timestamp || now,
      reviewCount: existing?.reviewCount || 0,
      nextReview: existing?.nextReview || now,
      srs: existing?.srs || { repetitions: 0, intervalDays: 0, easeFactor: 2.5, due: now }
    };

    if (existingIdx >= 0) cards[existingIdx] = card;
    else cards.push(card);

    await chrome.storage.local.set({ flashcards: cards });
  } catch (err) {
    console.error('saveFlashcard error:', err);
  }
}

// ── Draggable ─────────────────────────────────────────────────
function makeDraggable(el, handle) {
  let startX, startY, startLeft, startTop;

  handle.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target?.closest?.('button, a, input, textarea, select, [role="button"]')) return;
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    startX = e.clientX; startY = e.clientY;
    startLeft = rect.left; startTop = rect.top;
    el.style.position = 'fixed';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp, { once: true });
  });

  function onMove(e) {
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = el.offsetWidth, h = el.offsetHeight;
    const pad = POPUP_VIEWPORT_PAD_PX;
    const left = Math.max(pad, Math.min(Math.max(pad, vw - w - pad), startLeft + dx));
    const top  = Math.max(pad, Math.min(Math.max(pad, vh - h - pad), startTop  + dy));
    el.style.left = `${left}px`;
    el.style.top  = `${top}px`;
  }

  function onUp() {
    document.removeEventListener('mousemove', onMove);
  }
}

// ── Popup positioning ─────────────────────────────────────────
function positionPopup(popup) {
  const sel = window.getSelection();
  const pad = 12;
  let top = 100, left = 100;

  if (sel && sel.rangeCount > 0) {
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    top = rect.bottom + pad;
    left = rect.left;
  }

  popup.style.top  = `${Math.max(pad, top)}px`;
  popup.style.left = `${Math.max(pad, left)}px`;

  requestAnimationFrame(() => {
    const pr = popup.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    if (pr.bottom > vh - pad) top = (sel?.rangeCount > 0 ? sel.getRangeAt(0).getBoundingClientRect().top : top) - pr.height - pad;
    top  = Math.min(Math.max(pad, top),  Math.max(pad, vh - pr.height - pad));
    left = Math.min(Math.max(pad, left), Math.max(pad, vw - pr.width  - pad));
    popup.style.top  = `${top}px`;
    popup.style.left = `${left}px`;
  });
}

// ── Helpers ───────────────────────────────────────────────────
function normalizeText(text) {
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

function escHtml(t) {
  return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

// ── Close on outside click / Escape ──────────────────────────
document.addEventListener('dblclick', (e) => {
  // Arm only for plain page text; ignore editable fields.
  if (isEditableTarget(e.target)) {
    clearArmedSelection();
    return;
  }

  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) {
    clearArmedSelection();
    return;
  }

  const text = sel.toString().trim();
  if (!isLikelySingleWord(text)) {
    clearArmedSelection();
    return;
  }

  let rect;
  try {
    rect = sel.getRangeAt(0).getBoundingClientRect();
  } catch {
    clearArmedSelection();
    return;
  }

  if (!rect || (rect.width === 0 && rect.height === 0)) {
    clearArmedSelection();
    return;
  }

  armedSelection = { word: text, rect, armedAt: performance.now() };
  if (armedSelectionTimer) clearTimeout(armedSelectionTimer);
  armedSelectionTimer = setTimeout(clearArmedSelection, ARMED_SELECTION_TIMEOUT_MS);
});

document.addEventListener('click', (e) => {
  // Trigger: double-click to select a word, then click the same word again.
  if (armedSelection && (performance.now() - armedSelection.armedAt) <= ARMED_SELECTION_TIMEOUT_MS) {
    // Don’t steal clicks on links.
    const anchor = e.target?.closest?.('a[href]');
    if (!anchor && isClickInsideRect(e, armedSelection.rect, ARMED_RECT_PAD_PX)) {
      const word = armedSelection.word;
      clearArmedSelection();
      showDefinitionPopup(word);
      // Prevent the outside-click closer from immediately removing the popup.
      e.stopPropagation();
      return;
    }
  }

  const popup = document.getElementById('wf-popup');
  if (!popup) return;

  // Ignore the same click event that just opened the popup.
  if (performance.now() - lastPopupOpenedAt < 120) return;

  if (!popup.contains(e.target)) removeExistingPopup();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') removeExistingPopup();
});

document.addEventListener('scroll', clearArmedSelection, true);

window.addEventListener('resize', () => {
  const popup = document.getElementById('wf-popup');
  if (popup) ensurePopupInViewport(popup);
});
