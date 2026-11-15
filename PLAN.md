# Talkcut improvement plan

Written 2026-11-15 against `main` at `310abe3` (v1.0.3). Planning only: no source file was changed.

Revised the same day after your answers: **the plan now covers the Mac app only**, and Sarvam is built from scratch. Windows and Android code stays in the repo but no task maintains or tests it.

## Summary

1. **State:** a working v1.0.3. This plan covers the Mac app only. One source video per project, cuts-only editing, six caption styles, overlay and audio tracks, ffmpeg export.
2. **Tests:** `npm test` gives 107 pass, 0 fail, 1 skipped (the whisper end-to-end test, because whisper.cpp is not built on this machine). Before `npm ci`, four test files fail on the missing `ffmpeg-static`.
3. **Architecture is sound at the core:** `edits.js`, `tracks.js`, `frame.js`, `captions.js` and `render-plan.js` are pure, shared by preview, desktop export and Android export, and tested.
4. **Priority 1:** a safety net (CI plus an end-to-end smoke test), then split `src/renderer/app.js` (3,031 lines, untested).
5. **Priority 2:** harden export: frame rate is forced to 30 fps, cuts have no audio fade, nothing can be cancelled, and heavy-cut long videos are unmeasured.
6. **Priority 3:** build Sarvam transcription from scratch. The repo has only whisper.cpp and ElevenLabs today.
7. **Priority 4:** a rearrangeable edit model (move and paste sentences, more than one clip). This is the largest Descript behaviour Talkcut cannot represent today.
8. **Priority 5:** caption styles v2 (custom font, colours, word animation) on bundled fonts.
9. **Biggest risk:** the `app.js` split and the edit-model change both rewrite UI code that has no tests. The end-to-end test (1.3) has to land first.
10. **Differentiator:** code-mixed captions (per-word fonts, native or romanised script, translated subtitles) on bundled Indic fonts. Descript has no answer there.

## How I read the code

- Read in full: `README.md`, `package.json`, `src/main.js`, `media.js`, `transcribe.js`, `cloud.js`, `keystore.js`, `projects.js`, `preload.js`, `stock.js`, `renderer/edits.js`, `render-plan.js`, `tracks.js`, `captions.js`, `frame.js`, `speakers.js`, `mobile/bridge.js`, `mobile/touch.js`, all of `scripts/`, `build/afterPack.js`, `capacitor.config.json`, `AndroidManifest.xml`.
- Read in part: `app.js` (state, rendering, edits, playback, file flows, project save and open, export: about 55%; the rest by function outline only), `timeline.js` (outline), `text.js` (first 60 lines), `index.html` (CSP and script list), `android/app/build.gradle`.
- Not read: `canvas.js`, `crop.js`, `panels.js`, `properties.js`, `home.js` (except the trash handler), `appearance.js`, `styles.css`, `mobile.css`, `build/installer.nsh`, and the test files line by line (I ran them and counted them).
- Findings below about the unread files are marked as such.

## Architecture as it is

### Data model

| Thing | Where | Shape |
|---|---|---|
| Transcript | `state.words` in `app.js` | `[{ text, start, end, speaker? }]`, times in source seconds |
| Word cuts | `state.deleted` | `Set` of word indices |
| Shortened pauses | `state.cutGaps` | `Set` of gap keys (index of the word before; `-1` is the lead-in) |
| Exact time cuts | `state.rangeCuts`, `state.splits` | `[[start, end]]` and blade points, source seconds |
| Tracks | `state.tracks` (`tracks.js`) | overlay and audio tracks; each item is anchored to a **source** time, with a length in **edited** seconds |
| Frame and sound | `state.clip` (`frame.js`) | speed, volume, Studio Sound, canvas, scale, position, rotation, crop, background |
| Captions | `state.captions` (`captions.js`) | preset, size, position, custom x/y/scale |
| Project file | `projects.js`, `buildProject()` | `.talkcut` JSON, version 2, media referenced by absolute path |

Undo is a stack of whole-state snapshots (`snapshot()` / `commit()` in `app.js`, 500 deep).

### From edits to a render

1. `Edits.computeCuts()` merges word runs, shortened pauses and range cuts into sorted cut ranges.
2. `Edits.keptRanges()` inverts them into kept ranges. `toEdited()` and `toSource()` map between the two timelines.
3. `Tracks.forExport()` places overlays and sounds on the edited timeline.
4. `Captions.buildAss()` and `Text.buildAss()` write ASS subtitle files on the edited timeline.
5. `RenderPlan.buildRenderArgs()` builds one `filter_complex`: a `trim` and `atrim` pair per kept range, `concat`, crop/rotate/scale/blur background, overlays, two `ass` passes, speed, then the audio mix with sidechain ducking.
6. Desktop runs it with native ffmpeg (`media.js renderEdit`). Android runs the same arguments in `ffmpeg.wasm` (`bridge.js exportMedia`).

The model is **cuts-only on one source file**. Kept ranges are always in source order, so moving a sentence or adding a second recording cannot be expressed.

### Desktop and Android

Out of scope after the revision; kept as a record of what was found.

| Area | Desktop (`main.js`) | Android (`bridge.js`) |
|---|---|---|
| Transcription | whisper.cpp (Fast, Accurate) and ElevenLabs | ElevenLabs only |
| Upload to ElevenLabs | 16 kHz mono AAC at 48k (`encodeForUpload`) | the whole original video file |
| Key out of credits | `QUOTA:` protocol, offers the next key | plain error, no failover |
| API keys | encrypted with `safeStorage` | plain text in `localStorage`, with `allowBackup="true"` |
| Export | native ffmpeg, CRF 18 to 19, preset `medium` | `ffmpeg.wasm`, CRF 22 to 23, `ultrafast` |
| Caption fonts | Kohinoor / Sangam (Mac), Nirmala (Windows) | bundled Noto |
| Projects | JSON files plus recent list | IndexedDB, media stored as blobs |
| Speaker names on reopen | **lost** (`openPayload` omits `speakers`) | kept |
| Auto-frame | Mac only (Swift Vision helper) | not available |
| Filmstrip | up to 400 frames from ffmpeg | up to 60 frames by seeking a `<video>` |

