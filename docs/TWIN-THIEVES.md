# Twin Thieves Leadership

A second product in the same app, on the branch `feature/twin-thieves`
(never `develop` or `main`). It is solo: members never see each other.

## How it is kept apart from the Playbook

| | Playbook | Twin Thieves |
|---|---|---|
| Program record | `org:CODE`, no `product` field | `org:TT36` / `org:TT10`, `product:'tt'`, `ttVersion` 36 or 10 |
| Membership (what the rules check) | `members/{email}.orgs` | `ttmembers/{email}.orgs`. A Twin Thieves-only member has no `members` document, so none of the Playbook's rules apply to them. |
| Member record | `resp:CODE:idkey` | `ttm:TT36:idkey`: name, email, idkey, code, joinedAt, progress. Owner-only. |
| Content | `program:master…` | `ttlib:master`: every lesson once, plus `order36` and `order10` |
| Join | `/api/join` (refuses `product:'tt'`) | `/api/tt-join`, with the program's own code |
| Push, reminders, chat, feeds | yes | none. The app never registers push for a Twin Thieves program, and the Firebase Functions never read `ttm:` or `ttmembers`. |
| Studio | Championship Playbook view (`orgList` excludes Twin Thieves) | Twin Thieves Leadership view (its own data) |

Checks:
- `node test/isolation/run.js`: 61 checks, no network.
- `npm --prefix test/rules install && npm --prefix test/rules test`: 86 rules
  cases, the Playbook's 46 unchanged plus 40 Twin Thieves ones.

## Codes

`org:TT36.joinCode` and `org:TT10.joinCode` (defaults `TWINTHIEVES36` and
`TWINTHIEVES10`) are set in Studio → Twin Thieves → Codes:
- **Set up this program** creates the record.
- **Rotate** suggests a new code.
- **Switch code off** stops new joins.
- **Email-domain limit** accepts only one domain.
- **Approved emails** (one per line, then **Save list**): when the list is
  not empty, `/api/tt-join` accepts a code join only for a listed email.
  Anyone else sees "Your email isn't on the list for this program. Ask the
  Jadin | Jones Team to add you." An empty list lets anyone with the code
  join. Invite links don't check the list. The join code printed in an
  invite email does check it, so an invited address that isn't on the list
  can join only through the link.

Codes are compared without regard to case. The approved list is stored in
`ttallow:TT36` / `ttallow:TT10` (`{ emails, updatedAt }`), apart from the
program record, because every member of a program can read `org:TTxx`.
Only admins can read `ttallow:` or write to it: the rules give members
nothing under that prefix, so `firestore.rules` did not change. A damaged
list fails closed: every code join is refused, and Studio won't save over
the list until it can read it.
`/api/tt-join` allows 20 tries an hour per account and 60 an hour per
connection. A rev: tombstone (Studio → Members → Remove) ends access.

## Videos

A lesson's video URL may be YouTube, Vimeo, Google Drive or a direct MP4
(or another video file).
- YouTube and Vimeo play embedded, and chapters jump to their time.
- A direct file plays in a `<video>`, and chapters jump too.
- Google Drive shows in its preview frame, and chapters cannot jump.

## Privacy (members may be under 18)

Kept: name, email and which lessons are complete, with the time. Nothing
else: no location, photo, answers, chat, notifications or other people's
data. Decisions for the owner are in the summary that came with this build.

## Invites (Studio → Twin Thieves → Members → Invite)

An admin pastes addresses (one per line), picks the 36- or 10-lesson
version and sends. Each person gets an email from **"Jadin | Jones Team"
<charlie@jadin-jones.com>** with a Join now link and the join code as a
backup.
- The link works once, only for that address, and for 7 days.
- Resend makes a fresh link, and the old one stops working.
- Cancel invite stops the link.
- Members shows each person's status: Invited (with the date), Joined,
  Expired or Cancelled.

- **Wording:** `netlify/lib/invite-products.js`. The subject, lines, button and
  sign-off live there with `{product}`, `{lessonCount}`, `{email}`, `{date}`,
  `{site}` and `{CODE}` placeholders, and editing them needs no code change.
  Another product (the Playbook, later) is another entry in the same file.
- **Stored:** `ttinv:<program>:<hash of the email>`, holding the email and
  invite status (status, sent, expires, joined, delivery, send count) plus the
  hash of the link's secret. Admins only: no member can read it.
- **Server:** `/api/tt-invite`, admins only (not through Microsoft), with 30
  calls an hour per connection and 200 invite emails an hour per admin.
  `/api/tt-join` accepts the link.

**Sending** follows `INVITE_SEND_MODE` on the Netlify site, and anything
else counts as `off`:

| Value | What happens |
|---|---|
| `off` (or unset) | nothing is sent; the invite is recorded, and Studio says "Recorded, not sent" |
| `test` | only addresses in `INVITE_TEST_RECIPIENTS` (comma-separated) get an email; others are refused |
| `on` | everyone gets an email. Live only, and only when the owner says so |

**Setup before any email goes out:**
1. charlie@jadin-jones.com: 2-Step Verification on, then create an app
   password named "Twin Thieves invites" (the Workspace admin must allow app
   passwords).
