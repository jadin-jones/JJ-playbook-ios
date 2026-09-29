# JJ Playbook — go-live runbook

| Site | Addresses | Firebase project |
|---|---|---|
| Live | **playbook.jadin-jones.com** and jjplaybook.netlify.app | **test-6b2ab** |
| Dev | **dev.playbook.jadin-jones.com** and jj-playbook-dev.netlify.app | **jj-playbook-dev** |

Both addresses of a site keep working. The app picks the project by host:
anything containing `dev` is Dev. Microsoft sign-in is offered on all four
addresses; on live it works only after step 11b.

This file holds no secrets. Keys and passwords go only into the Netlify,
Firebase and Google Cloud consoles, or into a terminal prompt that does not
echo them. Never paste one into chat or commit it.

Netlify credits: one build for the push to Dev, one for a fix push if one is
needed, one for the live deploy. Rolling back a deploy (Netlify → Deploys →
an earlier deploy → **Publish deploy**) costs no build.

Each step says **Success:** what you should see. If a step fails, stop and go
to [Rollback](#rollback) before carrying on.

---

## 1. Push to Dev and test on today's Dev rules

1. Netlify → Dev site → Site configuration → Build & deploy. Check:
   - Base directory `/`
   - Publish directory `public`
   - Functions directory: `netlify.toml` says `netlify/functions`, and it
     overrides the dashboard. Setting the dashboard to the same value avoids
     confusion. The top-level `functions/` folder is Firebase Cloud Functions,
     never Netlify's.
2. Push `develop` (Claude does this on your go-ahead):
   ```
   git push origin develop
   ```
3. Wait for the Dev deploy to finish.
   - **Success:** the deploy is Published, and its Functions tab lists `auth-proxy`,
     `coach`, `granola`, `join`, `members`, `migrate-peers`, `ms-verify` and `peer`.
4. Test on Dev in a normal Chrome window, and on a phone, on
   **dev.playbook.jadin-jones.com**. Then do a quick sign-in on
   jj-playbook-dev.netlify.app too:
   - Google sign-in, which goes through `https://jj-playbook-dev.netlify.app/__/auth/handler`.
   - Email and password sign-in.
   - Microsoft sign-in (Dev only).
   - A returning member lands in their program. Someone in several
     programs gets the picker.
   - The member list, map, chat @-names and the AI coach answer.
   - Adding what you saw to a colleague's goal.
   - Opening a team round, and a colleague seeing it.
   - Notifications: switching on shows "on for this device, for all your
     groups", and switching off works. After a refresh the switch matches.
   - Studio as admin: roster, Make lead, group buttons, program settings.
   - A peer-review link (`?r=TOKEN`) opened in a private window can be answered.
   - DevTools → Network → the page's response headers include
     `strict-transport-security`, `x-frame-options` and
     `content-security-policy-report-only`.
   - **Success:** everything above works, and the console shows no errors other than
     Content-Security-Policy **report-only** warnings.
   - Note these warnings down; they are what the policy would block later.

## 2. Publish the rules on Dev, then retest

1. In the Codespace:
   ```
   npm --prefix test/rules install && npm --prefix test/rules test
   ```
   - **Success:** the output ends `ALL 46 PASSED` (or more).
2. Firebase console → jj-playbook-dev → Firestore → Rules. Paste
   `firestore.rules` from the repo and publish.
   - The console keeps every earlier version under the Rules history.
3. Retest step 1.4 as each of these:
   - a member
   - a program lead (made in Studio with Make lead)
   - an admin

   Also check:
   - a colleague cannot see your individual peer round, but can see a team round
   - revoked access still shows as ended
   - **Success:** the same results as step 1.4.

## 3. Dev scripts: dry runs, then real runs

The Codespaces secrets hold the Dev service account
(`FIREBASE_PROJECT_ID=jj-playbook-dev`, `FIREBASE_CLIENT_EMAIL`,
`FIREBASE_PRIVATE_KEY`).

```
node scripts/backfill-owner.js --project jj-playbook-dev
```
- **Success:** it prints `Project: jj-playbook-dev`, then these sections: Stamp a
  missing ownerEmail, Re-stamp records an admin took over, Stamp peerMode
  on peer rounds, and Skipped by reason.
- `resp:TEST26:test-example-com` shows under **placeholder**.
- Nothing is written. The plan is saved under `scripts/out/`.

```
node scripts/backfill-owner.js --project jj-playbook-dev --apply scripts/out/<the plan it printed>
node scripts/backfill-owner.js --project jj-playbook-dev --leads
node scripts/backfill-owner.js --project jj-playbook-dev --leads --apply scripts/out/<that plan>
node scripts/build-members.js  --project jj-playbook-dev
node scripts/build-members.js  --project jj-playbook-dev --apply scripts/out/<that plan>
```
Each `--apply` asks you to type `jj-playbook-dev`.
- **Success:** it prints `Written: N of N`, and a second dry run prints
  `Changes: none`.
- Read every **not-listed** name in the build-members dry run. Add anyone who
  belongs to Studio → Who can join, then dry-run again.

Then retest a returning member's routing and a lead's org dashboard.
- **Success:** the lead sees the dashboard with peer averages.

## 4. Live Netlify: build settings, environment variables and the Granola secret

Netlify → **live** site (jjplaybook) → Site configuration.

### 4a. Build settings: check these before step 7

Today's `main` has `publish = "."` and no `index.html` at the repo root, yet
live serves the app at `/`. So live is either not built from `main` by git, or
its dashboard differs. Check:
- Build & deploy → Continuous deployment: the repository is
  **jadin-jones/JJ-playbook-ios** and the production branch is **`main`**. If
  live is not linked to the repo (manual or CLI deploys), merging does not
  deploy it. Stop and link it first, or say so.
- **Base directory `/`** (empty). If it is `public`, Netlify ignores the root
  `netlify.toml`, and every `/api/*` route and function breaks after the merge.
- Publish directory `public`, and Functions directory `netlify/functions`.
  After the merge, `netlify.toml` sets both anyway.
- Branch deploys: off, or `main` only.
- Domain management: `playbook.jadin-jones.com` is added to the live site with
  a valid HTTPS certificate (and `dev.playbook.jadin-jones.com` to the Dev
  site). `jjplaybook.netlify.app` must keep serving too: don't turn on a
  redirect from it. Netlify's `URL` variable becomes the primary domain,
  which is what the one-time Microsoft email falls back to.

### 4b. Environment variables (Production context)

Check the jjplaybook list against this, which is everything the merged code
reads. Values go in the dashboard only.

| Variable | Live value | Read by |
|---|---|---|
| `FIREBASE_PROJECT_ID` | `test-6b2ab` | every function (Admin SDK) and auth-proxy (which project's `/__/auth` to serve) |
| `FIREBASE_CLIENT_EMAIL` | the test-6b2ab service account, `…@test-6b2ab.iam.gserviceaccount.com` | the Admin SDK |
| `FIREBASE_PRIVATE_KEY` | that account's `private_key`, with its `\n` sequences | the Admin SDK |
| `ANTHROPIC_API_KEY` | the live key | `/api/coach` |
| `GRANOLA_SECRET` | the new secret (see 4c) | `/api/granola` |
| `GRANOLA_SECRET_OLD` | the previous secret, only during the changeover | `/api/granola` |
| `COACH_EMAIL` | `lucas@jadin-jones.com` (optional; that is the default) | `/api/granola` |
| `URL` | set by Netlify itself; don't add it | `/api/ms-verify` |
| `SECRETS_SCAN_SMART_DETECTION_OMIT_VALUES` | keep it. It must list both public web API keys (the `AIzaSyAgcR…` live key and the `AIzaSyBuWZ…` Dev key); both appear in `public/index.html` and `netlify/functions/ms-verify.js`, and smart detection would otherwise fail the build. Copy Dev's value. | Netlify's build secret scan |

**Delete these two after the live deploy in step 7 is Published.** Only today's
live `granola.js` reads them, and the merged code reads neither:
- `FIREBASE_PROJECT`. It is set to **`jj-playbook-dev`** on live, so today's live
  Granola intake reads and writes the **Dev** Firestore project (see 4c).
- `FIREBASE_API_KEY`. It is the web API key that intake used for Firestore REST
  calls. Deleting it also stops the build's env-value secret scan from matching
  a key that appears in the site.

### 4c. The Granola secret: rotate it now

Today's live `granola.js` (on `main`) has a hard-coded fallback secret, and
since the repo went public it is readable in its history. If the live
`GRANOLA_SECRET` equals that fallback, treat it as known.
1. Set `GRANOLA_SECRET_OLD` to the current `GRANOLA_SECRET`. Skip this if the
   current value is the public fallback: then there is no changeover, and
   notes just fail until Zapier/Make has the new one.
2. Set `GRANOLA_SECRET` to a new long random value, for example from
   `openssl rand -base64 32` in the Codespace.
3. Put the new value in the Zapier/Make step that posts to `/api/granola`.
4. After step 7, once a note lands and the function log no longer says
   "sent with GRANOLA_SECRET_OLD", delete `GRANOLA_SECRET_OLD`.

Until step 7, live Granola notes go to **Dev** (because `FIREBASE_PROJECT` is
`jj-playbook-dev`). Under Dev's V3 rules those unauthenticated calls are
refused, so notes fail with "No member matched". To see what happened, check
the live site's function log for `granola`, and the `gin:` records in the Dev
Firestore.
- **Success:** 4a matches, and every variable in 4b is present for Production.

## 5. test-6b2ab: sign-in, push and keys

Firebase console → **test-6b2ab**:
1. Authentication → Sign-in method:
   - **Email/Password** on
   - Google on
   - **Microsoft off** for now; it goes on in step 11b, after the live rules
2. Authentication → Settings → Authorized domains: **`playbook.jadin-jones.com`**
   and `jjplaybook.netlify.app` are both listed. Sign-in and the emailed links
   (password reset, verification, the one-time Microsoft link) are refused
   from any address that isn't listed.
   - Do the same on **jj-playbook-dev** for `dev.playbook.jadin-jones.com` and
     `jj-playbook-dev.netlify.app` before testing Dev on its new address.
3. Leave "Enable create (sign-up)" on tonight. Turning it off may also block
   first-time Google sign-ins; test that on Dev first (post-launch).
4. Project settings → Cloud Messaging:
   - **Firebase Cloud Messaging API (V1)** is Enabled.
   - Web Push certificates: the public key starts **`BInNmntOm`**, which is the
     key the app uses on live.
   - If it does not match, stop: live push would fail.

Google Cloud console → project test-6b2ab → APIs & Services:
1. Enabled: **FCM Registration API**, **Firebase Installations API** and
   **Firebase Cloud Messaging API**.
2. Credentials → the browser key starting `AIzaSyAgcR`:
   - If it has website restrictions, they include `https://playbook.jadin-jones.com/*`
     and `https://jjplaybook.netlify.app/*`. See 11b: website restrictions also
     block the one-time Microsoft email, which is sent from the server.
   - If it has API restrictions, they include Identity Toolkit, Token Service,
     Cloud Firestore, FCM Registration and Firebase Installations.
   - **Success:** all present. Changes to the key can take about 5 minutes to apply.

## 6. Redirect URIs for every address (Google and Microsoft)

The app hands sign-in off through each address's own `/__/auth`, so every
address needs its handler registered. Keep the `firebaseapp.com` ones too.

**Google:** Google Cloud console → the project → APIs & Services → Credentials →
OAuth 2.0 client "Web client (auto created by Google Service)". Add the
JavaScript origins and the redirect URIs:

| Project | Authorized JavaScript origins | Authorized redirect URIs |
|---|---|---|
| test-6b2ab (live) | `https://playbook.jadin-jones.com`, `https://jjplaybook.netlify.app` | `https://playbook.jadin-jones.com/__/auth/handler`, `https://jjplaybook.netlify.app/__/auth/handler`, `https://test-6b2ab.firebaseapp.com/__/auth/handler` |
| jj-playbook-dev | `https://dev.playbook.jadin-jones.com`, `https://jj-playbook-dev.netlify.app` | `https://dev.playbook.jadin-jones.com/__/auth/handler`, `https://jj-playbook-dev.netlify.app/__/auth/handler`, `https://jj-playbook-dev.firebaseapp.com/__/auth/handler` |

**Microsoft:** Azure portal → App registrations → the app → Authentication →
Web → Redirect URIs.

| App | Redirect URIs |
|---|---|
| **JJ Playbook Live** (new, the stopgap in the personal Azure directory; supported account types: any organizational directory and personal Microsoft accounts) | `https://playbook.jadin-jones.com/__/auth/handler`, `https://jjplaybook.netlify.app/__/auth/handler`, `https://test-6b2ab.firebaseapp.com/__/auth/handler` |
| The Dev app | add `https://dev.playbook.jadin-jones.com/__/auth/handler` next to its existing ones |

Put the live app's client secret in the password manager, not anywhere in
the repo. It's used in step 11b.
- **Success:** saved in all four places. Do this before step 7, or sign-in on
  live fails with `redirect_uri_mismatch` (Google) or `AADSTS50011` (Microsoft).

## 7. Merge develop into main by pull request, and publish live

`main` is protected: changes reach it only through a pull request. You open
and merge it, not Claude.

Before you start:
- 4a is checked: live is linked to this repo and builds `main` with base `/`.
- `develop` includes `61d5e76`, the merge of `main` into `develop` that keeps
  develop's files. `main` has a hand-applied production commit (`fced36a`)
  that would otherwise conflict in `public/index.html`. It rides along with the
  one fix push to `develop` after Josh's test. If there is no fix push, open the
  PR from `backup/prelaunch` instead (compare `backup/prelaunch`); it has the
  same commits, and Netlify doesn't build it.

1. Open the pull request, either on GitHub (Pull requests → New → base `main`,
   compare `develop`) or in the Codespace:
   ```
   gh pr create --base main --head develop --title "Launch: V3 sign-in, members, rules and security" --body "See docs/GO-LIVE.md"
   ```
2. Check the PR's Files changed tab. It should hold only what was tested on Dev
   (the same head commit as the Dev deploy).
3. Merge it with **Create a merge commit**. Don't squash: a squash leaves
   `develop` and `main` with different histories, and the next PR gets messy.
- **Success:** the PR is Merged, and Netlify → live → Deploys shows a
  production deploy from `main` that ends up Published, with the same
  function list as Dev.
- `https://playbook.jadin-jones.com/` and `https://jjplaybook.netlify.app/` both
  load the gate with Google, Microsoft and email. Microsoft answers "not
  turned on yet" until 11b.
- `https://jjplaybook.netlify.app/READ-ME-FIRST.md` is a 404, because only
  `public/` is served now.
- Sign in with Google once as an admin. **Success:** you reach Studio.
- Then, in Netlify → live → Environment variables, delete `FIREBASE_PROJECT`
  and `FIREBASE_API_KEY` (4b). The new code reads neither. This takes effect
  on the next function call, with no deploy.

## 8. Firestore backup

Firebase console → test-6b2ab → Firestore → Import/Export → Export the whole
database to a bucket, or run in Cloud Shell:
```
gcloud firestore export gs://<your backup bucket>/pre-launch-$(date +%F) --project test-6b2ab
```
- **Success:** the export operation shows Completed, and the folder is in the bucket.
- Don't carry on without it.

## 9. Peer migration on live

Studio → the peer-migration card:
1. Dry run. Read the ready and skipped lists.
2. Run for the listed rounds.
- **Success:** a second dry run shows nothing ready.
- Old 6-character links still open.

## 10. Live scripts

In a new terminal, so the Dev secrets in other terminals are unaffected. The
key is read without echo, so it is not saved in shell history.
```
export FIREBASE_PROJECT_ID=test-6b2ab
export FIREBASE_CLIENT_EMAIL=<live client_email>
read -rs FIREBASE_PRIVATE_KEY && export FIREBASE_PRIVATE_KEY   # paste the private_key, then Enter
```
- `read -rs` shows nothing while you paste. Paste the `private_key` value from
  the service-account JSON as **one line**: the text between its quotes, with
  the `\n` sequences left as they are, and no quotes. Then press Enter.
  A multi-line PEM would be cut off at the first line.
- The first run prints `Service account:`; check it ends
  `@test-6b2ab.iam.gserviceaccount.com`. The scripts refuse a service account
  from any other project, so the Dev Codespaces secrets can't reach live:
  in a shell that still has them, `--project test-6b2ab --live` is refused.
Then:
```
node scripts/backfill-owner.js --project test-6b2ab --live
node scripts/backfill-owner.js --project test-6b2ab --live --apply scripts/out/<plan>
node scripts/backfill-owner.js --project test-6b2ab --live --leads
node scripts/backfill-owner.js --project test-6b2ab --live --leads --apply scripts/out/<plan>
node scripts/build-members.js  --project test-6b2ab --live
node scripts/build-members.js  --project test-6b2ab --live --apply scripts/out/<plan>
```
- Every run prints `Project: test-6b2ab (LIVE)`.
- Each `--apply` asks you to type `test-6b2ab`.
- Without `--live` the scripts refuse.
- **Success:** each apply prints `Written: N of N`, and a second dry run prints
  `Changes: none`.
- Add anyone in the build-members **not-listed** list who belongs, then run it
  again.

When done: `unset FIREBASE_PRIVATE_KEY FIREBASE_CLIENT_EMAIL`, or close the terminal.

## 11. Publish the rules on live

1. Firebase console → test-6b2ab → Firestore → Rules. Note which version is
   current. It stays in the Rules history, which is the rollback.
2. Run `npm --prefix test/rules test` once more. **Success:** 46 passed.
3. Paste `firestore.rules` from `main` and publish.
- **Success:** it publishes without errors.

## 11b. Microsoft on live

Enable Microsoft on test-6b2ab **only after the live rules (step 11) are
published**. Those rules refuse admin to Microsoft sign-ins and require the
one-time mailbox check (`msVerified`) before a Microsoft sign-in can read
anything.

1. Firebase console → test-6b2ab → Authentication → Sign-in method → Add new
   provider → **Microsoft**. Enter the **JJ Playbook Live** app's client ID and
   secret, from the password manager. Leave the tenant empty (common).
2. The one-time email (`/api/ms-verify`) needs:
   - **Email/Password** on (step 5). Firebase sends the check as its standard
     *email verification* email, through the Identity Toolkit
     `sendOobCode` call with the public web key.
   - **Email link (passwordless) sign-in is not needed.** The link is our own
     continue URL (`/?msv=…`), not a sign-in link.
   - Authorized domains: both live addresses (step 5), because the continue URL
     is the address the person is using.
   - Env vars: nothing new. It uses `FIREBASE_*` and Netlify's own `URL`.
   - The web key `AIzaSyAgcR…` must allow the call from the server. If that key
     has **website restrictions**, a server call carries no referrer and is
     refused (`API_KEY_HTTP_REFERRER_BLOCKED`), so the email never goes. Then
     either take the website restriction off (keep the API restrictions, which
     must include Identity Toolkit), or tell Claude to switch ms-verify to the
     Admin SDK's link generator plus our own mail.
3. Test it: in a private window on `playbook.jadin-jones.com`, sign in with
   Microsoft as a member (not an admin), join, and follow the emailed link.
   - **Success:** the link comes back to `playbook.jadin-jones.com`, "Email
     confirmed" shows, and the join works. An admin address through Microsoft is
     refused.

## 12. Test as steve@jadin-jones.com on PLAYBOOK26

In a private window on `https://playbook.jadin-jones.com`, and on a phone.
Then do a quick sign-in on `https://jjplaybook.netlify.app` too:
- Sign in (Google, or email with Forgot password). **Success:** you land in
  PLAYBOOK26 without typing the code.
- The member list, map, AI coach, colleague evidence, own peer round and
  notifications on and off all work.
- A peer link answered from another browser is counted.
- As an admin, Studio shows the roster, and Make lead works.

## 13. Email members

Send the sign-in instructions, for example:

> The Playbook has moved to a new sign-in. Go to https://playbook.jadin-jones.com
> and use the email your program invited you with: **Continue with Google**,
> **Continue with Microsoft** for a work Microsoft account, or your email and
> password. First time with email? Tap **Forgot password** to set one (see the
> open question below: this only works once your account exists). If it asks
> for a code, your program lead has it.
> On iPhone, add it to your Home Screen (Share → Add to Home Screen) and turn
> on notifications in My Profile.

---

## Rollback

| If this fails | Undo it like this |
|---|---|
| A Dev deploy (step 1) | Netlify → Dev → Deploys → the previous deploy → **Publish deploy**. Then fix it on `develop` in one more push. |
| The Dev rules (step 2) | Firebase console → jj-playbook-dev → Rules → History → the previous version → publish. `b197f2b:firestore.rules` holds the Dev rules from before. |
| The Dev scripts (step 3) | They only add ownerEmail, peerMode, leads and program codes. The saved plan lists every change. Put a single record right in the console; for anything larger, import a Dev export. |
| The live deploy (step 7) | Netlify → live → Deploys → the last good production deploy → **Publish deploy** (no build). Then revert the merge through a pull request (GitHub → the merged PR → **Revert**, then merge that PR). While a revert PR is open, don't push to `main` by other means. |
| Rolling back to the old live deploy after deleting `FIREBASE_PROJECT` | The old `granola.js` then falls back to `test-6b2ab`, the live project, which is the right one. Leave the two variables deleted. |
| Google sign-in on live (`redirect_uri_mismatch`) | Add the URI from step 6. The fix applies within minutes, and no deploy is needed. |
| Push on live | Check step 5: the web push certificate, the APIs and the key restrictions. No deploy is needed. |
| The peer migration or scripts on live (steps 9 and 10) | Import the step 8 export (Firestore → Import). This replaces the data with the pre-launch copy, so do it only for real damage. |
| Microsoft on live (step 11b) | Firebase console → test-6b2ab → Authentication → Sign-in method → Microsoft → disable. The button then answers "not turned on yet". |
| The live rules (step 11) | Rules → History → the previous version → publish. This takes effect within a minute. |
| Granola notes stop landing | Put the old value back as `GRANOLA_SECRET_OLD` (or `GRANOLA_SECRET`) until Zapier/Make has the new one. |

## Open question: returning members with Microsoft work emails

Many members' invited email is a work Microsoft (Outlook or Exchange) address
with no Google account and no Firebase account yet.
- **Forgot password doesn't help them.** Firebase answers a reset for an address
  with no account exactly as for one that has an account (email enumeration
  protection), and sends nothing. The app then says "If there is an account for
  …, a link … is on its way", and nothing arrives. So "First time? … tap
  Forgot password to set one" works only for accounts an admin has already
  created.
- **Microsoft on live (step 11b) covers them.** They sign in with Microsoft, and
  the first join sends the one-time email. Until 11b, their options are:
  1. an admin creates their email/password account first (Firebase console →
     Authentication → Add user), then they use Forgot password;
  2. they use Google, if the address is a Google account; or
  3. a small script creates accounts for every `members` email that has none
     (not built; ask Claude).
- Decide before emailing members (step 13), and word the email to match.

## After launch

These are in the handoff notes, in order:
- universal reminders
- Task B notification toggles
- Microsoft on live, with a publisher-verified Entra app in the JadinJones tenant
- App Check
- the chat server fix (below)
- a custom domain, with email SPF/DKIM for a custom sender
- the app stores

### Chat: every member can overwrite the whole thread

`chat:CODE` is one document with a `messages` array. Reactions, pins,
deletes, and a send that falls back, all read the array and write it back
whole. The rules can't check a single message, so any member of a program
can alter or erase anyone's messages, or all of them.

Also after launch: `functions/index.js` builds push-notification links from
`SITE_URL = https://jjplaybook.netlify.app`, and `capacitor.config.json` points the
iOS app at the same address. Both keep working, but they open the netlify.app
address, where a member signed in on `playbook.jadin-jones.com` isn't signed
in. Move them to the custom domain with the next Functions deploy and app build.

The fix is one document per message: `chat/{CODE}/messages/{id}`, holding
`ownerEmail`, `text` and `ts`.
- Rules: program members may read and create their own; only the owner (or an
  admin) may edit or delete; reactions are a map that anyone in the program may
  change for their own key only.
- The app listens to the subcollection instead of the one document.
- A one-off script copies the existing arrays across.
- Until then, the backups in step 8 are the safety net.