## Weak spots

### Bugs I confirmed by reading

- **Speaker names vanish on desktop.** `buildProject()` saves `speakers`, `openProject()` in `app.js` reads `project.speakers`, but `openPayload()` in `main.js` never returns it. `bridge.js` does.
- **Speaker changes are outside undo.** `snapshot()` omits `state.speakers`; `assignSpeaker()` and `clearSpeakers()` change it before `commit()`.
- **Caption setting changes are outside undo.** `onCaptionsChange` sets `state.captions` and `setDirty(true)` without `commit()`.
- **Missing overlay media is not checked on open.** Only the legacy `broll` list is filtered in `openPayload()`. A moved B-roll file in `tracks` surfaces as a raw `ENOENT` from `fs.access(o.path)` at export.
- **Close can lose the last edit.** The `close` handler in `main.js` force-closes after 5 seconds whether or not the autosave finished.
- **A failed transcription throws away the opened video.** `loadMedia()` sets `state.media = null` in its catch, instead of opening without a transcript.
- **Android never frees video storage.** `trashProject` deletes the project record only; the blob in the `media` store stays.

### Export (`render-plan.js`, `media.js`)

- Output is forced to `-r 30`. Sources at 24, 25, 50 or 60 fps are resampled.
- Cuts are hard `atrim` joins with no fade, so cut points can click.
- Two filter chains per kept range. A long video with hundreds of cuts builds a very large graph. **Unmeasured**: I do not know where it becomes slow or fails.
- No cancel: `runFfmpeg()` and `runWhisper()` keep no handle to kill, and there is no cancel IPC.
- Software x264 only; no VideoToolbox option on Mac.
- `probe()` reads ffmpeg's stderr with regular expressions. It returns no frame rate and depends on ffmpeg's log format.

### Android (`mobile/bridge.js`), out of scope

- Whole files in memory at four points: `writeInput()` (input into MEMFS), `ff.readFile(output)`, the `btoa` copy in `shareFile()`, and `decodeAudioData(await file.arrayBuffer())` for the waveform.
- Single-threaded x264 in WebAssembly. Speed on a mid-range phone is **unmeasured**.
- Hand-copied logic that has already drifted: `toWords` (vs `cloud.js`), Pexels search (vs `stock.js`), `EXPORT_PRESETS`, `QUALITY_CRF`, `LANGUAGES`, `ISO3`, key handling (vs `keystore.js`).
- No tests touch `bridge.js`.

### Renderer (`app.js` and friends)

- One 3,031-line closure. `state` is mutated from everywhere, with undeclared fields (`state.loadingMedia`, `state.captionSel`, `state.cropping`).
- `refresh()` recomputes cuts, caption groups, the timeline, both inspectors and every button on any change.
- `renderTranscript()` rebuilds every word span whenever `textVersion` changes, so each cut on a 60-minute video (about 9,000 words) rebuilds the whole document.
- `updatePlayhead()` runs every animation frame during playback: it reads layout, writes styles, and `Tracks.activeAt()` re-places every track item.
- Preview and export are two renderers (DOM and CSS against libass). Nothing tests that a caption wraps the same in both.
- Track items carry their thumbnail as a data URL, so they are written into the project file on every autosave and held in every undo snapshot.

### Language handling

- `FILLERS` in `edits.js` is English only.
- `Captions.groupWords()` counts `w.text.length` (UTF-16 units) against `maxChars`. Indic words with vowel signs and conjuncts count as longer than they look, so Indic captions break earlier than English ones.
- `Text.fontPx()` estimates width at 0.62 em per code point, which is wrong for conjuncts.
- One font per caption, chosen by project language. English words inside a Telugu caption use the Telugu font's Latin letters.
- `prepareFontsDir()` swallows errors (`.catch(() => {})`). A missing system font fails silently.
- The UI is English only; `forPlatform()` rewrites strings with regular expressions.

### Tests and tooling

- 108 tests in 12 files cover the pure modules and the main-process helpers.
- No tests for `app.js`, `timeline.js`, `canvas.js`, `crop.js`, `panels.js`, `properties.js`, `home.js`, `appearance.js`, the IPC handlers in `main.js`, or `bridge.js`.
- `main.js` has `CUTLINE_TEST`, `CUTLINE_TEST_EXPORT` and `CUTLINE_PROJECTS_DIR` hooks for a UI test harness, but no such test is in the repo.
- No CI workflow (`.github` holds issue templates only), no linter, no type checking.
- Mac build is ad-hoc signed and Windows is unsigned, so both show OS warnings. No auto-update.

## Gap analysis against Descript

Checked against descript.com on 2026-11-15 (home and pricing pages) plus what I know of the product.

| Descript feature | Talkcut | Indic Reels creator view |
|---|---|---|
| Delete words to cut video | **Covered** | Core. Works. |
| Correct text without cutting | **Covered** (`replaceWords`, find and replace, word list) | Vital, because Indic transcripts need fixing. |
| Move, copy and paste sentences | **Missing** (model is cuts-only) | High. Reordering a hook to the front is a daily Reels move. |
| Several recordings in one project | **Missing** | Medium. |
| Remove filler words | **Partial** (English list, transcript only) | Whisper drops "um", and Indic fillers are not listed. |
| Remove retakes | **Covered** (`findRetakes`), applied without review | Add a review step. |
| Shorten pauses | **Covered** | Fine. |
| Studio Sound | **Partial** (ffmpeg filters, not a speech model) | Phone-recorded audio needs this most. |
| Scenes and layouts | **Partial** (placement presets for overlays) | Low. |
| Captions | **Partial** (6 fixed presets, word highlight, drag and resize) | No custom font or colour, no word animation. Top priority. |
| Templates, brand kit | **Missing** | Medium. Repeat creators want one look. |
| Auto-reframe to 9:16 | **Partial** (one static position) | Fails when the speaker moves or two people share the frame. |
| Create clips, highlights | **Missing** | High for podcast-style creators. |
| Underlord (AI co-editor) | **Missing** | Medium. Start with narrow tools. |
| Translate and dub | **Missing** | High, and a differentiator across Indian languages. |
| Eye contact, green screen, regenerate, avatars | **Missing** | Low. Expensive, and not what this audience lacks. |
| Recording, remote rooms | **Missing** | Low. Creators shoot on the phone camera. |
| Collaboration, comments, share links | **Missing** | Low for solo creators. Deliberately not planned. |
| Stock media | **Covered** (Pexels) | Fine. |
| Export presets, SRT and VTT | **Covered** | Fine. Add frame-rate passthrough. |
| Mobile editing | Out of scope for now (an Android app exists but this plan does not maintain it) | Revisit after Phase 2. |
| Offline, own keys, no subscription | **Talkcut ahead** | Differentiator. Descript starts at $16 a month. |
| Indic and code-mixed transcription | **Talkcut ahead** (style prompts, ElevenLabs) | Differentiator. Sarvam would extend it. |

