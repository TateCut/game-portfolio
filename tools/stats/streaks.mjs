// Daily Climb: streak safety net. Run by .github/workflows/daily-stats.yml after finalize.mjs.
//
// The game updates players/{uid}.dailyStreak / dailyLastDay itself when a daily is posted (and retries from the phone
// if that fails). If a player's latest result on a daily board is newer than their dailyLastDay (the phone never got
// to retry: cleared storage, gone for days), this rebuilds the streak from the boards: the run of consecutive days
// ending on that latest result. It only ever moves a streak forward (never lowers or rewinds one).
// v0.17.0 had a bug (Oct 17-18, 2026) that skipped the in-game update for everyone; this also repairs that.
//
// STREAKS_DRY_RUN=1 only logs.

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const DRY = process.env.STREAKS_DRY_RUN === "1";
let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "");
} catch (e) {
  console.error("The FIREBASE_SERVICE_ACCOUNT secret is missing or isn't valid JSON.");
  process.exit(1);
}
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const dayBase = (key) => (/^\d{4}-\d{2}-\d{2}/.exec(key || "") || [""])[0];
const nextDay = (base) => { const [y, m, d] = base.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10); };

async function main() {
  // every player's days on the boards: uid -> Map(base -> full day key)
  const played = new Map();
  const dayRefs = (await db.collection("dailies").listDocuments()).filter((r) => !r.id.startsWith("_") && dayBase(r.id));
  for (const ref of dayRefs) {
    const es = await ref.collection("entrants").select().get();
    for (const d of es.docs) { if (!played.has(d.id)) played.set(d.id, new Map()); played.get(d.id).set(dayBase(ref.id), ref.id); }
  }
  let fixed = 0, fine = 0;
  for (const [uid, days] of played) {
    const bases = [...days.keys()].sort(), last = bases[bases.length - 1];
    const snap = await db.doc(`players/${uid}`).get();
    if (!snap.exists) continue;
    const p = snap.data();
    if (dayBase(p.dailyLastDay) >= last) { fine++; continue; }
    // the run of consecutive days ending on the latest result (the boards hold every day they played)
    let streak = 1;
    for (let k = bases.length - 1; k > 0 && nextDay(bases[k - 1]) === bases[k]; k--) streak++;
    console.log(`${DRY ? "[dry run] would set" : "Setting"} ${JSON.stringify(p.username || p.name || uid)}: last day ${p.dailyLastDay || "none"} -> ${days.get(last)}, streak ${p.dailyStreak || 0} -> ${streak}`);
    if (!DRY) await snap.ref.set({ dailyLastDay: days.get(last), dailyStreak: streak, bestStreak: Math.max(p.bestStreak || 0, streak) }, { merge: true });
    fixed++;
  }
  console.log(`Streaks: ${fixed} ${DRY ? "would be " : ""}brought up to date, ${fine} already right.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
