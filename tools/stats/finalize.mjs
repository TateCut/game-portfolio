// Daily Climb once-a-day finalizer. Run by .github/workflows/daily-stats.yml.
//
// 1. Final places. A daily's leaderboard can change until the day is over
//    everywhere (the latest time zone, UTC-12, finishes day D at D+1 12:00
//    UTC). For every closed day not yet finalized, rank its entrants the way
//    the game does (most words, then most theme words, then fewest wrong words, then fastest, then
//    who finished first) and write each player's result into their player
//    record:  players/{uid}.history["YYYY-MM-DD"] = { t, s, ms, h, at, r, n }
//             (+ m = the day's most words and th = theme words found, on themed days)
//      t words (0-18, or 0-m) · s wrong words · ms solve time · h hint used
//      at finished (epoch ms) · r final place · n players that day
//    then mark dailies/{day}.finalized = true.
// 2. Stats. For every player with history, recompute players/{uid}.stats
//    (played, perfect, wins, podiums, fastestPerfectMs, ...) and bestStreak.
// 3. Trophy rarity. From every player's players/{uid}.trophies (written by the
//    game), the share of players holding each trophy → dailies/_meta
//    { trophyRarity: { id: percent }, rarityPlayers }.
//
// Idempotent: finalized days are skipped (REBUILD=1 redoes them all).
// Needs the FIREBASE_SERVICE_ACCOUNT secret (same as the reminder sender).

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const REBUILD = process.env.REBUILD === "1";

let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "");
} catch (e) {
  console.error("The FIREBASE_SERVICE_ACCOUNT secret is missing or isn't valid JSON.");
  process.exit(1);
}
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

// ---- pure helpers (kept free of Firestore so they can be tested alone) ----
const dayBase = (key) => (/^\d{4}-\d{2}-\d{2}/.exec(key || "") || [""])[0];
// Day D is over everywhere at D+1 12:00 UTC.
function isClosed(base, now) {
  const [y, m, d] = base.split("-").map(Number);
  return Date.UTC(y, m - 1, d + 1, 12) <= now;
}
// Same order as the game's leaderboard (index.html dailyCmp): words, then
// theme words found (themed days), strikes, time, finish time.
function dailyCmp(a, b) {
  return ((b.total || 0) - (a.total || 0)) ||
    ((b.themeWords || 0) - (a.themeWords || 0)) ||
    ((a.strikes || 0) - (b.strikes || 0)) ||
    ((a.solveMs || 0) - (b.solveMs || 0)) ||
    ((a.finishedAt || 0) - (b.finishedAt || 0));
}
const nextDate = (base) => {
  const [y, m, d] = base.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
};
// Totals from a player's history map (see the header for entry fields).
function computeStats(history) {
  const days = Object.keys(history || {}).filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort();
  const st = { played: 0, perfect: 0, wins: 0, podiums: 0, totalWords: 0, noHintDays: 0,
    cleanPerfect: 0, fastestPerfectMs: null, bestStreak: 0, firstDay: days[0] || null, lastDay: days[days.length - 1] || null };
  let run = 0, prev = null;
  for (const k of days) {
    const e = history[k] || {};
    st.played++;
    st.totalWords += e.t || 0;
    if (!e.h) st.noHintDays++;
    if (e.t >= (e.m || 18)) {   // every word (m = that day's most; old dailies were 18)
      st.perfect++;
      if (!e.s) st.cleanPerfect++;
      if (e.ms > 0 && (st.fastestPerfectMs === null || e.ms < st.fastestPerfectMs)) st.fastestPerfectMs = e.ms;
    }
    if (e.r === 1) st.wins++;
    if (e.r >= 1 && e.r <= 3) st.podiums++;
    run = prev && nextDate(prev) === k ? run + 1 : 1;
    if (run > st.bestStreak) st.bestStreak = run;
    prev = k;
  }
  return st;
}

async function main() {
  const now = Date.now();
  // Parent day docs usually don't exist (only their entrants do);
  // listDocuments() still returns them.
  const dayRefs = (await db.collection("dailies").listDocuments()).filter((r) => !r.id.startsWith("_"));
  const touched = new Set();
  let finalized = 0;

  for (const ref of dayRefs) {
    const base = dayBase(ref.id);
    if (!base || !isClosed(base, now)) continue;
    const snap = await ref.get();
    if (!REBUILD && snap.exists && snap.data().finalized) continue;
    const entrants = (await ref.collection("entrants").get()).docs.map((d) => Object.assign({ uid: d.id }, d.data()));
    entrants.sort(dailyCmp);
    const n = entrants.length;
    const writer = db.bulkWriter();
    entrants.forEach((e, i) => {
      const entry = { t: e.total || 0, s: e.strikes || 0, ms: e.solveMs || 0, h: !!e.hintUsed, at: e.finishedAt || 0, r: i + 1, n };
      if (e.max) Object.assign(entry, { m: e.max, th: e.themeWords || 0 });   // themed day
      writer.set(db.doc(`players/${e.uid}`), { history: { [base]: entry } }, { merge: true });
      touched.add(e.uid);
    });
    writer.set(ref, { finalized: true, players: n, finalizedAt: now }, { merge: true });
    await writer.close();
    finalized++;
    console.log(`Finalized ${ref.id}: ${n} player(s)`);
  }

  // Stats + best streak for everyone we just touched (all players on a rebuild).
  const players = REBUILD || touched.size === 0
    ? (await db.collection("players").get()).docs
    : await Promise.all([...touched].map((u) => db.doc(`players/${u}`).get()));
  const writer = db.bulkWriter();
  let statted = 0;
  for (const p of players) {
    if (!p.exists) continue;
    const data = p.data();
    if (!data.history) continue;
    const st = computeStats(data.history);
    writer.set(p.ref, { stats: st, bestStreak: Math.max(data.bestStreak || 0, st.bestStreak, data.dailyStreak || 0) }, { merge: true });
    statted++;
  }
  await writer.close();

  // Trophy rarity across every player who has played at least one daily.
  const all = (await db.collection("players").get()).docs.map((d) => d.data());
  const climbers = all.filter((d) => d.history && Object.keys(d.history).length);
  const counts = {};
  for (const d of climbers) for (const id of Object.keys(d.trophies || {})) counts[id] = (counts[id] || 0) + 1;
  const rarity = {};
  for (const [id, c] of Object.entries(counts)) rarity[id] = Math.round((c / climbers.length) * 1000) / 10;
  await db.doc("dailies/_meta").set({ trophyRarity: rarity, rarityPlayers: climbers.length, updatedAt: now }, { merge: false });

  console.log(`Done. Finalized ${finalized} day(s), updated stats for ${statted} player(s), rarity from ${climbers.length} climber(s).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