Nothing in this plan copies Descript's code, assets, branding or layout.

---

## Roadmap

Sizes: S is up to a day, M is two to four days, L is a week or more of focused agent work with review.

### Phase 1: stabilise

Do these in the order listed. 1.1 to 1.3 are the safety net for 1.4.

#### 1.1 CI and lint
1. **Why:** every later task needs a gate that runs without you.
2. **Files:** new `.github/workflows/test.yml`, `package.json`, new `eslint.config.js`.
3. **Approach:**
   - Run `npm ci` and `npm test` on macOS for every push and pull request.
   - Change the test script to `node --test test/` so new test files are picked up.
   - Add ESLint with `no-undef` and `no-unused-vars` only, and declare the `Cutline*` globals.
4. **Risks:** `media.test.js` needs the ffmpeg binary that `ffmpeg-static` downloads at install.
5. **Accept:** a pull request that breaks `edits.js` shows a red check; `npm run lint` exits 0 on `main`.
6. **Size:** S
7. **Model:** Sonnet 5.5

#### 1.2 Fix the confirmed bugs

**Status: done in the working tree, not committed.** Android storage cleanup was dropped with the Android scope. Checked by new unit tests and by driving the real app for speaker restore and speaker and caption undo. The close handshake, the Locate dialog and the failed-transcription path were reviewed but not run.
1. **Why:** each one loses user work or trust.
2. **Files:** `src/main.js` (`openPayload`, `close` handler), `src/renderer/app.js` (`snapshot`, `restore`, `commit`, `assignSpeaker`, `clearSpeakers`, `onCaptionsChange`, `loadMedia`), `test/projects.test.js`.
3. **Approach:**
   - Return `speakers` from `openPayload()`.
   - Put `speakers` in the undo snapshot and let `commit()` take `captions`.
   - On open, check each track item's file; mark missing ones and offer Locate.
   - Close only after the save resolves; on failure ask before discarding.
   - When transcription fails, keep the project open without a transcript.
4. **Risks:** the close handler must wait for the save without hanging the quit.
5. **Accept:** save a two-speaker project, quit, reopen on Mac: names are there. Rename a speaker then undo: it reverts. Move a B-roll file, reopen: a Locate prompt, not an export error.
6. **Size:** S
7. **Model:** Sonnet 5.5, with Opus 5.5 for the close handler if the first attempt is wrong.

#### 1.3 End-to-end smoke test

**Status: done in the working tree, not committed.** Six Playwright tests in `test/e2e/editor.e2e.js` (`npm run test:e2e`, about 7 s), passing three runs in a row. They found and fixed two existing bugs: ⌘Q with unsaved edits closed the window but left the app running, and a file passed on the command line never opened. Not yet run in CI.
1. **Why:** `app.js` has no tests, and 1.4 rewrites it.
2. **Files:** new `test/e2e/`, `package.json`, `src/main.js` (hooks already exist).
3. **Approach:**
   - Drive the real app with Playwright's Electron support, using `CUTLINE_TEST`, `CUTLINE_PROJECTS_DIR` and `CUTLINE_TEST_EXPORT`.
   - Generate a 6-second fixture video with ffmpeg and a fixture `.talkcut` with known words, so no transcription runs.
   - Script: open project, cut two words, undo, redo, shorten a pause, turn captions on, export, then check the output duration with `probe()`.
   - Add a second script that saves, reopens and compares the project JSON.
4. **Risks:** adds Playwright as a dev dependency. Timing flakiness; wait on state, not on sleeps.
5. **Accept:** `npm run test:e2e` passes three times in a row locally and in CI; deleting the body of `cutSelection()` makes it fail.
6. **Size:** M
7. **Model:** Opus 5.5

#### 1.4 Split `app.js`

**Status: done, committed module by module.** `app.js` went from 131 KB to 29 KB across 18 modules, each with lint and the full test suite green before its commit; the e2e suite grew from 6 to 18 tests to cover the moved code. Deviation from the approach below: leaf modules were moved first and `store.js` was not split out; state, undo and `refresh()` stay in `app.js`, which is now small enough to read. The Android web bundle still assembles; the Android app itself was not run.
1. **Why:** every feature in Phases 2 and 3 lands in this file.
2. **Files:** `src/renderer/app.js`, new files in `src/renderer/`, `index.html` (script list).
3. **Approach:**
   - First extract `store.js`: `state`, `commit`, `snapshot`, `restore`, undo and redo, and derived values (`cuts`, `kept`, `captionSpans`) recomputed only when their inputs change.
   - Then one module per step, in this order: `project-io.js`, `export-dialog.js`, `keys-dialog.js`, `find-replace.js`, `speakers-ui.js`, `item-inspector.js`, `transcript-view.js`, `preview.js`, `playback.js`, `canvas-controller.js`.
   - Keep the existing pattern (IIFE plus a `Cutline*` global, plain script tags), so there is no bundler.
   - Run unit and e2e tests after every extraction; one commit per module.
