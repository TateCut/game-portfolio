// Daily Climb: one small summary per finished daily, for the weekly leaderboard. Run by
// .github/workflows/daily-stats.yml after finalize.mjs (so it sums checked totals).
//
// The weekly board and Home's "You're Nth" add up every day of the week. Reading each day's entrants costs one
// read per player per day per look; once a day is finalized its results never change, so this writes them onto the
// day's own doc as a compact list, and the game reads that one doc instead (and keeps it on the phone):
//   dailies/{day}.board = [{ u: uid, n: name, t: total, w: themeWords, s: strikes, ms: solveMs, at: finishedAt }]
//   dailies/{day}.boardAt = when it was written
// Days that already have a board are skipped (REBUILD=1 redoes them all). A day's doc tops out at 1 MB, about
// 12,000 players; past that the board is left off and the game reads the entrants as before.

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const REBUILD = process.env.REBUILD === "1";
const MAX_ROWS = 12000;

let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "");
} catch (e) {
  console.error("The FIREBASE_SERVICE_ACCOUNT secret is missing or isn't valid JSON.");
  process.exit(1);
}
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

async function main() {
  const dayRefs = (await db.collection("dailies").listDocuments()).filter((r) => !r.id.startsWith("_"));
  let written = 0;
  for (const ref of dayRefs) {
    const snap = await ref.get();
    if (!snap.exists || !snap.data().finalized) continue;
    if (snap.data().board && !REBUILD) continue;
    const es = (await ref.collection("entrants").get()).docs;
    if (es.length > MAX_ROWS) { console.log(`${ref.id}: ${es.length} players, too many for one doc, skipped`); continue; }
    const board = es.map((d) => {
      const e = d.data();
      return { u: d.id, n: String(e.name || "Player").slice(0, 24), t: e.total || 0, w: e.themeWords || 0, s: e.strikes || 0,
        ms: Math.round(e.solveMs || 0), at: e.finishedAt || 0 };
    });
    await ref.set({ board, boardAt: Date.now() }, { merge: true });
    written++;
    console.log(`${ref.id}: board of ${board.length}`);
  }
  console.log(`Done. Wrote ${written} day board(s).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
