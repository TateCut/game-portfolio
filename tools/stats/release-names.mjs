// Daily Climb: release never-locked usernames. Run by .github/workflows/daily-stats.yml after finalize.mjs.
//
// A name picked on the game's name-first screen is marked players/{uid}.nameOnly = true (with nameAt = the day it was
// picked) until the player locks it in with secret emoji. Without emoji nobody can sign into it from another device,
// so a name that's never locked in and not played for RELEASE_AFTER_DAYS is set free:
//   - usernames/{key} and recovery/{key} are deleted (the name can be claimed again),
//   - the account's hidden sign-in moves off the name's address (released-<uid>@...) and is unlinked, so the same
//     device can pick a new name later,
//   - players/{uid} loses username / name / nameOnly / nameAt and gets released = "YYYY-MM-DD" (the game sees it at
//     start-up and asks for a new name). History, streaks and trophies stay with the account.
// Safety: only nameOnly players; skipped if the reservation now belongs to someone else or the recovery record has
// emoji. RELEASE_DRY_RUN=1 only logs what it would do.

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";

const RELEASE_AFTER_DAYS = 7;
const DRY = process.env.RELEASE_DRY_RUN === "1";

let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "");
} catch (e) {
  console.error("The FIREBASE_SERVICE_ACCOUNT secret is missing or isn't valid JSON.");
  process.exit(1);
}
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();
const auth = getAuth();

const dayBase = (key) => (/^\d{4}-\d{2}-\d{2}/.exec(key || "") || [""])[0];
const nameKey = (name) => String(name).trim().toLowerCase().replace(/ +/g, ".");   // same as the game

async function main() {
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const cutoff = new Date(now - RELEASE_AFTER_DAYS * 86400000).toISOString().slice(0, 10);
  const unlocked = await db.collection("players").where("nameOnly", "==", true).get();
  let released = 0, kept = 0;
  for (const p of unlocked.docs) {
    const d = p.data(), uid = p.id;
    if (!d.username) continue;
    // Last sign of life: the last daily played, or the day the name was picked.
    const last = [dayBase(d.dailyLastDay), dayBase(d.nameAt)].filter(Boolean).sort().pop();
    if (!last || last >= cutoff) { kept++; continue; }
    const key = nameKey(d.username);
    const res = await db.doc(`usernames/${key}`).get();
    if (!res.exists || res.data().uid !== uid) { kept++; continue; }   // not this player's name any more
    const recRef = db.doc(`recovery/${key}`);
    const rec = await recRef.get();
    if (rec.exists && rec.data().emoji) { kept++; continue; }           // locked in after all
    console.log(`${DRY ? "[dry run] would release" : "Releasing"} "${d.username}" (last played ${last})`);
    if (DRY) continue;
    try {
      await auth.updateUser(uid, { email: `released-${uid}@players.dailyclimb.invalid` });
    } catch (e) {
      if (e.code !== "auth/user-not-found") { console.error(`  couldn't free the sign-in for "${d.username}": ${e.message}`); continue; }
    }
    try { await auth.updateUser(uid, { providersToUnlink: ["password"] }); } catch (e) { /* the device can still pick a new name next time */ }
    await db.doc(`usernames/${key}`).delete();
    if (rec.exists) await recRef.delete();
    await p.ref.set({ username: FieldValue.delete(), name: FieldValue.delete(), nameOnly: FieldValue.delete(), nameAt: FieldValue.delete(), released: today }, { merge: true });
    released++;
  }
  console.log(`Never-locked names: ${released} released${DRY ? " (dry run)" : ""}, ${kept} kept.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