4. **Risks:** hidden coupling through closure variables (`spans`, `lastCaptionKey`, `layerEls`, `canvasEditor`). The Android build shares these files and may stop working; nothing checks it. Depends on 1.1 and 1.3.
5. **Accept:** `app.js` is under 30 KB; all tests pass; a manual pass of open, cut, caption, B-roll and export behaves as before on Mac.
6. **Size:** L
7. **Model:** **Fable 5.2.** One closure shares about 40 variables across 3,000 lines; the boundaries have to be worked out across the whole file before any cut is safe.

#### 1.5 Export engine hardening

**Status: done except the hardware encoder.** Measured with `scripts/bench-export.js` (Apple silicon, 640x360 source):

| Source | Cuts | Before | After | Drift before | Drift after |
|---|---|---|---|---|---|
| 5 min | 50 | 8.9 s | 7.0 s | +0.43 s | 0 |
| 5 min | 200 | 40.9 s | 8.6 s | +1.17 s | 0 |
| 60 min | 50 | not run | 93 s | | 0 |
| 60 min | 200 | not run | 126 s | | 0 |
| 60 min | 800 | not run | 263 s | | 0 |

- The drift was a real bug: each cut made the video about 7 ms longer than the timeline, so captions and B-roll ran early (about 0.3 s after 50 cuts). Video is now put on a constant frame grid and cut on whole frames; the page, the main process and the recipe all use the same frame-aligned ranges (`Edits.snapRanges`).
- Export time no longer multiplies with the cut count: kept ranges are read in groups of 32, each through its own seek.
- Frame rate follows the source (up to 60, NTSC rates exact). Each side of a cut fades the sound over 5 ms.
- Memory: at 1080p ffmpeg peaked at 0.8 GB with 50 cuts and 1.2 GB with 200 (about 75 MB per extra group). An 800-cut 1080p edit was not run; by that rate it would need roughly 2.7 GB.
- Not done: the `h264_videotoolbox` fast option, and variable-frame-rate phone footage was not tested with a real file (the constant frame grid is meant to handle it).
1. **Why:** export is the product; today it changes frame rate, can click at cuts and is unproven on long edits.
2. **Files:** `src/renderer/render-plan.js`, `src/media.js` (`probe`, `renderEdit`), `src/main.js` (`media:export`), `test/media.test.js`.
3. **Approach:**
   - Benchmark first: 60-minute source with 50, 200 and 800 cuts; record time and memory.
   - Read the source frame rate in `probe()` and pass it through, capped at 60.
   - Add a 5 to 10 ms audio fade on each side of every cut.
   - If the benchmark shows the per-range graph does not scale, switch large edits to `select` and `aselect` expressions or to segment files joined by the concat demuxer.
   - Offer `h264_videotoolbox` on Mac as a "fast" option.
4. **Risks:** caption and overlay times are computed on the edited timeline, so any change to segment timing must be checked against them. Variable-frame-rate phone footage.
5. **Accept:** a 25 fps source exports at 25 fps; a sine-tone test with 20 cuts has no sample jump above a set threshold; captions stay within one frame of their words after 200 cuts (new test); the 800-cut benchmark finishes and its time is recorded in the PR.
6. **Size:** L
7. **Model:** **Fable 5.2.** The recipe ties together cuts, captions, overlays and the audio mix, and sync faults here are subtle.

#### 1.6 Cancel and clearer failures for long jobs

**Status: done except the model checksum.** A Cancel button on the progress overlay stops an export (no half-written file is left; back in the editor in under 2 s in the e2e test) or a transcription (the video stays open without a transcript). Cancelling kills ffmpeg or whisper.cpp at once and aborts ElevenLabs uploads and model downloads. An interrupted model download keeps its `.part` file and the next attempt resumes with an HTTP range request (unit-tested against a local range server). Disk full, permission denied and unreadable files get plain messages. Not done: the SHA-256 check, because the expected hashes for the two model files were not available offline; the existing exact-size check stays.
1. **Why:** a wrong export or a 20-minute transcription cannot be stopped short of quitting.
2. **Files:** `src/media.js` (`runFfmpeg`), `src/transcribe.js` (`runWhisper`, `ensureModel`), `src/cloud.js`, `src/main.js`, `src/preload.js`, the overlay in `app.js` and `index.html`.
3. **Approach:**
   - Thread an `AbortSignal` through ffmpeg, whisper and `fetch`.
   - Add a `job:cancel` IPC call and a Cancel button on the progress overlay.
   - Remove the partial output file on cancel.
   - Resume model downloads with an HTTP `Range` request and verify a SHA-256.
   - Map the common ffmpeg failures (disk full, unreadable codec) to plain messages.
4. **Risks:** a killed whisper run leaves partial files in its work folder; remove the folder on cancel.
5. **Accept:** Cancel during export returns to the editor within 2 seconds and leaves no partial file; cancelling a model download and retrying continues from where it stopped.
6. **Size:** M
7. **Model:** Opus 5.5

#### 1.7 Long-video performance in the editor

**Status: done; thumbnails left as they are.** Measured with `scripts/bench-editor.js` on a 60-minute project (8,997 words, captions on, 20 photos on tracks):

| | Before | After |
|---|---|---|
| Open project | 910 ms | 190–270 ms |
| Select a word | about 200 ms | 12 ms |
| Cut one word | 293 ms | 16 ms |
| Undo | not measured | 15 ms |
| Playback | 120 fps | 119 fps (one 33 ms frame in 477) |

