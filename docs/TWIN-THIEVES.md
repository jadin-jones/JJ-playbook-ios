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
- `node test/isolation/run.js`: 63 checks, no network.
- `npm --prefix test/rules install && npm --prefix test/rules test`: 90 rules
  cases (the Playbook's 50 plus 40 Twin Thieves ones), then the 54 cases in
  `live.test.js` that were checked before the rules went live.

## Codes

`org:TT36.joinCode` and `org:TT10.joinCode` (defaults `TWIN36` and
`TWIN10`) are set in Studio → Twin Thieves → Codes:
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

## Lessons (October 2026 updates)

- **One library, two versions.** `ttlib:master` holds every lesson once
  (video, thumbnail, questions, handouts), plus `order36` and `order10`. A
  version can show its own name for a lesson: Studio → Twin Thieves →
  Versions, saved as `names['36'|'10'][lessonId]`. Empty means the library
  name. Progress is kept by lesson id, so a name never resets it.
- **Thumbnails.** Studio → a lesson → Video thumbnail: a link, or Upload a
  thumbnail (JPG or PNG; anything over 1920 px or 600 KB is redrawn as a
  1920 px JPEG first). The upload uses the Playbook's `uploadMedia()` and its
  Storage folder `session-thumbnails/`. Saved as the lesson's `thumbUrl` and
  shown as the video's cover; with none, the usual navy cover stays.
- **Thank you lesson.** It can have a video and thumbnail like any lesson. It
  shows no "In the book" or "Where this fits" row and is never flagged for a
  book chapter.
- **Transcripts** are no longer shown or edited. Saved transcripts stay in
  the library.
- **"← All lessons"** sits at the top and the bottom of every lesson and
  returns to the pyramid page.
- **Phone menu.** The lesson drawer respects the phone's safe areas. Under
  900 px (phones and iPad in portrait) its rows share the height between the
  Playbook item and My Profile; a long list keeps its spacing and scrolls.

## Import lesson content (Studio → Twin Thieves → Lessons)

- **Import lesson content** (admins only) reads a JSON list of 36 entries
  (`lesson, fundamental, title, concept, story, summary, discussion[],
  additional[]`) in the browser. Entry N goes to lesson N of the 36-lesson
  order, by position, never by title.
- A preview lists each lesson's platform name next to the file's title, with
  the summary and questions it will set. Pairs whose names share too few
  words, or whose fundamentals differ, are marked to check. A lesson listed
  twice, or a number past 36, blocks the import.
- **Confirm** reads the library as saved, stops if the order changed since
  the preview, keeps the values it replaces in `ttlib:import-undo` (admins
  only), then saves. Only the summary, discussion and additional questions
  change, and only those the file has. **Undo last import** puts them back.
- The file itself is never in the repo (`scripts/out/` is ignored).

## Link videos from Storage (Studio → Twin Thieves → Lessons)

- The videos are in two top-level folders of the live bucket
  (`test-6b2ab.firebasestorage.app`): **36 Lesson Video Folder** and **10
  Lessons Video**. Together they hold the 36 lessons. The **Storage folders**
  field at the top of the tool (one per line, exact names with spaces) starts
  with the folders of the last Confirm, or those two. Change it there to use
  other folders; no deploy is needed.
- **Link videos from Storage** (admins only) sends those folders to
  `/api/tt-videos` (`netlify/functions/tt-videos.js`), because Storage rules
  do not let the browser list folders.
  - The function checks the caller's ID token and requires an admin (never
    through Microsoft).
  - It lists only this project's own bucket.
  - It allows up to 4 top-level folders whose names are Twin Thieves ones
    (Twin Thieves, `TT…`, or Lesson(s) Video).
  - It always refuses the folders the Playbook uploads to (`session-videos`,
    `session-thumbnails`, `challenge-videos`, `welcome-videos`, `learn-more`,
    `knowledge`), nested or odd paths, and any other bucket.
  - It returns each file's folder, name, path, size, content type and
    download link, read-only. The link is built from the download token
    Storage already keeps on the file, in the same form `getDownloadURL()`
    gives the app's own uploads. A file with no token gets no link: it is
    shown but not linked, and nothing in Storage is changed.
- The 36- and 10-lesson versions share one library, so each lesson gets one
  video from either folder. If a lesson matches a file in both folders,
  neither is chosen: the row lists both and says "choose one", and the lesson
  is not linked until one is picked from the dropdown.
- Each video (MP4, M4V, MOV, WebM) shows its size and length and is matched to
  a lesson by file name vs. lesson name (library title or either version's
  name), one file per lesson, over the 36-lesson order plus the Thank you
  lesson: `Be_the_Buffalo.mp4` → Be the Buffalo. Leading numbering and a
  "Twin Thieves" prefix are ignored. Any match can be changed from a dropdown.
- Marked to check: over 20 MB per minute ("re-export before linking"), `.mov`
  files, and near (not exact) name matches. Lessons with no file say "No video
  found yet"; files that matched nothing are listed.
