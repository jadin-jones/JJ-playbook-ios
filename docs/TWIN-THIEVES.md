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
- `node test/isolation/run.js`: 30 checks, no network.
- `npm --prefix test/rules install && npm --prefix test/rules test`: 72 rules
  cases, the Playbook's 46 unchanged plus 26 Twin Thieves ones.

## Codes

`org:TT36.joinCode` and `org:TT10.joinCode` (defaults `TWINTHIEVES36` and
`TWINTHIEVES10`) are set in Studio → Twin Thieves → Codes:
- **Set up this program** creates the record.
- **Rotate** suggests a new code.
- **Switch code off** stops new joins.
- **Email-domain limit** accepts only one domain.

Codes are compared without regard to case. There is no approved-email list.
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

## Design preview

`?ttpreview=home`, `?ttpreview=lesson` and `?ttpreview=studio` show sample
content with no sign-in and save nothing. They work only on localhost, a
Codespace (`*.app.github.dev`) or `jj-twinthieves-preview.netlify.app`.

## Preview site: waiting for approval (not applied)

The branch deploys to **jj-twinthieves-preview.netlify.app** on the Dev
Firebase project (jj-playbook-dev).

**Important:** the app chooses its Firebase project by host ("dev" in the
hostname means Dev), and `jj-twinthieves-preview` does not contain "dev". Until
the code change below is applied, that site would talk to the **live**
project, test-6b2ab. Apply it before the site builds this branch.

### 1. Code (`docs/twin-thieves-preview-hosts.patch`, one commit)

```
git apply docs/twin-thieves-preview-hosts.patch
```
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