- The plan's guess was wrong: the transcript was not the main cost. The timeline rebuilt a DOM block for every word and caption group, two or three times per refresh, each placed with a linear search. It now builds blocks only around the visible part (rebuilding as you scroll), maps times in one pass (`Edits.editedMapper`), lays out once per refresh, and caches theme colours.
- A cut now redraws only its own paragraph. Long speech without pauses is split into paragraphs (at a sentence end after 120 words, at most 250), and off-screen paragraphs skip layout (`content-visibility: auto`).
- Filmstrip thumbnails finishing loading no longer redraw the timeline once each.
- Not done: keeping B-roll thumbnails out of project files. Measured, they add about 6 KB per item and undo snapshots share them rather than copy them, so it was not worth the change.
1. **Why:** podcasts and classes run 30 to 90 minutes, and every cut rebuilds the document.
2. **Files:** `transcript-view.js` and `preview.js` (after 1.4), `timeline.js`, `tracks.js`, `media.js` (`extractFrames`), `main.js` (`media:timeline`).
3. **Approach:**
   - Build a 60-minute, 9,000-word fixture project and record time per cut and frames per second in playback.
   - Update only the affected paragraph on a cut instead of rebuilding all spans.
   - Cache `Tracks.placed()` until tracks or kept ranges change.
   - In `updatePlayhead()`, lay out only on resize or clip change.
   - Serve filmstrip frames as files instead of 400 base64 strings over IPC, and keep thumbnails out of the project file and undo snapshots.
4. **Risks:** the caret and selection code depends on the `spans` array. Depends on 1.4.
5. **Accept:** on the fixture, a single-word cut updates in under 50 ms and playback holds 55 fps or more on an M-series Mac; the project file shrinks by the size of the removed thumbnails.
6. **Size:** M
7. **Model:** Opus 5.5

#### 1.8 Bundled caption fonts

**Status: done, with three changes to the approach below.** Captions and titles use bundled Noto Sans in the preview and the export. What the tests found:
- The variable fonts from `mobile/fonts` could not be used as they were: ffmpeg's libass draws a variable font at regular weight whatever Bold says (measured), so every bold style would have lost its weight. Static Regular and Bold files are now cut from them (`scripts/make-static-fonts.py`, fontTools). That also made the folder smaller: 3.2 MB instead of 5.5 MB.
- libass reads font size as the font's whole line height, so exports drew text at about 65% of the preview's size. Sizes are now multiplied by each font's factor; a test recomputes the factors from the files.
- libass balanced the lines of a wrapped caption while the preview fills the first line first, so they broke at different words. Export now breaks greedily (`WrapStyle: 1`).
- English words inside a Telugu caption fell back to whatever system font had the letters; the export now switches font around each Latin run (part of 3.1, done here because it was needed for the match).
Result on ten realistic Telugu-English captions: the widest line is within 3 px of the preview (1080 px frame) for regular and bold, and the preview and export break at the same words. Not checked: a packaged build (`npm run dist:mac` needs the whisper and face-finder binaries, which are not built here), so `asarUnpack` is untested; the preview weight is now Regular or Bold only, so styles that were 600 to 900 look slightly different.
1. **Why:** export depends on macOS system font paths and fails silently when one is missing; a bundled set is also the base for custom fonts.
2. **Files:** `src/renderer/captions.js` (`fontFor`, `SCRIPT_FONTS`), `src/media.js` (`CAPTION_FONT_FILES`, `prepareFontsDir`), `package.json` (`extraResources`), new `assets/fonts`, `styles.css` (`@font-face`).
3. **Approach:**
   - Ship the Noto set (already in `mobile/fonts`) inside the Mac app and load it in the preview with `@font-face`.
   - Make `fontFor()` return the bundled family; no compatibility mode for old projects.
   - Make `prepareFontsDir()` throw when a font is missing.
   - Add a golden-frame test: render one Telugu-English caption and compare a pixel region.
4. **Risks:** about 4 MB added to the dmg. Chromium and libass may wrap the same text differently.
5. **Accept:** a new project's caption has the same line breaks in preview and export; removing a font file makes export fail with a clear message.
6. **Size:** S
7. **Model:** Sonnet 5.5

#### 1.9 Update notice (no signing)

**Status: done; the release workflow has not been run.** The Projects screen shows "Talkcut X is available (you have Y)" with Download (opens the release page) and Later (hides that version until the next release). `src/updates.js` reads GitHub's latest-release call at most once a day, with only a plain request named "Talkcut"; offline, rate limits, odd answers and links outside this repository are all silent. Checked against the live API: an installed 1.0.2 is told about 1.0.3, 1.0.3 is told nothing. Unit tests cover version comparison, caching, failures, dismissal and link checks; e2e tests (against a local stand-in for GitHub) cover the notice, Download, Later across a relaunch, same or older version, a 403, a hostile link and a refused connection. `.github/workflows/release.yml` builds the dmg from a `talkcut-*` tag onto a draft release, so nothing becomes "latest" until you publish it; it cannot be tested without pushing a tag, and it builds whisper.cpp from source, so expect the first run to need a fix or two.
1. **Why:** you chose not to pay for an Apple Developer account, so the app stays ad-hoc signed and users need a way to learn about new versions.
2. **Files:** `src/main.js`, `src/renderer/home.js`, new release workflow.
3. **Approach:**
   - On launch, read the latest release tag from GitHub and compare it with the app version.
   - Show a "New version available" notice on the home screen that opens the download page.
   - Build the dmg in CI from a tag.
   - Keep the "Open Anyway" steps in the install guide.
4. **Risks:** automatic in-place updates on macOS need a signed app, so they are not possible here. The Gatekeeper warning stays.
5. **Accept:** a 1.0.x install shows the notice when a newer release exists and stays quiet when offline.
6. **Size:** S
7. **Model:** Sonnet 5.5

### Phase 2: core wins