- Safe to run again: a lesson that has a video is skipped unless **Replace
  existing videos** is ticked (and still claims its file, so the file never
  goes to a similarly named lesson).
- Every lesson that gets a video also gets the challenge thumbnail, unless it
  has its own and **Replace existing thumbnails** is not ticked. On the first
  Confirm the image is downloaded once from HubSpot, redrawn as a JPEG (at most
  1920 px) and uploaded to `session-thumbnails/`; later runs reuse that copy.
- **Confirm** reads the library as saved, stops if anything in the preview
  changed, keeps the replaced videos and thumbnails in `ttlib:video-undo`
  (admins only), then saves `ttlib:master`. Only `videoUrl` and `thumbUrl`
  change. **Undo last video link** puts them back where they are still what
  the link set.

## Studio text boxes keep their spaces

The per-version lesson name (Versions) used to be trimmed on every key, so
a space vanished as it was typed. Names, video and thumbnail links, handout
links and chapter times now keep what is typed; the ends are trimmed on
save.

## Pyramid page and lessons by fundamental (October 2026)

- **Home is the pyramid.** After sign-in a member lands on Playbook Overview:
  the Playbook home pyramid's blocks, icons and level labels (`ttPyramidVM`
  wraps `pyramidVM` in its display-only form, which is unchanged), all open,
  with no assessment ring. "Playbook" is the first item in the sidebar and
  the phone menu.
- **Lessons by fundamental.** The sidebar and the phone menu list the
  version's lessons under fundamental headings in program order (Overview,
  Energy, … Starfish Moments), each heading with its done/total count, and
  Thank you! last on its own (`ttGroups`). A fundamental with no lessons in
  the version has no heading. The list still fills the height down to My
  Profile; a long one scrolls.
- **A block picks its fundamental** (`ttFocus`). Desktop and iPad in
  landscape: the page stays, and that group lights up in the sidebar and
  scrolls into view. Phones: the menu opens on that group. A block with no
  lessons in the version is dimmed and says "No lessons in this section yet."
- **Playbook programs are untouched.** Everything is behind `isTT()`; the
  checks in `test/isolation/run.js` compare the Playbook's own pieces with
  `d5c35ad`.

## Notifications: none for Twin Thieves

- Someone in Twin Thieves only never gets the "Turn on notifications"
  prompt. Twin Thieves' My profile has no notification switch. Someone also
  in a Playbook program keeps the prompt as before.
- The app never writes a `push:` record for TT36/TT10. The iOS app's token
  save is skipped in a Twin Thieves program.
- Every Firebase Functions sender skips `push:` records under TT36/TT10, by
  key or by the program code stored in them (`isTTPush` in
  `functions/index.js`). This needs a Functions deploy.
- `scripts/tt-inventory.js` counts any such records, and those of Twin
  Thieves-only members (read-only; nothing is deleted).

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

**Mail** goes through `netlify/lib/mailer.js`, the same Workspace mailbox as
the Microsoft code email: `SMTP_USER`, `SMTP_PASS` and `MAIL_FROM`, already
set on jj-playbook-dev and jjplaybook. An invite shows "Jadin | Jones Team"
with that mailbox's address (noreply@jadin-jones.com), and replies go to
charlie@jadin-jones.com (`fromEmail` in `invite-products.js`). To send from
charlie@ itself, add it as a Gmail "Send mail as" alias on the mailbox
first, otherwise Gmail rewrites the address.

**Setup before any email goes out:**
1. Netlify env on the site:
   - `INVITE_SEND_MODE` = `test`
   - `INVITE_TEST_RECIPIENTS` = your own addresses
2. **DKIM for jadin-jones.com**, which none of its DNS records have yet: Google Admin
   → Apps → Google Workspace → Gmail → Authenticate email → Generate new
   record, add that TXT record at GoDaddy, then Start authentication. SPF
   already allows Google (`_spf.google.com`), and DMARC is `p=none`.

## Design preview

`?ttpreview=home`, `?ttpreview=lesson` and `?ttpreview=studio` show sample
content with no sign-in and save nothing. They work only on localhost, a
Codespace (`*.app.github.dev`) or `jj-twinthieves-preview.netlify.app`.

## Signing in and My groups

- The sign-in heading is "Sign in to Jadin | Jones" on every host. One
  site serves both products, and the code entered picks the program.
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
- The Twin Thieves rules section published on test-6b2ab: done 8 Oct 2026,
  together with V3 (`firestore.rules`; see docs/GO-LIVE-LOG.md).

## Preview site

The branch deploys to **jj-twinthieves-preview.netlify.app** on the Dev
Firebase project (jj-playbook-dev).

The app chooses its Firebase project by host ("dev" in the hostname means
Dev), and `jj-twinthieves-preview` does not contain "dev". Commit `2cabb6c`
adds the preview host to the
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
- Firestore rules on Dev: publish `firestore.rules` (the same text as live:
  main's V3 with two changes, plus the Twin Thieves section at the end).

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
