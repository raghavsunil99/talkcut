# Editor layout: Talkcut against Descript

Task 2.10 in `PLAN.md`. This is the audit that comes before any restyling: what a Descript user
would find different in Talkcut's editor, and what I propose to change. Nothing here is built
yet. Approve, change or strike each numbered item; only approved items get built.

**Scope.** This matches Descript's layout and interaction patterns only. Talkcut keeps its own
name, colours, icons and artwork, and nothing is copied from Descript's screens pixel for pixel.

**How this was made.** From Talkcut's code (`index.html`, `app.js`, `workspace.js`,
`appearance.js`, `transcript-*.js`, `timeline.js`) and screenshots of the editor at 1440×900
in all four workspaces. Descript's behaviour is from my knowledge of it, not from running it
here; where your Descript differs, your version wins.

## What already matches

The skeleton is the same, so this is a list of behaviours, not a redraw.

- Script on the left, video in the middle, a side panel with an icon rail on the right, timeline below.
- Editing the script edits the video: delete words to cut them; cut words leave a small marker.
- Correct text without cutting (Enter or double-click), find and replace, speaker labels with names.
- Remove fillers, retakes and pauses, now with a review list (2.5).
- Cut and paste to move words, and drag a selection to move it (2.3).
- Captions, media, Studio Sound, export presets; workspaces on ⌘1–⌘4.

## What differs, and what I propose

Sizes: S is up to half a day, M is a day or two.

### The script

1. **The script is not the main surface** (M). In the Studio workspace the script takes 38% of
   the width and the video the middle; Descript's script column is wider and reads like a
   document. *Proposal:* Studio gives the script about half the width, with a readable line
   length (about 70 characters), and the video takes the rest. Video first and Reels stay as
   they are.
2. **Speaker names sit above each paragraph** (S). Descript puts them in a left gutter, so the
   text column stays clean and every paragraph is easy to attribute. *Proposal:* a gutter of
   about 90 px with the name beside the first line of each paragraph; clicking it opens the same
   speaker menu as now.
3. **No toolbar on a text selection** (M). Today the actions are a row of small buttons under the
   title (Cut, Restore, Correct, Find & replace, Speakers) and a right-click menu. Descript shows
   a small floating bar above a selection. *Proposal:* a floating bar above the selection with
   Cut, Correct, Restore (when cut words are selected), Speaker, Add B-roll here, and Move (which
   starts the ⌘X / ⌘V flow). The row under the title goes; the right-click menu stays.
   ("Make clip" is in the plan's list but 2.6 was skipped, so it is left out.)
4. **Cut words show only a ⌁ marker** (S). Descript can show deleted text struck through, which
   helps you see what you removed. *Proposal:* a toggle in the View menu, "Show cut words",
   that draws them struck through and dimmed instead of the marker. Off by default.
5. **Time is not visible in the script** (S). *Proposal:* a faint timestamp in the gutter at
   the start of each paragraph (edited time), clickable to seek.

### Scenes

6. **No scenes** (M). Descript splits a script into scenes and shows them as a strip of
   thumbnails. 2.3 gave Talkcut the model this needs (pieces in play order). *Proposal:* type
   `/` on its own line (or use the selection bar) to start a scene; a narrow rail on the left of
   the script shows a thumbnail per scene; clicking one scrolls the script and seeks there;
   dragging one reorders the scenes (using 2.3's move). Scenes are labels and order only, not
   separate layouts; Descript's per-scene layouts are out of scope.

### Finding commands

7. **No command palette** (S). *Proposal:* ⌘K opens a search box over every menu command
   (Export, Remove fillers, Studio Sound, workspaces, Add recording to end and so on), with
   their shortcuts shown. Built from the existing menu commands, so it stays in step.

### Timeline

8. **The timeline is always open** unless hidden from the toolbar or a workspace (S). Descript
   collapses it to a thin bar you pull up. *Proposal:* a handle on the timeline's top edge;
   click to collapse to the transport bar (play, time, zoom), click or drag to open; ⌥⌘T (the
   shortcut the resize handle already names) toggles it.

### Side panel

9. **The rail order and grouping** (S). Today: AI tools, Properties, Captions, Elements, Media.
   *Proposal:* Project (the project's settings: name, language, canvas size, loudness),
   Properties (whatever is selected: the clip, a track item, a caption), Captions, Media
   (including text and titles, today's Elements), AI tools. Properties follows the selection,
   as it does now for track items.
10. **The side panel forgets where you were** (S). When it comes back (switching from Script
    first back to Studio, or the toolbar toggle), it always opens on Properties, not on the panel
    you last used. *Proposal:* it reopens the last panel.

### Top bar

11. **The toolbar mixes app and project actions** (S). New, Open, the language and quality
    pickers (hidden), three layout toggles, Settings, API keys and Export sit in one row.
    *Proposal:* left: home and the project name (click to rename); centre: undo and redo;
    right: the layout toggles, a share-style Export button. New, Open, Settings and API keys
    move to the File and Talkcut menus and the ⌘K palette (they stay on the Home screen).
12. **The Original / Edited / Cuts boxes under the video** take vertical space from the video
    (S). *Proposal:* fold them into one line under the video ("7.6 s of 8.0 s · 2 cuts"), with
    the details on hover.

### Small things the screenshots showed

13. The "Studio workspace" toast sits over the stats boxes and the transport; toasts should
    sit above the timeline, clear of the video and the controls (S).
14. The undo and redo arrows are faint even when enabled (S).

## Workspaces

All four stay, adjusted to the changes above: **Studio** (the new script-first layout of item
1), **Video first** (unchanged), **Script first** (the script with the scene rail, the video
small, the side panel closed), **Reels** (unchanged, safe zones on). None is removed.

## Not proposed

Descript's AI assistant, its per-scene layouts and templates, the recorder, collaboration and
comments, and its look (colours, icons, artwork). Android is out of scope.

## Acceptance (from the plan)

Once approved items are built: a Descript user can cut a sentence, add B-roll and export
without using the menu bar, and the four workspaces still work or were changed on purpose
(as listed above). Each built item gets an end-to-end test.

## Suggested order if you approve everything

First 13, 14, 10, 12 and 8 (small fixes that help at once), then 1, 2, 5 and 3 (the script),
then 7, 9 and 11 (finding things), then 4 and 6 (scenes last, as the largest). Roughly four to
five days of work in all.
