// ============================================================
// background.js — service worker
// ============================================================

const GITHUB_MODELS_KEY_STORAGE = 'githubModelsApiKey';
const GEMINI_API_KEY_STORAGE = 'geminiApiKey';

// ── Context menu ─────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'defineWord',
    title: "Define \"%s\"",
    contexts: ['selection']
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'defineWord' || !info.selectionText) return;
  const text = info.selectionText.trim();
  if (!tab || typeof tab.id !== 'number') return;
  chrome.tabs.sendMessage(tab.id, { action: 'showDefinition', word: text }, () => {
    if (chrome.runtime.lastError) {
      console.warn('Tab message error:', chrome.runtime.lastError.message);
    }
  });
});

// ── Message router ────────────────────────────────────────────
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'fetchDefinition') {
    fetchDefinition(request.word)
      .then(data => sendResponse({ success: true, data }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (request.action === 'saveApiKey') {
    chrome.storage.local.set({ [GITHUB_MODELS_KEY_STORAGE]: request.key })
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (request.action === 'saveGeminiKey') {
    chrome.storage.local.set({ [GEMINI_API_KEY_STORAGE]: request.key })
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (request.action === 'getApiKey') {
    chrome.storage.local.get([GITHUB_MODELS_KEY_STORAGE])
      .then(r => sendResponse({ key: r[GITHUB_MODELS_KEY_STORAGE] || '' }))
      .catch(() => sendResponse({ key: '' }));
    return true;
  }
  if (request.action === 'getGeminiKey') {
    chrome.storage.local.get([GEMINI_API_KEY_STORAGE])
      .then(r => sendResponse({ key: r[GEMINI_API_KEY_STORAGE] || '' }))
      .catch(() => sendResponse({ key: '' }));
    return true;
  }
  if (request.action === '_openTab' && request.url) {
    chrome.tabs.create({ url: chrome.runtime.getURL(request.url) });
    sendResponse({ ok: true });
  }

  if (request.action === 'askLLM') {
    askLlmDeepDive(request.text)
      .then(data => sendResponse({ success: true, data }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

async function askLlmDeepDive(rawText) {
  const text = String(rawText || '').trim();
  if (!text) throw new Error('No text provided');

  const stored = await chrome.storage.local.get([GEMINI_API_KEY_STORAGE]);
  const apiKey = stored[GEMINI_API_KEY_STORAGE];
  if (!apiKey) throw new Error('NO_GEMINI_KEY');

  const prompt = `Return ONLY valid JSON (no markdown) with this shape:
{
  "whereToUse": "<1-2 sentences about typical contexts>",
  "usageNotes": "<1-3 short sentences about how to use it correctly>",
  "register": "<formal|neutral|informal|slang and any tone notes>",
  "examples": ["<example 1>", "<example 2>", "<example 3 (optional)>"] ,
  "tips": ["<tip 1>", "<tip 2>", "<tip 3 (optional)>"]
}
Keep it concise and practical for learners. Text to explain: "${text}"`;

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 650 }
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error: ${res.status} ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  const raw = data?.candidates?.[0]?.content?.parts
    ? data.candidates[0].content.parts.map(p => p?.text || '').join('')
    : '';

  const cleaned = String(raw)
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    throw new Error('Failed to parse Gemini response as JSON');
  }
}

// ── Main fetch orchestrator ───────────────────────────────────
async function fetchDefinition(rawText) {
  const text = String(rawText || '').trim();
  if (!text) throw new Error('No text provided');

  const isPhrase = text.includes(' ') || text.length > 30;

  // Phrases/idioms: try Wiktionary first, then Gemini 2.5 Flash.
  if (isPhrase) {
    try {
      const result = await fetchWiktionary(text.toLowerCase());
      if (result) return result;
    } catch (e) {
      console.warn('Wiktionary phrase lookup failed, trying Gemini:', e.message);
    }
    return fetchGemini25Flash(text);
  }

  if (!isPhrase) {
    try {
      const free = await fetchFreeDictionaryWithRedirect(text.toLowerCase());
      if (free) return free;
    } catch (e) {
      console.warn('Free Dictionary API failed, trying Wiktionary:', e.message);
    }

    try {
      const result = await fetchWiktionaryWithRedirect(text.toLowerCase());
      if (result) return result;
    } catch (e) {
      console.warn('Wiktionary failed, falling back to GPT-4.1:', e.message);
    }
  }

  // Fallback / phrase path: use GitHub Models GPT-4.1
  return fetchGPT41(text);
}

// ── Gemini 2.5 Flash ─────────────────────────────────────────
async function fetchGemini25Flash(text) {
  const stored = await chrome.storage.local.get([GEMINI_API_KEY_STORAGE]);
  const apiKey = stored[GEMINI_API_KEY_STORAGE];
  if (!apiKey) throw new Error('NO_GEMINI_KEY');

  const systemPrompt = `You are a dictionary assistant. The user provides a word or phrase.
Return ONLY valid JSON (no markdown) with this shape:
{
  "word": "<the exact input>",
  "source": "gemini",
  "meanings": [
    {
      "partOfSpeech": "<noun|verb|phrase|idiom|etc>",
      "definition": "<clear definition>",
      "examples": ["<example 1>", "<example 2>"],
      "synonyms": ["<synonym or related phrase 1>", "...up to 6"]
    }
  ]
}
Provide 1-2 meanings maximum. Be concise and accurate.`;

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        { role: 'user', parts: [{ text: `${systemPrompt}\n\nDefine: "${text}"` }] }
      ],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 700
      }
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error: ${res.status} ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  const raw = data?.candidates?.[0]?.content?.parts
    ? data.candidates[0].content.parts.map(p => p?.text || '').join('')
    : '';

  const cleaned = String(raw)
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    throw new Error('Failed to parse Gemini response as JSON');
  }
}

// ── Free Dictionary API (dictionaryapi.dev) ───────────────────
async function fetchFreeDictionaryWithRedirect(word, visited = new Set()) {
  const w = String(word || '').trim();
  if (!w) throw new Error('No word provided');
  if (visited.has(w)) return await fetchFreeDictionary(w);
  visited.add(w);

  const result = await fetchFreeDictionary(w);

  const firstDef = result?.meanings?.[0]?.definition || '';
  const lemma = extractPluralOfLemma(firstDef);
  if (!lemma) return result;

  const normalizedLemma = lemma.toLowerCase();
  if (!normalizedLemma || normalizedLemma === w) return result;

  try {
    return await fetchFreeDictionaryWithRedirect(normalizedLemma, visited);
  } catch {
    return result;
  }
}

async function fetchFreeDictionary(word) {
  const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Dictionary API ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data) || !data.length) throw new Error('Dictionary API empty response');

  const entry = data[0] || {};
  const meaningsIn = Array.isArray(entry.meanings) ? entry.meanings : [];

  const audioUrl = pickDictionaryApiAudioUrl(entry);

  const meanings = [];
  for (const m of meaningsIn) {
    if (meanings.length >= 2) break;
    const partOfSpeech = String(m?.partOfSpeech || '').trim() || 'unknown';
    const defs = Array.isArray(m?.definitions) ? m.definitions : [];
    if (!defs.length) continue;

    const first = defs[0] || {};
    const definition = String(first.definition || '').trim();
    const example = first.example ? String(first.example).trim() : '';

    const syns = [];
    if (Array.isArray(m?.synonyms)) syns.push(...m.synonyms);
    if (Array.isArray(first?.synonyms)) syns.push(...first.synonyms);

    meanings.push({
      partOfSpeech,
      definition,
      examples: example ? [example] : [],
      synonyms: dedupeStrings(syns.map(s => String(s).trim()).filter(Boolean)).slice(0, 8)
    });
  }

  if (!meanings.length) throw new Error('Dictionary API: no meanings parsed');

  return {
    word: String(entry.word || word),
    source: 'dictionaryapi',
    audioUrl,
    meanings
  };
}

function pickDictionaryApiAudioUrl(entry) {
  const phonetics = Array.isArray(entry?.phonetics) ? entry.phonetics : [];
  for (const p of phonetics) {
    const raw = String(p?.audio || '').trim();
    if (!raw) continue;
    // API sometimes returns protocol-relative URLs like //ssl.gstatic.com/...
    if (raw.startsWith('//')) return `https:${raw}`;
    if (raw.startsWith('http://')) return raw.replace(/^http:\/\//i, 'https://');
    if (raw.startsWith('https://')) return raw;
  }
  return '';
}

async function fetchWiktionaryWithRedirect(word, visited = new Set()) {
  const w = String(word || '').trim();
  if (!w) throw new Error('No word provided');
  if (visited.has(w)) return await fetchWiktionary(w);
  visited.add(w);

  const result = await fetchWiktionary(w);

  // If Wiktionary returns an entry like “plural of <lemma>”, follow it so the
  // popup shows the singular/base form and its meaning.
  const firstDef = result?.meanings?.[0]?.definition || '';
  const lemma = extractPluralOfLemma(firstDef);
  if (!lemma) return result;

  const normalizedLemma = lemma.toLowerCase();
  if (!normalizedLemma || normalizedLemma === w) return result;

  try {
    return await fetchWiktionaryWithRedirect(normalizedLemma, visited);
  } catch {
    return result;
  }
}

// ── Wiktionary ────────────────────────────────────────────────
async function fetchWiktionary(word) {
  const url = `https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(word)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Wiktionary 404');
  const data = await res.json();

  const parsed = parseWiktionaryRest(word, data);
  if (!parsed || !parsed.meanings.length) throw new Error('No meanings');

  // Enrich: fetch up to 2 meanings' synonyms & examples from wikitext
  for (let i = 0; i < Math.min(2, parsed.meanings.length); i++) {
    const m = parsed.meanings[i];
    if (!m.synonyms || m.synonyms.length === 0) {
      m.synonyms = await fetchWikitextSynonyms(word, m.partOfSpeech);
    }
    if (!m.examples || m.examples.filter(Boolean).length === 0) {
      const ex = await fetchWikitextExamples(word, m.partOfSpeech);
      m.examples = ex.length ? ex.slice(0, 2) : ['No example available.'];
    } else {
      m.examples = m.examples.filter(Boolean).slice(0, 2);
    }
    m.synonyms = dedupeStrings(m.synonyms).slice(0, 8);
  }

  parsed.meanings = parsed.meanings.slice(0, 2);
  return parsed;
}

function parseWiktionaryRest(word, data) {
  const englishData = data?.en;
  if (!Array.isArray(englishData) || !englishData.length) throw new Error('No English data');

  const result = { word, source: 'wiktionary', meanings: [] };

  for (const section of englishData) {
    if (result.meanings.length >= 2) break;
    const partOfSpeech = section?.partOfSpeech || 'unknown';
    const defs = Array.isArray(section?.definitions) ? section.definitions : [];
    if (!defs.length) continue;

    const examples = [];
    const synonyms = [];
    for (const def of defs) {
      if (!def) continue;
      if (Array.isArray(def.examples)) examples.push(...def.examples);
      if (Array.isArray(def.parsedExamples)) {
        def.parsedExamples.forEach(ex => ex?.example && examples.push(ex.example));
      }
      synonyms.push(...extractSynonymsFromDef(def));
    }

    result.meanings.push({
      partOfSpeech,
      definition: stripHtml(String(defs[0]?.definition || '')),
      examples: dedupeStrings(examples.map(e => stripHtml(String(e)))).slice(0, 2),
      synonyms: dedupeStrings(synonyms.map(s => stripHtml(String(s)))).slice(0, 8)
    });
  }

  if (!result.meanings.length) throw new Error('No definitions parsed');
  return result;
}

function extractSynonymsFromDef(def) {
  const out = [];
  const walk = (v) => {
    if (!v) return;
    if (typeof v === 'string') { out.push(v); return; }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (typeof v === 'object') {
      ['word','text','term'].forEach(k => v[k] && out.push(v[k]));
      if (v.synonyms) walk(v.synonyms);
    }
  };
  walk(def?.synonyms ?? def?.synonym ?? def?.relatedWords);
  return out;
}

function extractPluralOfLemma(definition) {
  const raw = String(definition || '').trim();
  if (!raw) return '';

  // Common Wiktionary phrasing after HTML stripping.
  // Examples:
  // - "plural of cat"
  // - "Plural of “analysis”"
  // - "plural form of goose."
  const m = raw.match(/^plural\s+(?:form\s+)?of\s+(.+?)(?:\.|;|,|$)/i);
  if (!m) return '';

  let lemma = (m[1] || '').trim();
  // Remove surrounding quotes.
  lemma = lemma.replace(/^['"“”‘’]+/, '').replace(/['"“”‘’]+$/, '').trim();
  // Remove any parenthetical gloss like "(plural of X)" artifacts.
  lemma = lemma.replace(/^\((.*)\)$/, '$1').trim();
  // Keep only the first token if Wiktionary included extra notes.
  lemma = lemma.split(/\s+/)[0].trim();

  // Avoid returning non-words.
  if (!lemma || lemma.length > 60) return '';
  return lemma;
}

// ── Wikitext enrichment ───────────────────────────────────────
async function fetchWikitextSynonyms(word, partOfSpeech) {
  const wikitext = await fetchWikitext(word);
  if (!wikitext) return [];
  const english = extractLangSection(wikitext, 'English');
  const posSection = partOfSpeech ? extractPosSection(english, partOfSpeech) : english;
  const synSection = extractSubsection(posSection || english, 'Synonyms');
  if (!synSection) return [];
  const { direct, thesaurusTitles } = splitSynonymItems(parseWikitextBullets(synSection));
  const expanded = [];
  for (const title of thesaurusTitles.slice(0, 2)) {
    expanded.push(...await fetchThesaurusTerms(title));
  }
  return dedupeStrings([...direct, ...expanded]).filter(isValidTerm).slice(0, 8);
}

async function fetchWikitextExamples(word, partOfSpeech) {
  const wikitext = await fetchWikitext(word);
  if (!wikitext) return [];
  const english = extractLangSection(wikitext, 'English');
  const posSection = partOfSpeech ? extractPosSection(english, partOfSpeech) : english;
  if (!posSection) return [];
  const usageSection = extractSubsection(posSection, 'Usage examples') || extractSubsection(posSection, 'Examples');
  return parseWikitextExamples(usageSection || posSection).slice(0, 2);
}

async function fetchWikitext(word) {
  try {
    const url = `https://en.wiktionary.org/w/api.php?action=parse&format=json&prop=wikitext&page=${encodeURIComponent(word)}&origin=*`;
    const res = await fetch(url);
    if (!res.ok) return '';
    const data = await res.json();
    return data?.parse?.wikitext?.['*'] || '';
  } catch { return ''; }
}

async function fetchThesaurusTerms(title) {
  const wikitext = await fetchWikitext(title);
  if (!wikitext) return [];
  const english = extractLangSection(wikitext, 'English');
  return parseWikitextBullets(english || wikitext).filter(isValidTerm);
}

// ── GitHub Models GPT-4.1 ─────────────────────────────────────
async function fetchGPT41(text) {
  const stored = await chrome.storage.local.get([GITHUB_MODELS_KEY_STORAGE]);
  const apiKey = stored[GITHUB_MODELS_KEY_STORAGE];
  if (!apiKey) {
    throw new Error('NO_API_KEY');
  }

  const isPhrase = text.includes(' ');
  const systemPrompt = isPhrase
    ? `You are a dictionary assistant. The user provides a word or phrase. Return ONLY valid JSON (no markdown) with this shape:
{
  "word": "<the exact input>",
  "source": "gpt4",
  "meanings": [
    {
      "partOfSpeech": "<noun|verb|phrase|idiom|etc>",
      "definition": "<clear definition>",
      "examples": ["<example sentence using the phrase>", "<second example>"],
      "synonyms": ["<synonym or related phrase 1>", "...up to 6"]
    }
  ]
}
Provide 1-2 meanings maximum. Be concise and accurate.`
    : `You are a dictionary assistant. Return ONLY valid JSON (no markdown) with this shape:
{
  "word": "<the exact input>",
  "source": "gpt4",
  "meanings": [
    {
      "partOfSpeech": "<part of speech>",
      "definition": "<definition>",
      "examples": ["<example 1>", "<example 2>"],
      "synonyms": ["<syn1>", "..up to 6"]
    }
  ]
}
Provide 1-2 meanings maximum.`;

  const res = await fetch('https://models.inference.ai.azure.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4.1',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Define: "${text}"` }
      ],
      max_tokens: 600,
      temperature: 0.2
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`GPT-4.1 API error: ${res.status} ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  const raw = data?.choices?.[0]?.message?.content || '';
  // Strip possible markdown fences
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new Error('Failed to parse GPT-4.1 response as JSON');
  }
}

// ── Wikitext helpers ──────────────────────────────────────────
function extractLangSection(wikitext, lang) {
  const re = new RegExp(`^==\\s*${escRe(lang)}\\s*==\\s*$`, 'm');
  const m = re.exec(wikitext);
  if (!m) return '';
  const rest = wikitext.slice(m.index + m[0].length);
  const next = /^==[^=].*==\s*$/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

function extractPosSection(wikitext, pos) {
  if (!pos) return '';
  const re = new RegExp(`^===\\s*${escRe(pos)}\\s*===\\s*$`, 'm');
  const m = re.exec(wikitext);
  if (!m) return '';
  const rest = wikitext.slice(m.index + m[0].length);
  const next = /^===\s*[^=].*===\s*$/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

function extractSubsection(wikitext, title) {
  const re = new RegExp(`^====\\s*${escRe(title)}\\s*====\\s*$`, 'm');
  const m = re.exec(wikitext);
  if (!m) return '';
  const rest = wikitext.slice(m.index + m[0].length);
  const next = /^====\s*[^=].*====\s*$/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

function parseWikitextBullets(wikitext) {
  const out = [];
  for (const line of (wikitext || '').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('*')) continue;
    const re = /\[\[([^\]|#]+)(?:\|[^\]]+)?\]\]/g;
    let m;
    while ((m = re.exec(t))) out.push(m[1]);
    const plain = t.replace(/^\*+\s*/, '').replace(/\{\{[^}]*\}\}/g, ' ').replace(/\[\[[^\]]+\]\]/g, ' ').replace(/<[^>]*>/g, ' ');
    plain.split(/[,;]+/).map(s => s.trim()).filter(s => s.length > 1).forEach(s => out.push(s));
  }
  return dedupeStrings(out);
}

function parseWikitextExamples(wikitext) {
  const out = [];
  for (const line of (wikitext || '').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('#*') && !t.startsWith('*')) continue;
    let text = t.replace(/^#\*+\s*/, '').replace(/^\*+\s*/, '');
    const fromTemplate = extractExampleFromTemplate(text);
    if (fromTemplate) {
      const c = cleanWikiInline(fromTemplate);
      if (c.length >= 8) { out.push(c); continue; }
    }
    text = text.replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, ' ').replace(/<[^>]*>/g, ' ').replace(/\{\{[^}]*\}\}/g, ' ');
    const c = cleanWikiInline(text);
    if (c.length >= 8) out.push(c);
  }
  return dedupeStrings(out);
}

function extractExampleFromTemplate(text) {
  const m = text.match(/\{\{\s*(ux|uxi|usex)\s*\|([^}]*)\}\}/i);
  if (m) {
    const parts = m[2].split('|').map(s => s.trim());
    if (parts.length >= 2 && parts[1]) return parts[1];
  }
  const p = text.match(/\|\s*passage\s*=\s*([^|}]+)/i);
  if (p?.[1]) return p[1].trim();
  return '';
}

