# Lock-screen push notifications — what's left to do

The app side is finished: the VAPID key is in, Settings → Enable registers the
service worker and writes each device's token to Firestore as `push:<idkey>`.
What's missing is a real origin to run on and a server to do the sending.
These three files close that gap.

| File | Where it goes |
| --- | --- |
| `functions/index.js` | `functions/index.js` in your Firebase project |
| `functions/package.json` | `functions/package.json` |
| `functions/firebase-messaging-sw.js` | the **root of the deployed site** (e.g. `public/firebase-messaging-sw.js`) |

---

## 1. Turn on Blaze

Firebase console → ⚙ → Usage and billing → Modify plan → **Blaze**.

Cloud Functions won't deploy on Spark. With a couple hundred leaders you'll sit
inside the free allowance every month — set a budget alert at $5 for peace of
mind.

## 2. ~~Fill in the sender ID~~ — done

`firebase-messaging-sw.js` already carries the real values for project
`test-6b2ab` (sender `468112905284`). Nothing to edit.

## 3. Deploy

```bash
npm install -g firebase-tools
firebase login
cd <your-project-folder>
firebase init functions      # JavaScript, Node 20, skip ESLint, don't overwrite index.js
cd functions && npm install && cd ..
firebase deploy --only functions,hosting
```

The site must be served over HTTPS from the root — `firebase-messaging-sw.js`,
`manifest.webmanifest` and `assets/icon-192.png` all have to answer at the top
level of the domain. Opening the HTML file locally will never work: service
workers don't run from `file://`.

## 4. Have people install it

- **iPhone (16.4+):** Safari → Share → **Add to Home Screen** → open the app
  from that icon → Settings → Enable notifications. Web push does not work in
  the Safari tab; it only works from the home-screen icon. This is the step
  people skip.
- **Android:** works in Chrome, but the install prompt makes it more reliable.
- Either way the OS permission prompt appears only once. If someone taps "Don't
  allow", they have to re-enable it in system settings — the app can't ask again.

## 5. Check it

1. Enable on your own phone. You should get the "Notifications are on" test banner.
2. Confirm a `push:<idkey>` doc appeared in the `jj_playbook` collection.
3. Close the app completely (swipe it away).
4. From Studio, schedule a session for Monthly Small Group #1.
5. The banner should land on the lock screen of everyone in that group within a
   few seconds. Watch `firebase functions:log` if it doesn't.

## 6. Email alerts to charlie@jadin-jones.com

When someone joins, you get a push **and** an email. The email needs an SMTP
connection string, stored as a Firebase secret so it never sits in the code:

```bash
firebase functions:secrets:set SMTP_URL
```

Paste one line when prompted:

- **Google Workspace** (jadin-jones.com is on Google): make an
  [App Password](https://myaccount.google.com/apppasswords), then
  `smtps://charlie@jadin-jones.com:APP_PASSWORD@smtp.gmail.com:465`
- **SendGrid:** `smtps://apikey:SG.xxxxx@smtp.sendgrid.net:465`
- **Postmark / Mailgun:** their SMTP string works the same way.

Then redeploy. If the secret isn't set, the function just skips the email and
still sends the push — nothing breaks.

The address and the From line are the two constants at the top of `index.js`
(`ADMIN_EMAIL`, `MAIL_FROM`). With Gmail, set `MAIL_FROM` to your own address
— Google rewrites anything else.

---

## What each function does

- **`onUpdatePosted`** — a coach posts a follow-up → everyone on that access code.
- **`onSessionScheduled`** — a session is scheduled → only its group, titled with
  the group name (Quarterly Full Group / Monthly Small Group #1 / #2).
- **`onChatMessage`** — new group chat message → everyone on the code except the
  author; several messages at once collapse into one "3 new messages".
- **`onLeaderJoined`** — someone signs up with an access code → you get a push
  and an email to charlie@jadin-jones.com with their name, email, org and code.
  Only fires on a brand-new record, so it won't repeat as they use the app.
- **`sessionReminders`** — runs hourly, sends one "starts soon" push about an
  hour before each session. A `pushmark:` doc prevents duplicates.

Tokens FCM reports as retired are deleted automatically, so the list stays clean
as people change phones.

## Notes

- **Making sure the join alert reaches you.** `index.js` decides a device is
  yours if the name it registered with contains "charlie", if its idkey is in
  `ADMIN_IDKEYS`, or if that person is flagged as an org lead in the roster.
  Enable notifications on your own phone, find your `push:<idkey>` doc in
  Firestore, and paste that idkey into `ADMIN_IDKEYS` at the top of `index.js`
  for an exact match that doesn't depend on how you typed your name.

- Apple needs no developer account — FCM handles APNs delivery for web push.
- The reminder times print in `America/Chicago`; change `timeZone` in
  `whenText()` if that's wrong.
- The functions read the same one-collection storage shape the app writes
  (`jj_playbook/<key>` → `{value: "<json>"}`), so nothing about the app's data
  needs to change.
- If you later lock down Firestore rules, keep the `push:` documents writable by
  the app and readable by the functions (Admin SDK bypasses rules, so only the
  client write matters).
