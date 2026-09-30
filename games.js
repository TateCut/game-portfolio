/*
 * Game registry for TateCutcliffeGamePortfolio.
 *
 * To add a new game:
 *   1. Create a folder under games/ containing an index.html (e.g. games/snake/).
 *   2. Add an entry to the GAMES array below.
 *
 * Fields:
 *   title  (required)  Display name.
 *   path   (required)  Relative link to the game's folder or file.
 *   blurb  (required)  One-sentence description.
 *   icon               Emoji shown on the card when there's no image thumbnail.
 *   thumb              Path to a screenshot/image (overrides icon if set).
 *   accent             CSS color used for the card's thumbnail gradient.
 *   tags               Array of short labels.
 *   added              ISO date (YYYY-MM-DD); newest games sort first.
 */
window.GAMES = [
  {
    title: "Daily Climb",
    path: "https://thedailyclimb.com/",
    blurb: "A themed word-ladder climb every day: from a 4-letter word up to peaks of 7 to 11 letters, one new letter per rung.",
    icon: "⛰️",
    accent: "#d97706",
    tags: ["Vanilla JS", "Word game", "Daily"],
    added: "2026-09-03"
  },
  {
    title: "Tic Tac Toe",
    path: "games/tic-tac-toe/",
    blurb: "Classic 3x3 with local two-player and an unbeatable minimax computer opponent.",
    icon: "✕ ○",
    accent: "#2563eb",
    tags: ["Vanilla JS", "AI opponent"],
    added: "2026-09-03"
  }
];