#### 2.1 Transcription benchmark
**Status: done, but no accuracy numbers have been produced yet.** `node scripts/bench-stt.js` fetches 3 clips per language from FLEURS (Google, CC BY 4.0; covers te, ta, ml, kn, hi, en; only the first ~4 MB of each test archive is downloaded, about 14 MB cached under the system temp folder, not the 2.5 GB archives), runs each available engine and prints one table plus a JSON file beside the cache. WER is computed in `scripts/lib/wer.js` over words after the editor's `normalize()` (unit-tested in `test/wer.test.js`, including a Telugu pair and a vowel-sign case). On this Mac whisper.cpp is not built (`npm run build:whisper` was not run without asking) and `ELEVENLABS_API_KEY` was not set, so every engine was skipped; the corpus download, the table and the skip messages were run, the scoring loop was exercised only with a rejected fake key. A marked spot in the script is left for Sarvam (task 2.2, key from `SARVAM_API_KEY`). Caveats:
- FLEURS is read speech, so every engine's numbers will look better than a creator's phone recording.
- FLEURS has no word times, so the start-time error column prints n/a rather than a made-up number.
- Code-mixed accuracy stays unmeasured: there is no public reference and the repo has no demo clip, so the English-in-Latin-letters column is empty.
- Three clips per language is a smoke test, not a statistically solid comparison; raise it with `--clips=N`.
1. **Why:** engine choices are currently based on one Telugu clip.
2. **Files:** new `scripts/bench-stt.js`, new `test/fixtures/stt/` (downloaded by a script, not stored in git).
3. **Approach:**
   - You have no clips to give, so use a public speech corpus with reference transcripts for te, ta, ml, kn, hi and en (FLEURS is the first candidate; check its licence and coverage before use).
   - Score each engine on word error rate and word-start timing error.
   - For code-mixed speech, where no public reference exists, report only the share of English words written in Latin letters on the repo's own demo clip.
   - Print one table per run.
4. **Risks:** read-speech corpora are cleaner than a creator's phone recording, so the numbers will flatter every engine. Code-mixed accuracy stays unmeasured until real clips exist.
5. **Accept:** one command prints the table for whisper Fast, whisper Accurate, ElevenLabs and (after 2.2) Sarvam.
6. **Size:** S
7. **Model:** Sonnet 5.5

#### 2.2 Sarvam engine
1. **Why:** it is the engine built for these languages. Built from scratch, as you confirmed.
2. **Files:** new `src/sarvam.js`, `src/keystore.js` (`SERVICES`), `src/main.js` (`media:transcribe`, `VERIFY`), `src/transcribe.js` (`CLOUD_QUALITY`), the engine dialog in `index.html` and `app.js`, new `test/sarvam.test.js`.
3. **Approach:**
   - Use Saaras v4. Audio over 30 seconds must go through the batch job API (create job, upload, start, poll, download).
   - Request `mode: codemix` with timestamps and diarisation; send the user's word list as `keyterms` (up to 50).
   - Map the response to `{ text, start, end, speaker }` and reuse `finalizeWords()` and `trimToSound()`.
   - Add it as a third engine with its own key type and the same failover.
4. **Risks:** **I have not confirmed that batch output gives per-word times.** If it gives segment times only, words need local alignment. Batch jobs are capped at 2 hours of audio.
5. **Accept:** a Telugu-English clip transcribes with Sarvam; clicking a word seeks to within 150 ms of its start; 2.1 shows Sarvam's row.
6. **Size:** M
7. **Model:** Opus 5.5

#### 2.3 Rearrangeable edit model
1. **Why:** moving a sentence, and joining two recordings, are the main Descript behaviours Talkcut cannot do.
2. **Files:** `edits.js` (new segment list beside `keptRanges`, `toEdited`, `toSource`), `tracks.js` (anchoring), `captions.js`, `render-plan.js`, `timeline.js`, `store.js` and `transcript-view.js`, `projects.js` (version 3 and migration), `main.js`.
3. **Approach:**
   - Replace "kept ranges in source order" with an ordered list of segments `{ source, start, end }`.
   - Give each word a stable id so cuts, selections and track anchors survive reordering.
   - Add cut, copy and paste of selected words in the transcript, and drag to move.
   - Allow a second source file appended to the project.
   - Upgrade version 2 projects one way on open, keeping a backup copy. You have none; this covers people who downloaded 1.0.3.
4. **Risks:** touches every consumer of `toEdited()`. Playback preview must jump backward as well as forward. Depends on 1.4 and 1.5.
5. **Accept:** select a sentence, cut it, paste it at the start: preview and export both play it first with captions in step; a version 2 project opens and is upgraded; property tests show `toSource(toEdited(t)) == t` for kept times.
6. **Size:** L
7. **Model:** **Fable 5.2.** It changes the central data model and every module built on it.

#### 2.4 Caption styles v2
1. **Why:** captions decide whether a Reel is watched muted, and six fixed presets are not enough.
2. **Files:** `captions.js` (`PRESETS`, `settingsOf`, `buildAss`), `panels.js` (`styleLine`, `fillLine`), `index.html`, `test/captions.test.js`.
3. **Approach:**
   - Let the user set font, colours, outline, box, case, words per line and line count.
   - Add word animations expressed in ASS (pop, scale, karaoke fill) with a matching CSS preview.
   - Draw safe-zone guides for the Reels and Shorts interface.
   - Save a style as a named preset.
4. **Risks:** preview and libass must match; extend the golden-frame test from 1.8. I have not read `panels.js`.
5. **Accept:** a custom style looks the same in preview and export on a golden frame; the pop animation appears in the exported file; a saved style appears in a new project.
6. **Size:** M
7. **Model:** Opus 5.5

#### 2.5 Review before cutting: fillers, retakes, silences
1. **Why:** one-click removal with only a toast makes users distrust it, and English-only fillers miss most cases.
2. **Files:** `edits.js` (`FILLERS`, `fillerIndices`, `findRetakes`), `transcribe.js` (`speechRegions`, `uncovered`), `app.js` (`removeFillers`, `removeRetakes`, `shortenPauses`), new review panel.
3. **Approach:**
   - Add per-language filler lists, editable by the user.
   - Detect unwritten fillers from audio: voiced stretches with no word in them.
   - Show a list of proposed cuts with play buttons and checkboxes, then apply as one undo step.
   - Make the pause threshold and the kept gap adjustable.
4. **Risks:** many Indic "fillers" are real words in other contexts (అంటే, मतलब), so they must be opt-in and reviewed.
5. **Accept:** on a Telugu fixture, the panel lists fillers with previews; unticking one keeps it; one undo restores all.
6. **Size:** M
7. **Model:** Opus 5.5

#### 2.6 Clips from a long video
1. **Why:** one long recording should yield several Shorts.
2. **Files:** `project-io.js`, `home.js`, `main.js` (`project:create`), new clip dialog.
3. **Approach:**
   - "Make clip" on a selection creates a new project on the same media, with everything outside the selection as range cuts, 9:16 canvas and captions on.
   - Optional suggestions: send the transcript to an LLM with the user's own key and list candidate hooks with times.
   - Export several clips in a queue.
