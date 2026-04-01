document.addEventListener('DOMContentLoaded', async () => {
  await loadDashboard();
  await loadApiKey();
  initListeners();
});

function initListeners() {
  document.getElementById('review-btn').addEventListener('click', () => {
    chrome.tabs.create({ url: 'flashcards.html' });
  });
  document.getElementById('notebook-btn').addEventListener('click', () => {
    chrome.tabs.create({ url: 'flashcards.html?view=notebook' });
  });
  document.getElementById('api-key-save').addEventListener('click', async () => {
    const key = document.getElementById('api-key-input').value.trim();
    if (!key) return;
    await chrome.storage.local.set({ githubModelsApiKey: key });
    const ind = document.getElementById('api-saved');
    ind.classList.add('visible');
    setTimeout(() => ind.classList.remove('visible'), 2500);
  });
}

async function loadApiKey() {
  const res = await chrome.storage.local.get(['githubModelsApiKey']);
  if (res.githubModelsApiKey) {
    document.getElementById('api-key-input').value = res.githubModelsApiKey;
  }
}

async function loadDashboard() {
  try {
    const result = await chrome.storage.local.get(['flashcards']);
    const flashcards = (result.flashcards || []);
    const now = Date.now();

    const total = flashcards.length;
    const due = flashcards.filter(c => (c.srs?.due ?? c.nextReview ?? 0) <= now).length;
    // "learned" = at least 3 successful repetitions
    const learned = flashcards.filter(c => (c.srs?.repetitions ?? 0) >= 3).length;

    document.getElementById('total-words').textContent = total;
    document.getElementById('due-words').textContent = due;
    document.getElementById('learned-words').textContent = learned;

    const listEl = document.getElementById('recent-list');
    if (!flashcards.length) {
      listEl.innerHTML = '<div class="empty-words">No words saved yet.</div>';
      return;
    }

    const recent = [...flashcards].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, 5);
    listEl.innerHTML = recent.map(card => {
      const first = card.meanings?.[0];
      const preview = first?.definition ? trunc(first.definition, 48) : 'no definition';
      return `<div class="word-item" data-word="${escHtml(card.word)}">
        <div class="word-name">${escHtml(card.word)}</div>
        <div class="word-preview">${escHtml(preview)}</div>
      </div>`;
    }).join('');

    listEl.querySelectorAll('.word-item').forEach(item => {
      item.addEventListener('click', () => {
        chrome.tabs.create({ url: `flashcards.html?view=notebook` });
      });
    });
  } catch (err) {
    console.error('popup loadDashboard error:', err);
  }
}

function trunc(text, len) {
  const t = String(text || '');
  return t.length <= len ? t : t.slice(0, len) + '…';
}

function escHtml(t) {
  return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
