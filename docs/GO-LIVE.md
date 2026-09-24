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

## 4. Live Netlify: environment variables and the Granola secret

Netlify → **live** site → Site configuration.

1. Check the build settings are the same as Dev's:
   - base `/`
   - publish `public`
   - production branch `main`
2. Environment variables. Set values in the dashboard only:
   - `FIREBASE_PROJECT_ID` = `test-6b2ab`
   - `FIREBASE_CLIENT_EMAIL`: the live service account's `client_email`
   - `FIREBASE_PRIVATE_KEY`: its `private_key`, pasted with its `\n` sequences
   - `ANTHROPIC_API_KEY`
   - `COACH_EMAIL` (optional, defaults to lucas@jadin-jones.com)
3. Rotate the Granola secret:
   1. Copy the current `GRANOLA_SECRET` value into a new `GRANOLA_SECRET_OLD`.
   2. Set `GRANOLA_SECRET` to a new long random value.
   3. Put the new value in the Zapier/Make step that posts to `/api/granola`.
   4. After the next note lands, the function log no longer says "sent with
      GRANOLA_SECRET_OLD". Then delete `GRANOLA_SECRET_OLD`.
   - **Success:** all variables are present for the Production context.

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
