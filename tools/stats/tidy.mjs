// Daily Climb: nightly tidy-up. Run by .github/workflows/daily-stats.yml after release-names.mjs.
//
// 1. Half-made name claims. Claiming a username writes recovery/{key} first, then the sign-in, then
//    usernames/{key}. A recovery record with no usernames record a day later is one of two things:
//      - the claim got as far as the sign-in (the account's sign-in address is the name's): the reservation
//        is written now, so the name shows as taken and the player keeps it;
//      - it never got that far (or someone wrote the record just to block the name): the record is deleted,
//        so the name can be picked again.
// 2. Move links (transfers/{token}) are good for 30 minutes and normally deleted when used. Any left a day
//    after they ran out are deleted (each holds a sign-in secret).
//
// TIDY_DRY_RUN=1 only logs.

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";

const DRY = process.env.TIDY_DRY_RUN === "1";
const DAY = 86400000;

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

const usernameEmail = (key) => key + "@players.dailyclimb.invalid";   // same as the game
const millis = (v) => (v && v.toMillis ? v.toMillis() : typeof v === "number" ? v : 0);

async function main() {
  const now = Date.now();
  const tag = DRY ? "[dry run] would " : "";

  let repaired = 0, cleared = 0;
  for (const rec of (await db.collection("recovery").get()).docs) {
    const r = rec.data(), key = rec.id;
    const made = millis(r.created) || millis(r.updated);
    if (made && now - made < DAY) continue;   // maybe mid-claim
    if ((await db.doc(`usernames/${key}`).get()).exists) continue;
    let owner = null;
    try { owner = await auth.getUserByEmail(usernameEmail(key)); } catch (e) { if (e.code !== "auth/user-not-found") throw e; }
    if (owner && owner.uid === r.uid) {
      console.log(`${tag}reserve "${r.username || key}" for the account that signed up with it`);
      if (!DRY) await db.doc(`usernames/${key}`).create({ uid: r.uid, username: r.username || key });
      repaired++;
    } else if (!owner) {
      console.log(`${tag}clear the unfinished claim on "${r.username || key}"`);
      if (!DRY) await rec.ref.delete();
      cleared++;
    } else {
      console.log(`"${r.username || key}": its sign-in belongs to another account, left for Tate`);
    }
  }

  let gone = 0;
  for (const t of (await db.collection("transfers").get()).docs) {
    if ((t.data().expires || 0) > now - DAY) continue;
    if (!DRY) await t.ref.delete();
    gone++;
  }
  console.log(`Name claims: ${repaired} reserved, ${cleared} cleared. Old move links: ${gone} ${DRY ? "would be " : ""}deleted.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
