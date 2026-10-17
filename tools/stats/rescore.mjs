// Daily Climb: re-check every daily result against the day's puzzle. Run by .github/workflows/daily-stats.yml
// just before finalize.mjs, so final places, history and stats only ever see checked totals.
//
// A result (dailies/{day}/entrants/{uid}) carries the words played on each Climb (roundWords). For each closed,
// not-yet-finalized 6-7-8 day this recounts the points from those words, using the same puzzle files the game
// loads (daily-calendar.js, theme-words.js, words.js, fetched from the live site):
//   - word k of Climb i must use exactly the letters of that rung (an anagram of the calendar's rung word),
//   - a rung can't be the rung below plus an ending (-s, or -d/-r/-n after an e), same as the game,
//   - revealed words score nothing, and a Climb has no more words than rungs,
//   - theme words: the theme's list (only words added on or before that day) plus the calendar's own.
// A total or theme count HIGHER than the words add up to is lowered to what they add up to, and the entrant
// gets checked = { was: { total, themeWords }, why, at }. Totals are never raised. A word missing from words.js
// isn't counted against anyone (the game can accept a word after an online dictionary check); it's only logged.
// Very fast results are logged too (left alone).
//
// RESCORE_DRY_RUN=1 only logs. SITE_DIR=<folder> reads the puzzle files from disk instead of the site.
// node rescore.mjs --selftest runs the checks on made-up results, no database (needs SITE_DIR).

import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";

const DRY = process.env.RESCORE_DRY_RUN === "1";
const SITE = process.env.SITE || "https://thedailyclimb.com";
const FORMAT_DAY = "2026-10-13";      // the 6-7-8 format (FORMAT_DAY in the game)
const NEW_RULES_DAY = "2026-10-02";   // every theme word on the list counts (NEW_RULES_DAY in the game)
const FAST_MS_PER_WORD = 1500;        // quicker than this on average gets logged

// ---- the game's puzzle files ----
async function loadGameData() {
  const files = ["daily-calendar.js", "theme-words.js", "words.js"];
  const window = {};
  for (const f of files) {
    const src = process.env.SITE_DIR
      ? fs.readFileSync(path.join(process.env.SITE_DIR, f), "utf8")
      : await (await fetch(`${SITE}/${f}?v=${Date.now()}`)).text();
    vm.runInNewContext(src, { window, String });
  }
  if (!window.DAILY_CALENDAR || !window.THEME_WORDS || !window.THREE21_WORDS) throw new Error("couldn't load the puzzle files");
  return { cal: window.DAILY_CALENDAR, themeWords: window.THEME_WORDS, themeFrom: window.THEME_WORDS_FROM || {},
    words: new Set(window.THREE21_WORDS.filter((w) => w && w.length >= 3)) };
}

// ---- pure helpers (same rules as index.html) ----
const dayBase = (key) => (/^\d{4}-\d{2}-\d{2}/.exec(key || "") || [""])[0];
const sortStr = (s) => s.split("").sort().join("");
const dayNumber = (base) => { const [y, m, d] = base.split("-").map(Number); return Math.floor(Date.UTC(y, m - 1, d) / 86400000); };
function isClosed(base, now) { const [y, m, d] = base.split("-").map(Number); return Date.UTC(y, m - 1, d + 1, 12) <= now; }
function isInflectionOf(word, prev) {
  if (!prev || !word) return false;
  if (word === prev + "s") return true;
  if (/e$/.test(prev) && (word === prev + "d" || word === prev + "r" || word === prev + "n")) return true;
  return false;
}
const cheapStep = (prev, next) => !!prev && !!next && (next.length >= prev.length ? isInflectionOf(next, prev) : isInflectionOf(prev, next));

// The day's puzzle: { base, id, climbs: [[rung words]], words: [[calendar theme words]], theme: Set } or null.
function themedDay(data, key) {
  const base = dayBase(key);
  const i = dayNumber(base) - dayNumber(data.cal.start);
  const d = i >= 0 ? data.cal.days[i] : null;
  if (!d) return null;
  const from = data.themeFrom[d.t] || {};
  const theme = new Set(String(data.themeWords[d.t] || "").split(" ").filter((w) => w && (!from[w] || base >= from[w])));
  return { base, id: d.t, climbs: d.c, words: d.w || [], theme };
}
const isThemeWord = (t, i, w) => (t.base >= NEW_RULES_DAY && t.theme.has(w)) || (t.words[i] || []).includes(w);

// Recount one result. e: the entrant as stored (roundWords wrapped as [{ words }]).
function checkEntrant(e, t, data) {
  const rounds = (e.roundWords || []).map((r) => (r && Array.isArray(r.words) ? r.words : []));
  const revealed = (e.reveals || []).map((s) => String(s).split(":")).filter((p) => p.length === 2);
  const why = [], unlisted = [];
  let total = 0, themeWords = 0, words = 0;
  if (rounds.length > t.climbs.length) why.push(`${rounds.length} Climbs`);
  t.climbs.forEach((rungs, i) => {
    const played = rounds[i] || [];
    if (played.length > rungs.length) why.push(`Climb ${i + 1}: ${played.length} words for ${rungs.length} rungs`);
    let prev = null;
    played.slice(0, rungs.length).forEach((w, k) => {
      w = String(w);
      if (!/^[a-z]+$/.test(w) || sortStr(w) !== sortStr(rungs[k])) { why.push(`Climb ${i + 1}: "${w}" doesn't fit rung ${k + 1}`); prev = w; return; }
      if (cheapStep(prev, w)) { why.push(`Climb ${i + 1}: "${w}" is "${prev}" plus an ending`); prev = w; return; }
      prev = w;
      words++;
      if (!data.words.has(w)) unlisted.push(w);
      if (revealed.some(([c, rw]) => +c === i && rw === w)) return;   // revealed: no points
      total++;
      if (isThemeWord(t, i, w)) themeWords++;
    });
  });
  // Old days: at most one theme word per Climb counted (only 6-7-8 days are checked here, so this never applies).
  return { total, themeWords, words, why, unlisted };
}

