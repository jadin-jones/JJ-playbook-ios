# Known issues (Studio)

Found on 25 Sept 2026 while researching Twin Thieves. Neither is fixed:
`develop` is frozen for the Playbook launch. Both are in `public/index.html`
on `develop` as well as on this branch.

## 1. Studio's per-program Content tab and Discard call functions that don't exist

**What breaks**

`setContentOrg()` and `pickEdition()` are called, but neither is defined
anywhere in the app. Each call throws `TypeError: this.setContentOrg is not a
function` (or `pickEdition`).

| Where | What the admin does | What happens |
|---|---|---|
| Studio → an organization → **Content** sub-tab (`goTab`, around line 21377) | Opens the program's own Content tab | The tab switches, then the call throws. The program's own overrides are never loaded, so the tab shows the master content rather than that program's changes, and there is no error message. |
| Content → **Discard**, with a program selected (`A.onDiscard`, around line 22811) | Confirms "Discard every unpublished change?" | The unsaved draft for that program is cleared from the screen first, then the reload throws. No "discarded" toast appears. The saved override in Firestore is untouched. |
| Content → **Discard**, on the master program (around line 22817) | Confirms the same prompt | The call throws and nothing is discarded. The unpublished master draft stays on screen, and no toast appears. |

**Who would see it:** admins only, in Studio. Members never reach this code.

**Risk:** an admin who opens a program's Content tab sees the master content
there. If they then save it as "Save for CODE only", they could write an
override built from the wrong starting point. Nothing is lost silently: what
is already published, and what is already saved per program, is unchanged
until someone saves.

**Workaround until fixed:**
- Edit master content from **Master program**, which uses the edition tabs and
  works.
- To throw away unsaved edits, reload the page instead of using Discard.
- Avoid the per-program Content sub-tab.

**Fix (after launch):** make those calls use what does exist, `loadOverride(code)`
for a program and `switchEdition(id)` for the master, or define the two
functions. Then test Content, Discard for a program and Discard for the master
in Studio on Dev.

## 2. An auto-generated program code can contain the word "undefined"

**What breaks**

In `createOrg()` (around line 15793), when the admin leaves the code blank,
Studio makes one: three letters, then three digits. The letter list is
`'ABCDEFGHJKLMNPQRSTUVWXYZ'`, which is 24 letters (no I or O), but it is indexed
with `Math.random()*26`. So each letter has a 2-in-26 chance of coming out as
`undefined`, and about 1 in 5 generated codes (21%) contains it, for example
`AundefinedB472`.

The program is saved under that key (`org:AundefinedB472`). But every join
path upper-cases and trims the typed code (`cleanCode`: `AUNDEFINEDB4`), which
never matches, so **nobody can join that program.**

**Who would see it:** the admin creating the program, and then every member
given that code. They would see "No program found" when they try to join.

**Workaround until fixed:** always type a code when creating a program, or
check the generated code before sharing it. If one already contains
"undefined", create the program again with a typed code.

**Fix (after launch):** index with `L.length` (and `D.length` for the digits)
instead of the fixed 26 and 8.

## Does either affect the live launch?

**No.** Neither blocks it.
- The launch uses existing programs, such as PLAYBOOK26, and existing codes.
  Neither bug touches members, sign-in, joining an existing program, lessons,
  notifications or the rules.
- Issue 1 only bites an admin who uses the per-program Content tab or Discard
  in Studio.
- Issue 2 only bites an admin who creates a new program and leaves its code
  blank.

Both have simple workarounds for launch day: edit through Master program,
reload instead of Discard, and always type a code for a new program. Fix
both on `develop` after launch.