function cleanWikiInline(text) {
  let o = String(text || '');
  o = o.replace(/\[\[([^\]|#]+)\|([^\]]+)\]\]/g, '$2');
  o = o.replace(/\[\[([^\]|#]+)\]\]/g, '$1');
  o = o.replace(/''+/g, '');
  o = o.replace(/\{\{[^}]*\}\}/g, ' ');
  o = o.replace(/<[^>]*>/g, ' ');
  return o.replace(/\s+/g, ' ').trim();
}

function splitSynonymItems(items) {
  const direct = [], thesaurusTitles = [];
  for (const raw of (items || [])) {
    const t = String(raw || '').trim();
    if (!t) continue;
    if (/^(Thesaurus|Wikisaurus):/i.test(t)) thesaurusTitles.push(t);
    else direct.push(t);
  }
  return { direct, thesaurusTitles };
}

function isValidTerm(t) {
  const s = String(t || '').trim();
  if (!s || s.length < 2) return false;
  if (/^[a-z]+:\s*/i.test(s)) return false;
  if (/^[^a-zA-Z]+$/.test(s)) return false;
  const lower = s.toLowerCase();
  if (lower === 'see also' || lower === 'seealso') return false;
  return true;
}

// ── Generic utils ─────────────────────────────────────────────
function stripHtml(text) {
  const s = String(text ?? '');
  if (!/<\/?[a-z][\s\S]*>/i.test(s) && !s.includes('mw:WikiLink')) {
    return s.replace(/\s+/g, ' ').trim();
  }
  try {
    const doc = new DOMParser().parseFromString(s, 'text/html');
    return (doc.body?.textContent || s).replace(/\s+/g, ' ').trim();
  } catch {
    return s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }
}

function dedupeStrings(items) {
  const seen = new Set(), out = [];
  for (const item of (items || [])) {
    const s = String(item ?? '').trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k); out.push(s);
  }
  return out;
}

function escRe(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