// ---- self-test: made-up results against a real day ----
async function selftest() {
  const data = await loadGameData();
  const day = "2026-10-16-r6", t = themedDay(data, day);
  if (!t) throw new Error("no puzzle for " + day);
  const wrap = (rs) => rs.map((words) => ({ words }));
  const honest = { roundWords: wrap(t.climbs), total: t.climbs.flat().length };
  const themeCount = t.climbs.reduce((a, rungs, i) => a + rungs.filter((w) => isThemeWord(t, i, w)).length, 0);
  const cases = [
    ["perfect run", honest, { total: honest.total, themeWords: themeCount, why: 0 }],
    ["partial run", { roundWords: wrap([t.climbs[0], t.climbs[1].slice(0, 2)]) }, { total: t.climbs[0].length + 2, why: 0 }],
    ["made-up total", { roundWords: wrap([t.climbs[0].slice(0, 1)]), total: 15 }, { total: 1, why: 0 }],
    ["wrong letters", { roundWords: wrap([["zzz"].concat(t.climbs[0].slice(1))]) }, { total: t.climbs[0].length - 1, why: 1 }],
    ["too many words", { roundWords: wrap([t.climbs[0].concat(["extra"])]) }, { total: t.climbs[0].length, why: 1 }],
    ["revealed word", { roundWords: wrap([t.climbs[0]]), reveals: ["0:" + t.climbs[0][2]] }, { total: t.climbs[0].length - 1, why: 0 }],
  ];
  let bad = 0;
  for (const [name, e, want] of cases) {
    const got = checkEntrant(e, t, data);
    const ok = got.total === want.total && (want.themeWords == null || got.themeWords === want.themeWords) && (got.why.length > 0) === (want.why > 0);
    if (!ok) bad++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}: total ${got.total}, theme ${got.themeWords}${got.why.length ? " · " + got.why.join("; ") : ""}`);
  }
  console.log(`Rungs on ${day}: ${t.climbs.map((c) => c.join(" ")).join(" | ")}`);
  if (bad) process.exit(1);
}

async function main() {
  const { initializeApp, cert } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");
  let serviceAccount;
  try { serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || ""); }
  catch (e) { console.error("The FIREBASE_SERVICE_ACCOUNT secret is missing or isn't valid JSON."); process.exit(1); }
  initializeApp({ credential: cert(serviceAccount) });
  const db = getFirestore();
  const data = await loadGameData();
  const now = Date.now();
  const dayRefs = (await db.collection("dailies").listDocuments()).filter((r) => !r.id.startsWith("_"));
  let checked = 0, lowered = 0;
  for (const ref of dayRefs) {
    const base = dayBase(ref.id);
    if (!base || base < FORMAT_DAY || !isClosed(base, now)) continue;
    const snap = await ref.get();
    if (snap.exists && snap.data().finalized) continue;
    const t = themedDay(data, ref.id);
    if (!t) { console.log(`${ref.id}: no puzzle in the calendar, skipped`); continue; }
    const es = await ref.collection("entrants").get();
    for (const d of es.docs) {
      const e = d.data();
      const r = checkEntrant(e, t, data);
      checked++;
      const who = `${ref.id} ${JSON.stringify(e.name || "?")} (${d.id})`;
      if (r.unlisted.length) console.log(`${who}: not in words.js (fine if the online check took them): ${r.unlisted.join(", ")}`);
      if (r.words && e.solveMs > 0 && e.solveMs / r.words < FAST_MS_PER_WORD) console.log(`${who}: very fast, ${r.words} words in ${Math.round(e.solveMs / 1000)}s`);
      const over = (e.total || 0) > r.total || (e.themeWords || 0) > r.themeWords;
      if (!over) continue;
      lowered++;
      const why = r.why.length ? r.why : ["the total doesn't match the words played"];
      console.log(`${DRY ? "[dry run] would lower" : "Lowering"} ${who}: total ${e.total || 0} -> ${r.total}, theme ${e.themeWords || 0} -> ${r.themeWords} (${why.join("; ")})`);
      if (DRY) continue;
      await d.ref.set({
        total: Math.min(e.total || 0, r.total), themeWords: Math.min(e.themeWords || 0, r.themeWords),
        checked: { was: { total: e.total || 0, themeWords: e.themeWords || 0 }, why: why.slice(0, 10), at: now },
      }, { merge: true });
    }
  }
  console.log(`Checked ${checked} result(s); ${lowered} ${DRY ? "would be " : ""}lowered.`);
}

(process.argv.includes("--selftest") ? selftest() : main()).catch((e) => { console.error(e); process.exit(1); });
