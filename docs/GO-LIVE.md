# JJ Playbook — go-live runbook

Launch tonight: live site **jjplaybook.netlify.app**, Firebase project
**test-6b2ab**, no Microsoft sign-in, no custom domain.
Dev is **jj-playbook-dev.netlify.app** / **jj-playbook-dev**.

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
4. Test on Dev in a normal Chrome window, and on a phone:
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
   - **Microsoft off**
2. Authentication → Settings → Authorized domains: `jjplaybook.netlify.app` is listed.
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
   - If it has website restrictions, they include `https://jjplaybook.netlify.app/*`.
   - If it has API restrictions, they include Identity Toolkit, Token Service,
     Cloud Firestore, FCM Registration and Firebase Installations.
   - **Success:** all present. Changes to the key can take about 5 minutes to apply.

## 6. Google OAuth redirect URI for live

The live app now hands sign-in off through its own `/__/auth`. Google Cloud
console → test-6b2ab → APIs & Services → Credentials → OAuth 2.0 client
"Web client (auto created by Google Service)":
- Authorized JavaScript origins: add `https://jjplaybook.netlify.app`.
- Authorized redirect URIs: add `https://jjplaybook.netlify.app/__/auth/handler`.
  Keep `https://test-6b2ab.firebaseapp.com/__/auth/handler`.
- **Success:** saved. Do this before step 7, or Google sign-in on live fails
  with `redirect_uri_mismatch`.

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
- `https://jjplaybook.netlify.app/` loads the gate with Google and email only
  (no Microsoft button).
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

## 12. Test as steve@jadin-jones.com on PLAYBOOK26

In a private window on `https://jjplaybook.netlify.app`, and on a phone:
- Sign in (Google, or email with Forgot password). **Success:** you land in
  PLAYBOOK26 without typing the code.
- The member list, map, AI coach, colleague evidence, own peer round and
  notifications on and off all work.
- A peer link answered from another browser is counted.
- As an admin, Studio shows the roster, and Make lead works.

## 13. Email members

Send the sign-in instructions, for example:

> The Playbook has moved to a new sign-in. Go to https://jjplaybook.netlify.app
> and choose **Continue with Google**, or sign in with your email and password.
> First time with email? Tap **Forgot password** to set one. Use the same
> email your program invited. If it asks for a code, your program lead has it.
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
| The live rules (step 11) | Rules → History → the previous version → publish. This takes effect within a minute. |
| Granola notes stop landing | Put the old value back as `GRANOLA_SECRET_OLD` (or `GRANOLA_SECRET`) until Zapier/Make has the new one. |

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

The fix is one document per message: `chat/{CODE}/messages/{id}`, holding
`ownerEmail`, `text` and `ts`.
- Rules: program members may read and create their own; only the owner (or an
  admin) may edit or delete; reactions are a map that anyone in the program may
  change for their own key only.
- The app listens to the subcollection instead of the one document.
- A one-off script copies the existing arrays across.
- Until then, the backups in step 8 are the safety net.
