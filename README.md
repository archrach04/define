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

## Data & keys

- Your flashcards are stored locally in Chrome storage.
- Some features require API keys:
  - **Gemini** key: used for phrases/idioms fallback and **Ask LLM**.
  - **GitHub Models** key: used as an additional fallback when other sources don’t return results.

## Quick tips

- If the popup ever ends up near the edge of the screen, you can drag it by the header — it will clamp itself back into view.
- For best results, keep the selection to a single word (or a short phrase for idioms).