4. **Risks:** the suggestion step needs another key type. It works on the current model, so it does not wait for 2.3.
5. **Accept:** selecting 40 seconds and pressing Make clip opens a 40-second vertical project with captions; three clips export in sequence.
6. **Size:** M
7. **Model:** Opus 5.5

#### 2.7 Templates
1. **Why:** creators want every video to look like theirs without redoing settings.
2. **Files:** `project-io.js`, `captions.js`, `text.js`, `frame.js`, settings storage in `main.js`.
3. **Approach:**
   - A template holds caption style, canvas, background, title presets and optional intro, outro and music items.
   - "Save as template" and "New from template".
   - Export and import a template as a file.
4. **Risks:** media in a template (logo, music) must be copied into app storage.
5. **Accept:** a template applied to a new video gives the same captions, frame and logo with no manual steps.
6. **Size:** M
7. **Model:** Sonnet 5.5

#### 2.8 Auto-frame that follows the speaker
1. **Why:** auto-frame uses one fixed position for the whole video, so it fails when the speaker moves.
2. **Files:** `frame.js` (`autoFrame`, `faceCentre`), `media.js` (`findFaces`), `vendor/facedetect/main.swift`, `render-plan.js`, `preview.js`.
3. **Approach:**
   - Sample more frames through the existing Vision helper.
   - Turn the detections into a smoothed position track.
   - Apply it as a time-varying crop in both preview and export.
   - Keep the static mode as the default.
4. **Risks:** a moving crop can look seasick; smoothing needs tuning. A time-varying crop complicates `render-plan.js`, so this follows 1.5.
5. **Accept:** on a clip where the speaker walks across the frame, the face stays inside the middle third in preview and in the export.
6. **Size:** M
7. **Model:** Opus 5.5

#### 2.9 Studio Sound v2
1. **Why:** phone-recorded speech in noisy rooms is the norm, and filters only go so far.
2. **Files:** `render-plan.js` (`STUDIO_SOUND`), `media.js` (`enhanceAudio`), `properties.js`.
3. **Approach:**
   - Compare the current chain with ffmpeg's `arnndn` (RNNoise) on real clips.
   - Add a strength slider.
   - Add a loudness target for social platforms as a final pass.
4. **Risks:** the README records that loudness normalisation raised hiss; apply it after the gate. `arnndn` needs a model file, and I have not checked that the bundled ffmpeg builds include the filter.
5. **Accept:** on three noisy clips, a blind comparison prefers the new chain; exported loudness is within 1 LU of the target.
6. **Size:** M
7. **Model:** Opus 5.5

#### 2.10 Descript-style editor layout
1. **Why:** you asked for the UI to work like Descript's, so people who know it feel at home.
2. **Files:** `src/renderer/index.html`, `styles.css`, `appearance.js` (workspaces), `transcript-view.js`, `panels.js`, `timeline.js`, `home.js`.
3. **Approach:**
   - Start with a side-by-side audit. The current layout already has the same skeleton (script left, video centre, panel and icon rail right, timeline below), so list the behaviours that differ rather than redrawing everything.
   - Make the script the main surface: wider column, speaker names in a left gutter, a floating toolbar on text selection (cut, correct, restore, add B-roll, make clip).
   - Add a scene rail with thumbnails and a scene break typed in the script, once 2.3 gives the model segments.
   - Add a command palette (⌘K) over the existing menu commands, and a collapsible timeline that opens from a handle.
   - Group the right panel the same way: project, layer properties, captions, media, AI tools.
4. **Risks:** this matches Descript's layout and interaction patterns only. It keeps Talkcut's own name, colours, icons and artwork, and copies none of Descript's assets or screens pixel for pixel; that limit was in your original brief and it also keeps the app clear of trade-dress trouble. I have not read `styles.css`, `appearance.js` or `panels.js`, so the audit comes first. Depends on 1.4; the scene rail depends on 2.3.
5. **Accept:** a written audit you approve before any restyling; then a Descript user can cut a sentence, add B-roll and export without using the menu bar; all four existing workspaces still work or are replaced on purpose.
6. **Size:** L
7. **Model:** Opus 5.5

### Phase 3: differentiate

#### 3.1 Code-mix-aware captions
1. **Why:** Telugu with English words is the normal case here and an afterthought elsewhere.
2. **Files:** `captions.js` (`groupWords`, `buildAss`, `fontFor`), `panels.js` (`fillLine`), `text.js` (`fontPx`), `test/captions.test.js`.
3. **Approach:**
   - Detect the script of each word and use a Latin font for English runs and the Indic font for the rest (ASS `\fn` per run, spans in the preview).
   - Count grapheme clusters with `Intl.Segmenter` in `groupWords()` and `fontPx()`.
   - Set line height per script, for tall conjuncts in Malayalam and Telugu.
   - Optionally colour English words differently.
4. **Risks:** mixing fonts in one line needs baseline alignment. Depends on 1.8.
5. **Accept:** "account setup చేయడానికి" renders English in the Latin font and Telugu in the Telugu font, the same in preview and export; a Telugu line and an English line of equal visible width break at the same point.
6. **Size:** M
7. **Model:** Opus 5.5

#### 3.2 Native script or romanised captions
1. **Why:** many viewers read Tenglish, Hinglish or Tanglish faster than the native script.
2. **Files:** new `src/transliterate.js`, `captions.js`, the captions panel.
3. **Approach:**
   - Add a per-project caption script: native, romanised or as transcribed.
   - Transliterate word by word so timings stay attached; cache the result on each word as `alt`.
   - Let the user correct romanised spellings with the existing edit flow.
4. **Risks:** needs a transliteration service (Sarvam has one) or a local rule set; quality varies by language.
5. **Accept:** switching to romanised changes every caption and the SRT, keeps the highlight in step, and switches back without loss.
6. **Size:** M
7. **Model:** Opus 5.5

