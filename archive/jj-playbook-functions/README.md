# JJ Playbook — server push setup

Notifications that arrive when the app is **closed** must be sent from a server.
The app already collects a push token and saves it to `push:<idkey>`; the service
worker at the site root already receives background messages. This is the sender.

Five functions, all reading the single `jj_playbook` collection:

- **onUpdatePosted** — a coach posts a follow-up in Studio, to everyone on that code.
- **onSessionScheduled** — a session is added, to that session's group only
  (Quarterly Full Group, Monthly Small Group #1 or #2).
- **onChatMessage** — a new chat message, to everyone on the code except the author.
  Batched, so ten messages at once make one notification.
- **onLeaderJoined** — a new signup, to the coaches' devices, plus an email to
  `Charlie@jadin-jones.com` if SMTP is configured.
- **sessionReminders** — hourly sweep; anything starting in 60–120 minutes gets one
  "starts soon" push. A `pushmark:` doc prevents duplicates.
- **dailyReminders** — every five minutes. Reads the `schedule` array the app
  writes onto each `push:` doc (the 5 S's, Start Up, Shut Down, Deep Work), each
  with its own local time, and sends in the person's own timezone. If the
  reminder is on and its time has come, it sends — whether or not the tool was
  already logged today. Changing a reminder's time re-arms it for that day, so
  a moved reminder still arrives at the new time. Also prunes spent
  `remindmark:`/`pushmark:` docs older than two days, which matters because the
  app reads the whole collection on load.

Dead tokens are pruned automatically when FCM reports them unregistered.

## Deploy

From the project root (the folder containing `functions/`):

```
npm install -g firebase-tools
firebase login
firebase use test-6b2ab
cd functions && npm install && cd ..
firebase deploy --only functions
```

## Firebase console, one time

1. **Upgrade to Blaze.** Scheduled functions require it. This workload sits inside
   the free allowance, but the plan change is mandatory.
2. **Cloud Messaging → Web Push certificates** — confirm the VAPID key pair matches
   the `PUSH_VAPID_KEY` in the app. Regenerating it kills every existing token and
   everyone has to re-enable notifications.
3. After the first deploy, watch **Functions → Logs**. Every send logs
   `PUSH SENT n of m`, and `PUSH SKIPPED - no devices` when nobody is registered.

## Email on signup (optional)

`onLeaderJoined` emails the coach as well as pushing. It needs an SMTP connection
string stored as a secret, never in the source:

```
firebase functions:secrets:set SMTP_URL
```

Paste something like `smtps://user:pass@smtp.example.com:465`. Without it the push
still fires and the email is skipped with a log line.

## Who counts as a coach

`onLeaderJoined` decides from three things, in `index.js`: `ADMIN_NAMES`
(currently `['charlie']`, matched loosely against the name on the device),
`ADMIN_IDKEYS` (exact, empty by default), and anyone whose `resp:` record is
flagged `orgLead`. Add an idkey from a `push:` doc if the name match is too loose.

## Two hard requirements

- The app must be served from the **site root**. A service worker cannot control
  pages above its own directory, so a `/subfolder/` deploy silently breaks push.
- On iPhone, web push only works for apps **added to the Home Screen**. Safari tabs
  never receive background notifications, no matter what else is correct.

## Not covered here

The remaining away nudges — one day, module unlocks and a streak about to break —
have no function yet. Nothing in the app is waiting on them; they simply don't fire.

## Coming back

**awayNudges** — hourly, sends only inside the 9am hour in each person's own
timezone. Three days after their last app open, then seven, then once a week.
Each one points at the 5 S's. The app stamps `lastOpenAt` on every launch, so
opening the app resets the ladder; an `awaymark:` doc carrying that timestamp
stops a repeat within the same absence. Honours the `away.d3`, `away.d7` and
`away.weekly` flags on the `push:` doc.

## The coach's cadence

Four more sweeps, all hourly, each acting inside one hour of the person's own
local day so nothing lands at 3am, and each claiming a marker doc so an hourly
schedule can never send twice.

- **weeklyReview** — Friday 4pm local. A read-back of the week with their streak,
  not a demand. Off for anyone with `away.weekly === false`.
- **streakSave** — 8pm local, only when a streak of three or more has nothing
  logged and the app has not been opened that day. One attempt.
- **monthlyUnlock** — 9am local on the day a new fundamental opens, worked out
  from the org's `startDate` in thirty-day steps. Months 2 through 12.
- **deepWorkInvite** — 9am local, once a month, to people in month two or later
  who have never run a Deep Work block. Stops when they run one, and stops
  anyway after three asks.

Deep Work has no daily reminder by default — it is invited, not assigned.

## Saying well done

The only two that report good news rather than asking for something.

- **onFundamentalDone** — a Firestore trigger on the leader's own record. When
  the last question in a fundamental is submitted, it lands within seconds:
  which block just lit, and how many of the twelve are now lit.
- **celebrations** — hourly, delivered inside the 9am hour. Streak milestones at
  7, 30, 60, 100, 200 and 365 days, and a note when the assessment has moved
  five or more points above their own baseline.

### A note on markers

`remindmark:`, `pushmark:`, `weekmark:` and `streakmark:` are day-keyed and get
swept after two days. `awaymark:`, `unlockmark:`, `dwinvitemark:` and `milemark:`
are **not** pruned — they are the memory that stops a milestone being celebrated
twice. One small document per person per occasion.

## An orphan to know about

`fiveSDailyNudge` is deployed in the project but has no source here — a leftover
from an earlier build. It still fires on its old schedule and now overlaps with
`dailyReminders`. Remove it with:

```
firebase functions:delete fiveSDailyNudge --region us-central1
```