2. Netlify env on the site:
   - `INVITE_SMTP_URL` = `smtps://charlie%40jadin-jones.com:APP_PASSWORD@smtp.gmail.com:465`
   - `INVITE_SEND_MODE` = `test`
   - `INVITE_TEST_RECIPIENTS` = your own addresses
3. **DKIM for jadin-jones.com**, which none of its DNS records have yet: Google Admin
   → Apps → Google Workspace → Gmail → Authenticate email → Generate new
   record, add that TXT record at GoDaddy, then Start authentication. SPF
   already allows Google (`_spf.google.com`), and DMARC is `p=none`.
4. The invite function uses nodemailer 10, which needs Node 20 or later for the
   Netlify functions. If a send fails with a Node version error, set
   `AWS_LAMBDA_JS_RUNTIME` = `nodejs20.x` on the site.

## Design preview

`?ttpreview=home`, `?ttpreview=lesson` and `?ttpreview=studio` show sample
content with no sign-in and save nothing. They work only on localhost, a
Codespace (`*.app.github.dev`) or `jj-twinthieves-preview.netlify.app`.

## Signing in and My groups

- On the Twin Thieves hosts (`TT_HOSTS`: the preview site and
  twinthieves.jadin-jones.com), the sign-in heading says "Sign in to
  Jadin | Jones". Every other host keeps "Sign in to your playbook".
- My groups lists Playbook programs first, then Twin Thieves programs under
  their own heading. Tapping a Twin Thieves program opens Twin Thieves.
  `myPrograms` reads a Twin Thieves program's `ttm:` record and never its
  `resp:` record. The rules refuse a `resp:TTxx` read, and before this fix
  that refusal dropped the program from the list.

## Live site: twinthieves.jadin-jones.com

This host uses the **live** project, test-6b2ab. It has no "dev" in its
name, so it gets the live Firebase config and VAPID key without any special
case. The code also adds it to `AUTH_OWN_HOSTS`, `MS_SIGNIN_HOSTS` and
the live CORS list (`SITE_HOSTS['test-6b2ab']` in `netlify/lib/http.js`).

Before it works, the owner must set up these (live project only, and only
when they choose to):
- Firebase → test-6b2ab → Authentication → Authorized domains:
  `twinthieves.jadin-jones.com`.
- Google Cloud → test-6b2ab → the OAuth web client: JavaScript origin
  `https://twinthieves.jadin-jones.com` and redirect URI
  `https://twinthieves.jadin-jones.com/__/auth/handler`.
- The live Microsoft (Entra) app: redirect URI
  `https://twinthieves.jadin-jones.com/__/auth/handler`.
- The Netlify site that serves the host: the live service account's env
  (`FIREBASE_PROJECT_ID` = `test-6b2ab`), a DNS record for the subdomain,
  and `URL` for invite links.
- The Twin Thieves rules section published on test-6b2ab.

## Preview site

The branch deploys to **jj-twinthieves-preview.netlify.app** on the Dev
Firebase project (jj-playbook-dev).

The app chooses its Firebase project by host ("dev" in the hostname means
Dev), and `jj-twinthieves-preview` does not contain "dev". Commit `2cabb6c`
(from `docs/twin-thieves-preview-hosts.patch`) adds the preview host to the
Dev side, so it uses jj-playbook-dev.

### 1. Code (applied in `2cabb6c`)
- The Dev project and Dev VAPID key on the preview host (`DEV_HOST`).
- The preview host in `AUTH_OWN_HOSTS`, so sign-in hands off through its
  own `/__/auth`.
- The preview host in `MS_SIGNIN_HOSTS`, so the Microsoft button shows there.
- The preview host in the Dev site's CORS list (`netlify/lib/http.js`,
  `SITE_HOSTS['jj-playbook-dev']`).

### 2. Consoles (jj-playbook-dev only)

- Firebase → Authentication → Settings → Authorized domains: add
  `jj-twinthieves-preview.netlify.app`.
- Google Cloud → jj-playbook-dev → Credentials → the OAuth web client:
  - JavaScript origin: `https://jj-twinthieves-preview.netlify.app`
  - Redirect URI: `https://jj-twinthieves-preview.netlify.app/__/auth/handler`
- Azure → the Dev Entra app → Authentication → redirect URI:
  `https://jj-twinthieves-preview.netlify.app/__/auth/handler`.
- Firestore rules on Dev: publish `firestore.rules` from this branch (the
  Twin Thieves section is added at the end; nothing above it changes).

### 3. The Netlify site

- Link it to this repo and build from branch **`feature/twin-thieves`**, with
  base `/`, publish `public` and functions `netlify/functions`
  (`netlify.toml` sets the last two).
- Environment variables:

  | Variable | Value |
  |---|---|
  | `FIREBASE_PROJECT_ID` | `jj-playbook-dev` |
  | `FIREBASE_CLIENT_EMAIL` | the Dev service account |
  | `FIREBASE_PRIVATE_KEY` | the Dev service account's key |
  | `SECRETS_SCAN_SMART_DETECTION_OMIT_VALUES` | both web keys, as on the other sites |
  | `ANTHROPIC_API_KEY` | optional; only the Playbook's coach uses it |

- Then: in Studio → Twin Thieves → Codes, **Set up this program** for both
  versions, and in Versions pick the 10 lessons.
