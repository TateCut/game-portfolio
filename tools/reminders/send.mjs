// Daily Climb reminder sender. Run hourly by .github/workflows/daily-reminders.yml.
//
// Each player who turned reminders on has players/{uid}.reminder =
//   { on: true, hour: 0-23 (their local time), tz: "America/Chicago",
//     tokens: [push token per device], lastSentDay: "YYYY-MM-DD" }
// written by the game (index.html, MatchDB.enableReminders).
//
// A player gets a reminder when, in THEIR time zone:
//   - it's their reminder hour or up to 2 hours after (GitHub's cron can run
//     late, so a window instead of an exact hour),
//   - they haven't played today (players/{uid}.dailyLastDay),
//   - and they haven't already been reminded today (reminder.lastSentDay).
//
// TEST_UID set (the "Run workflow" button's input): send to that one player
// right now, ignoring the checks above, and don't mark them as reminded.
//
// Needs the FIREBASE_SERVICE_ACCOUNT secret (the service account JSON).

import { initializeApp, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";

const GAME_URL = "https://tatecut.github.io/game-portfolio/games/3-2-1/";
const SEND_WINDOW_HOURS = 3;
const TEST_UID = (process.env.TEST_UID || "").trim();

let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "");
} catch (e) {
  console.error("The FIREBASE_SERVICE_ACCOUNT secret is missing or isn't valid JSON. " +
    "Add it under GitHub > Settings > Secrets and variables > Actions.");
  process.exit(1);
}
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();
const fcm = getMessaging();

// "YYYY-MM-DD" and hour (0-23) for a moment in a given IANA time zone.
function localParts(tz, date) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
}
// The game's day keys carry a version tag ("2026-09-25-r6"); compare dates only.
const dayBase = (key) => (/^\d{4}-\d{2}-\d{2}/.exec(key || "") || [""])[0];

function messageFor(player, today, yesterday) {
  const last = dayBase(player.dailyLastDay);
  const streak = last === yesterday ? (player.dailyStreak || 0) : 0;
  if (streak >= 2) {
    return { title: `Your ${streak}-day streak is on the line 🔥`, body: "Today's climb is waiting. Keep it going." };
  }
  return { title: "Today's climb is waiting ⛰️", body: "Three new climbs, 3 letters up to 8." };
}

const DEAD_TOKEN_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
]); // not "invalid-argument": that can mean a bad message, and would wipe good tokens

async function main() {
  const now = new Date();
  let docs;
  if (TEST_UID) {
    // The test input can be a player ID or the player's in-game name (a
    // home-screen app keeps its own storage, so dev mode — which shows the
    // ID — is awkward to reach there).
    const byId = await db.doc(`players/${TEST_UID}`).get();
    docs = byId.exists ? [byId] : (await db.collection("players").where("name", "==", TEST_UID).get()).docs;
    if (!docs.length) console.log(`No player with ID or name "${TEST_UID}".`);
  } else {
    docs = (await db.collection("players").where("reminder.on", "==", true).get()).docs;
  }

  let sent = 0, skipped = 0, failed = 0, pruned = 0;
  for (const snap of docs) {
    if (!snap.exists) { console.log(`No player ${snap.id}`); continue; }
    const player = snap.data();
    const r = player.reminder || {};
    const tokens = (r.tokens || []).filter(Boolean);
    if (!tokens.length) {
      if (TEST_UID) console.log(`Player ${snap.id} has no reminder devices. Turn reminders on in the game first.`);
      skipped++;
      continue;
    }

    let today, yesterday, hour;
    try {
      ({ day: today, hour } = localParts(r.tz || "UTC", now));
      yesterday = localParts(r.tz || "UTC", new Date(now.getTime() - 86400000)).day;
    } catch (e) {
      console.log(`Player ${snap.id}: bad time zone "${r.tz}", skipping`);
      skipped++;
      continue;
    }

    if (!TEST_UID) {
      const target = Number.isInteger(r.hour) ? r.hour : 18;
      const inWindow = hour >= target && hour < target + SEND_WINDOW_HOURS;
      if (!inWindow || dayBase(player.dailyLastDay) === today || r.lastSentDay === today) { skipped++; continue; }
    }

    const { title, body } = messageFor(player, today, yesterday);
    const res = await fcm.sendEachForMulticast({
      tokens,
      webpush: {
        headers: { TTL: String(6 * 3600), Urgency: "high" }, // stale after 6h: don't deliver yesterday's nudge
        notification: { title, body, icon: GAME_URL + "icon-192.png", tag: "daily-reminder" },
        data: { title, body, url: GAME_URL },
        fcmOptions: { link: GAME_URL },
      },
    });

    const dead = [];
    res.responses.forEach((x, i) => {
      if (x.success) return;
      const code = x.error && x.error.code;
      if (DEAD_TOKEN_CODES.has(code)) dead.push(tokens[i]);
      else console.log(`Player ${snap.id}: send failed (${code || "unknown error"})`);
    });

    const update = {};
    if (dead.length) { update["reminder.tokens"] = FieldValue.arrayRemove(...dead); pruned += dead.length; }
    if (res.successCount > 0 && !TEST_UID) update["reminder.lastSentDay"] = today;
    if (Object.keys(update).length) await snap.ref.update(update);

    if (res.successCount > 0) sent++; else failed++;
    if (TEST_UID) console.log(`Test to ${snap.id}: "${title}" to ${res.successCount}/${tokens.length} device(s)`);
  }
  console.log(`Done. Reminded ${sent} player(s), skipped ${skipped}, failed ${failed}, removed ${pruned} dead device token(s).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
