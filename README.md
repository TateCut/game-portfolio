# TateCutcliffeGamePortfolio

A static portfolio site that showcases and hosts browser games. No build step, no
dependencies — just open `index.html` in a browser.

## Structure

```
portfolio/
  index.html      Landing page — renders a card grid from games.js
  styles.css      Shared styles for the landing page
  games.js        The game registry (edit this to add games)
  games/
    tic-tac-toe/
      index.html  A self-contained game
    3-2-1/
      index.html  Timed anagram game
      words.js    Bundled ~168k-word dictionary (window.THREE21_WORDS)
      freq.js     ~10k words by frequency, to pick a recognizable example word
```

3-2-1 also calls the Datamuse API (`api.datamuse.com`, no key) for two things:
the one-line definition on the game-over screen, and validating a submitted word
that isn't in the bundled ENABLE list (which lacks newer words like "umami").
Both degrade gracefully offline — the definition is hidden, and an unverifiable
word is rejected (an ENABLE word is always available). Results are cached.

Games that need bulk data (word lists, level data) ship it as a sibling `.js`
file that assigns a global, loaded with `<script src="...">` before the game
script. This works over `file://`, unlike `fetch()`.

## Run locally

Open `index.html` directly, or serve the folder so relative links behave exactly
as they would when hosted:

```bash
cd portfolio
python -m http.server 8000
# then visit http://localhost:8000
```

(Opening `index.html` straight from disk also works — every game and its data
load over `file://`.)

## Add a new game

1. Create a folder under `games/` with its own `index.html`, e.g.
   `games/snake/index.html`. Keep each game self-contained (inline or
   folder-local CSS/JS) so it can be dropped in without touching anything else.
2. Add a "← Portfolio" link near the top of the game's page:
   ```html
   <a href="../../index.html">&larr; Portfolio</a>
   ```
3. Add an entry to the `GAMES` array in `games.js`:
   ```js
   {
     title: "Snake",
     path: "games/snake/",
     blurb: "Grow the snake, don't hit the walls.",
     icon: "🐍",
     accent: "#16a34a",
     tags: ["Canvas", "Keyboard"],
     added: "2026-10-01"
   }
   ```

Cards sort by `added` date, newest first. Use `thumb: "games/snake/preview.png"`
instead of `icon` if you have a screenshot.

## Hosting later

The site is fully static and uses only relative paths, so it can be dropped onto
GitHub Pages, Netlify, Vercel, or any static host as-is. Point the host at the
`portfolio/` folder as the site root.