#### 3.3 Translated and two-language subtitles
1. **Why:** a Telugu Reel with English subtitles reaches a second audience at no extra shooting cost.
2. **Files:** new `src/translate.js`, `captions.js` (`buildSubtitles`, `buildAss`), the export dialog.
3. **Approach:**
   - Translate caption groups, not single words, and keep each group's timing.
   - Export an SRT per language.
   - Offer stacked captions: the original line with the translation under it.
4. **Risks:** translation changes length, so line fitting must re-run. Service cost.
5. **Accept:** a Telugu project exports an English SRT whose cues match the Telugu ones in time; the stacked style shows both lines inside the safe zone.
6. **Size:** M
7. **Model:** Opus 5.5

#### 3.4 Indic font library
1. **Why:** every Indic Reel looks the same because there is one usable font per script.
2. **Files:** `assets/fonts`, `captions.js`, the captions panel, `prepareFontsDir`.
3. **Approach:**
   - Curate open-licence display fonts per script, with bold weights.
   - Show each font with a sample in its own script.
   - Let the user import a font file.
   - Download fonts on first use to keep installers small.
4. **Risks:** each licence must permit bundling; installer size. Depends on 1.8.
5. **Accept:** at least four fonts per script, each rendering conjuncts correctly in a golden-frame test.
6. **Size:** S to M
7. **Model:** Sonnet 5.5

#### 3.5 Personal dictionary that the engines hear
1. **Why:** names, brands and place names are where every engine fails.
2. **Files:** `edits.js` (`applyWordList`), `app.js` (`wordList`, `saveWordList`), `sarvam.js`, `cloud.js`.
3. **Approach:**
   - Send the word list to engines that accept key terms (Sarvam `keyterms`).
   - When the same correction is made three times, offer to add it.
   - Export and import the list.
4. **Risks:** I have not verified whether ElevenLabs `scribe_v2` accepts key terms.
5. **Accept:** a brand name that was misheard is right on re-transcription after being added; the suggestion appears after three identical fixes.
6. **Size:** S
7. **Model:** Sonnet 5.5

#### 3.6 Better offline Indic transcription
1. **Why:** free, private and offline is a promise no cloud editor can make, and local Telugu is weak today.
2. **Files:** `transcribe.js` (`MODELS`, `STYLE_PROMPTS`), `scripts/build-whisper.sh`.
3. **Approach:**
   - Use 2.1 to test Indic fine-tuned Whisper models converted for whisper.cpp, and Indic-specific models through an ONNX runtime.
   - Ship the winner as a "Local Indic" engine per language.
   - Keep the clip-splitting and second-pass logic.
4. **Risks:** research with an uncertain result. Model licences. Some models give no word timings, which the editor needs.
5. **Accept:** a written result from 2.1; the engine ships only if it beats Accurate by a margin you set.
6. **Size:** L
7. **Model:** Opus 5.5

#### 3.7 One recording, several languages
1. **Why:** a creator can post the same Reel in Telugu, Hindi and Tamil.
2. **Files:** new `src/dub.js`, audio tracks in `tracks.js`, the export dialog.
3. **Approach:**
   - Send the edited audio to a dubbing service (Sarvam has a dubbing job API).
   - Add the result as an alternate voice track with translated captions from 3.3.
   - Export one file per language.
4. **Risks:** voice quality and lip mismatch; cost per minute; consent for voice cloning. Depends on 3.3.
5. **Accept:** a 60-second Telugu project exports a Hindi version with Hindi captions in step with the dubbed voice.
6. **Size:** M to L
7. **Model:** Opus 5.5

#### 3.8 The app in the creator's language
1. **Why:** an editor for Telugu creators should be usable in Telugu.
2. **Files:** `index.html`, every renderer module with strings, new `src/renderer/i18n/`, `app.js` (`forPlatform`, `localize`).
3. **Approach:**
   - Move strings into a catalogue with placeholders.
   - Remove the `forPlatform()` rewriting for the Mac build's strings.
   - Translate into te, ta, ml, kn and hi; add a language setting.
4. **Risks:** translated strings are longer and can break the layout.
5. **Accept:** switching to Telugu changes every visible string with no clipped text at the 1180 px minimum window width.
6. **Size:** M
7. **Model:** Sonnet 5.5 for extraction, Haiku 5.5 for bulk translation, then your review.

#### 3.9 Ready-to-post package
1. **Why:** after export the creator still needs a title, a description and a cover.
2. **Files:** the export dialog, new `publish-kit.js`.
3. **Approach:**
   - Pick a cover frame and add a title in the caption style.
   - Generate a title, description and hashtags in the project's language with the user's own LLM key.
   - Copy to clipboard.
4. **Risks:** another key type; generated text must stay editable.
5. **Accept:** export produces the video, a cover image and a text block in Telugu ready to paste.
6. **Size:** M
7. **Model:** Sonnet 5.5

### Deliberately not planned

Windows and Android work (your decision), remote recording, team collaboration, eye contact, green screen, avatars and voice regeneration. They cost the most and are not what an Indic solo creator is missing.

## Decisions

All answered on 2026-11-15. Nothing is open.

| Question | Your answer | Effect |
|---|---|---|
| Sarvam | Build from scratch | Task 2.2 |
| Windows and Android | Out of scope; leave the code in the repo | No task maintains or tests it. The `app.js` split may break the Android build. |
| Apple Developer account | No | 1.9 is an update notice only. The Gatekeeper warning stays. |
| Playwright as a dev dependency | Yes | 1.3 uses it |
| Plain script tags, no bundler | Yes | 1.4 keeps the current pattern |
| Bring-your-own LLM key | Yes | 2.6 and 3.9 use it |
| Benchmark clips from you | No | 2.1 uses a public corpus; code-mixed accuracy stays unmeasured |
| Sarvam API key | You have one | 2.2 can be tested for real |
| Old projects | You have none | No compatibility modes; a simple one-way upgrade remains for 1.0.3 downloaders |
| UI | Make it work like Descript's | Task 2.10, layout and behaviour only |
