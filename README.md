# define.

Define is a lightweight Chrome extension that lets you look up words, phrases, and idioms on any page, then save them as flashcards for spaced-repetition review.

It’s designed to feel fast: select → define → save → review.

## How to install (developer mode)

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. Click **Load unpacked**
4. Select this folder (the one containing `manifest.json`)

## How to use

### Look up a word/phrase

You have two ways to trigger the popup:

- **Right‑click → Define**
  - Highlight text on a page, right‑click, then choose **Define**.
- **Double‑click then click again**
  - Double‑click a single word to select it, then click that same word once more.

### In the popup

- **🔊 Audio** (when available): plays pronunciation audio.
- **Ask LLM**: generates a deeper, practical explanation (where to use it, tone, examples, tips).
  - The first time, you’ll be prompted for a Gemini API key.
- **Save card**: stores the word + meaning (and any Ask LLM notes) into your flashcards.
- **Flashcards**: jumps straight to the flashcards page.

### Flashcards page

Open the flashcards page from the popup header button, or by opening `flashcards.html`:

- **Review**: flip cards and grade yourself (again / good). Scheduling follows spaced repetition.
- **Notebook**: browse all saved words, edit notes, and delete cards.
- **Download PDF** (Notebook view): opens the print dialog so you can **Save as PDF**.

## API keys

Your flashcards stay local in Chrome storage, but some features call external LLM APIs. You control this via two keys stored only in your browser:

- **Gemini API key** – used for phrases/idioms and **Ask LLM** (primary LLM).
- **GitHub Models API key (GPT‑4.1)** – used as a fallback when Gemini isn’t available or fails.

### Getting a Gemini API key

1. Go to Google AI Studio and sign in with your Google account.
2. Create a new API key for the Generative Language API.
3. Copy the key (it typically starts with `AIza`).

### Getting a GitHub Models API key

1. Sign in to your GitHub account.
2. Create a personal access token (classic or fine‑grained) with permission to use GitHub Models.
3. Copy the token (it may start with `ghp_` or similar).

### Where to paste the keys

You can set or change keys in either place (they share the same storage):

- **Flashcards page**: open `flashcards.html` and use the **API key settings** section at the top.
- **Popup**: open the extension popup from the toolbar, then fill in:
  - “GitHub Models API key (GPT‑4.1, fallback)”
  - “Gemini API key (phrases & LLM notes)”

Once saved, lookups and Ask LLM will automatically use Gemini first, then fall back to GitHub Models GPT‑4.1 if needed.

## Quick tips

- If the popup ever ends up near the edge of the screen, you can drag it by the header — it will clamp itself back into view.
- For best results, keep the selection to a single word (or a short phrase for idioms).
