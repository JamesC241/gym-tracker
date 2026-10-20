# Gym Tracker

A personal workout log that runs as an app on your phone (a Progressive Web App).
Its main job: **when you log a set, show exactly what you did on that set last time**, so you can beat it.

- Works fully offline after the first load.
- No accounts, no server, no tracking. Your data never leaves your phone.
- Plain HTML, CSS and JavaScript. No build step: edit a file, deploy, done.

---

## Using the app

| Tab | What it's for |
|---|---|
| **Workout** | Start a workout from one of your plans (or an empty one). Resume one in progress. |
| **Plans** | Build workouts in advance (e.g. Push, Pull, Legs): pick exercises from the dropdown and order them. |
| **History** | Every past workout. Tap one to view or edit it. |
| **Exercises** | Add, rename or delete exercises, set their muscle group, and mark bodyweight ones. Tap an exercise to see its progress chart. |
| **Backup** | Export / Import your data. |

**During a workout**, each exercise shows:
- **Last time**: every working set from your previous session of that exercise, e.g. `100kg × 10, 8, 6`.
- **＋ Set** (one tap). The new set is pre-filled with your weight and **the reps you got on that same set last time**. Use − / + to adjust, or tap a box to type.
- Under each set: `Last: 100 × 8` and how you compare (**+1** green, **−1** red, **=** same).
- **⇄ Swap**: someone's on the machine? Pick a similar exercise (same muscle group) or any other.
- **Skip**: marks the exercise as skipped (Un-skip to undo).
- **✕** on a set removes it. **Remove** takes the exercise out of today's workout.
- **Bodyweight exercises** (marked BW, e.g. Pull-up, Dips) ask for your morning bodyweight, which becomes the weight for every set, so you only log reps. Tap "Bodyweight today" to correct it.
- A 💡 hint appears when set 1 reached 12+ reps last time, suggesting +2.5 kg. Change these numbers at the top of `js/progression.js`.

Everything saves the moment you change it. Closing the app mid-workout loses nothing.
Only log **working sets**. Warm-ups are deliberately not tracked.

---

## Where your data is stored

All data is in **IndexedDB**, a database built into the browser, on your phone only. It's stored per website address, so the copy on your phone belongs to the GitHub Pages address of the app.

- The hosted website contains **only the app code**. It never sees your data.
- The app calls `navigator.storage.persist()` to ask the browser not to clear your data when the phone is low on space. **Add the app to your home screen**: that's what makes iPhone and Android treat its storage as permanent.
- On iPhone, the home-screen app and Safari have **separate storage**. Always use the home-screen icon.

## Backup & restore

**Backup:** Backup tab → **Export backup**.
- iPhone: the share sheet opens → **Save to Files** (iCloud Drive is ideal), or AirDrop / email it to yourself.
- Android: share to Google Drive / Files, or it downloads to *Downloads*.

The file is named like `gym-tracker-backup-2026-10-20.json`. The Workout tab reminds you if you haven't backed up for 14 days.

**Restore:** Backup tab → **Import backup…** → choose the file. This **replaces** everything currently in the app, so use it on a new phone or after data loss.

---

## How the code is organised

```
index.html            page skeleton + bottom nav
css/app.css           all styling (colours are variables at the top)
js/app.js             all screens and buttons (sections are numbered inside)
js/db.js              IndexedDB read/write helpers + data layout
js/progression.js     "vs last time" comparison and the add-weight hint
js/backup.js          export / import
sw.js                 service worker: offline caching and updates
manifest.webmanifest  app name, icon, theme colour for "Add to Home Screen"
icons/                app icons (regenerate with tools/make-icons.ps1)
tools/serve.ps1       local test server (not used by the live app)
```

**Common small changes**
- Add-weight rule → `js/progression.js` (`REP_CEILING`, `INCREMENT_KG`).
- Muscle groups → `GROUPS` at the top of `js/app.js`.
- Colours → variables at the top of `css/app.css`.
- Backup reminder interval → `BACKUP_REMINDER_DAYS` in `js/app.js`.

---

## Testing changes on your PC

From the project folder in PowerShell:

```
powershell -ExecutionPolicy Bypass -File tools\serve.ps1
```

Open http://localhost:8080 in Chrome or Edge. Press F12, then the toolbar icon for a phone view. (The test copy has its own separate data, not your phone's.)

## Deploying changes (updating the app on your phone)

1. Make your change.
2. **Open `sw.js` and bump `VERSION`** (e.g. `'1.0.0'` → `'1.0.1'`). This is what tells phones there's a new version. If you added a new file, also add it to the `ASSETS` list there.
3. Commit and push to GitHub:
   ```
   git add -A
   git commit -m "Describe the change"
   git push
   ```
4. GitHub Pages republishes in about a minute.
5. Open the app on your phone. It downloads the new version in the background and shows **"New version ready → Update"**. Tap it. (If it doesn't appear, close and reopen the app, or tap *Check for update* on the Backup tab.)

Your workout data is **not** affected by updates. It lives in IndexedDB, separate from the app files.

> If you ever change how data is stored, bump `DB_VERSION` in `js/db.js` and add an upgrade step there. Never delete a store. Export a backup first.

---

## Install on your phone

**iPhone (Safari, must be Safari):**
1. Open the app's address in Safari.
2. Tap the **Share** button (square with an up arrow).
3. Scroll down and tap **Add to Home Screen**, then **Add**.
4. Open it from the home-screen icon from now on.

**Android (Chrome):**
1. Open the app's address in Chrome.
2. Tap **⋮** (top right), then **Add to Home screen** (or **Install app**), then **Install**.
3. Open it from the home-screen icon.

Open it once with signal so it can save itself for offline use.
