/*
 * app.js — the whole user interface.
 *
 * How it works:
 *  - On start, all data is loaded from IndexedDB into `state` (in memory).
 *  - Screens are plain functions that return HTML strings; render() picks one
 *    based on the URL hash (e.g. #/history) and puts it into <main id="app">.
 *  - Buttons carry data-action="name"; one click listener looks the name up in
 *    `actions` below. To add a button: add data-action + an entry in actions.
 *  - Every change is written straight to IndexedDB, so closing the app
 *    mid-workout loses nothing.
 *
 * Sections:  1. setup & state   2. helpers   3. data helpers   4. screens
 *            5. pop-up sheets   6. actions   7. input handling  8. startup
 */

import * as db from './db.js';
import { progressionHint, compareSet, e1rm } from './progression.js';
import { exportData, importData } from './backup.js';

/* ===================== 1. Setup & state ===================== */

// Muscle groups, used for the dropdown grouping and for "swap for similar".
// Safe to edit: add or rename groups here.
const GROUPS = ['Chest', 'Back', 'Shoulders', 'Legs', 'Arms', 'Core', 'Other'];

// Starter exercises created on first launch only. Edit/delete them in the app.
const STARTER_EXERCISES = [
  ['Flat Bench Press', 'Chest'], ['Incline Bench Press', 'Chest'], ['Incline Dumbbell Press', 'Chest'],
  ['Dumbbell Bench Press', 'Chest'], ['Cable Fly', 'Chest'], ['Dips', 'Chest', true],
  ['Pull-up', 'Back', true], ['Chin-up', 'Back', true], ['Lat Pulldown', 'Back'],
  ['Barbell Row', 'Back'], ['Seated Cable Row', 'Back'], ['Chest-Supported Row', 'Back'], ['Deadlift', 'Back'],
  ['Overhead Press', 'Shoulders'], ['Dumbbell Shoulder Press', 'Shoulders'], ['Lateral Raise', 'Shoulders'],
  ['Rear Delt Fly', 'Shoulders'],
  ['Squat', 'Legs'], ['Hack Squat', 'Legs'], ['Leg Press', 'Legs'], ['Romanian Deadlift', 'Legs'],
  ['Leg Curl', 'Legs'], ['Leg Extension', 'Legs'], ['Calf Raise', 'Legs'],
  ['Barbell Curl', 'Arms'], ['Dumbbell Curl', 'Arms'], ['Tricep Pushdown', 'Arms'], ['Skull Crusher', 'Arms'],
  ['Hanging Leg Raise', 'Core', true], ['Cable Crunch', 'Core'],
];

const BACKUP_REMINDER_DAYS = 14;

// Everything in memory. Arrays mirror the IndexedDB stores; meta is a key→value map.
const state = { exercises: [], routines: [], sessions: [], meta: {} };

const $app = document.getElementById('app');

/* ===================== 2. Generic helpers ===================== */

/** Escape text before putting it into HTML (protects against odd names breaking the page). */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** 57.5 → "57.5", 100 → "100", null → "" */
const fmtKg = (n) => (n == null || n === '' ? '' : String(Math.round(n * 100) / 100));

/** Parse a typed number; accepts "57,5" as well as "57.5". Returns null if blank/invalid. */
const parseNum = (v) => {
  const n = parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

/** "Mon 13 Oct" (adds the year if it isn't this year). */
function fmtDate(iso) {
  const d = new Date(iso);
  const opts = { weekday: 'short', day: 'numeric', month: 'short' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('en-GB', opts);
}

/** "today" / "yesterday" / "6 days ago" */
function daysAgo(iso) {
  const start = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const n = Math.round((start(new Date()) - start(new Date(iso))) / 86400000);
  return n === 0 ? 'today' : n === 1 ? 'yesterday' : `${n} days ago`;
}

/** Local date as "YYYY-MM-DD" — key for the bodyweight log. */
function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, 2200);
}

/* ===================== 3. Data helpers ===================== */

const exById = (id) => state.exercises.find((e) => e.id === id) || { id, name: '(unknown exercise)', group: 'Other' };
const activeExercises = () => state.exercises.filter((e) => !e.deleted);
const sessionsNewestFirst = () => [...state.sessions].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
const activeSession = () => state.sessions.find((s) => !s.finishedAt);

async function saveSession(s) { await db.put('sessions', s); }
async function setMeta(key, value) { state.meta[key] = value; await db.put('meta', { key, value }); }

// While you type, saving is delayed slightly so we don't write on every keystroke.
let pendingSave = null;
function saveSessionSoon(s) {
  clearTimeout(pendingSave?.timer);
  pendingSave = { s, timer: setTimeout(flushSave, 400) };
}
function flushSave() {
  if (!pendingSave) return;
  clearTimeout(pendingSave.timer);
  const { s } = pendingSave;
  pendingSave = null;
  saveSession(s);
}

/**
 * The most recent earlier session where this exercise was actually done
 * (not skipped, at least one set). Returns { session, entry } or null.
 */
function lastTimeFor(exerciseId, currentSession) {
  for (const s of sessionsNewestFirst()) {
    if (currentSession && (s.id === currentSession.id || s.startedAt > currentSession.startedAt)) continue;
    const entry = s.entries.find((e) => e.exerciseId === exerciseId && !e.skipped && e.sets.length);
    if (entry) return { session: s, entry };
  }
  return null;
}

/** "100kg × 10, 8, 6" when the weight is the same, else "60kg × 8, 57.5kg × 6". */
function formatSets(sets, bodyweight) {
  if (!sets.length) return '';
  const pre = bodyweight ? 'BW ' : '';
  const sameKg = sets.every((s) => s.kg === sets[0].kg);
  if (sameKg) return `${pre}${fmtKg(sets[0].kg)}kg × ${sets.map((s) => s.reps ?? '?').join(', ')}`;
  return sets.map((s) => `${pre}${fmtKg(s.kg)}kg × ${s.reps ?? '?'}`).join(', ');
}

/** Most recent bodyweight entered (today's if there is one). */
function latestBodyweight() {
  const log = state.meta.bodyweights || {};
  const keys = Object.keys(log).sort();
  return keys.length ? log[keys[keys.length - 1]] : null;
}

/* ===================== 4. Screens ===================== */

const routes = [
  [/^#\/?$/, 'home', renderHome],
  [/^#\/session\/(.+)$/, 'home', renderSession],
  [/^#\/plans$/, 'plans', renderPlans],
  [/^#\/plan\/(.+)$/, 'plans', renderPlanEdit],
  [/^#\/history$/, 'history', renderHistory],
  [/^#\/exercises$/, 'exercises', renderExercises],
  [/^#\/exercise\/(.+)$/, 'exercises', renderExerciseProgress],
  [/^#\/backup$/, 'backup', renderBackup],
];

/** Draw the screen for the current URL. keepScroll=true when redrawing the same screen. */
function render(keepScroll = false) {
  const hash = location.hash || '#/';
  const y = window.scrollY;
  for (const [re, tab, fn] of routes) {
    const m = hash.match(re);
    if (m) {
      $app.innerHTML = fn(...m.slice(1).map(decodeURIComponent));
      document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
      window.scrollTo(0, keepScroll ? y : 0);
      if (tab === 'backup') fillBackupInfo();
      return;
    }
  }
  location.hash = '#/';
}
const rerender = () => render(true);

/* ----- Home: start or resume a workout ----- */
function renderHome() {
  const live = activeSession();
  const plans = [...state.routines].sort((a, b) => a.name.localeCompare(b.name));
  const lastBackup = state.meta.lastBackup;
  const needsBackup = state.sessions.length > 0 &&
    (!lastBackup || Date.now() - new Date(lastBackup) > BACKUP_REMINDER_DAYS * 86400000);

  return `
    <h1>Workout</h1>
    ${needsBackup ? `<a class="card" href="#/backup" style="display:block;text-decoration:none">
        💾 <b>Back up your data</b><br><span class="muted small">${lastBackup ? `Last backup ${daysAgo(lastBackup)}` : 'No backup yet'} — tap to export.</span></a>` : ''}
    ${live ? `
      <div class="card">
        <div class="tag accent">IN PROGRESS</div>
        <h2 style="margin:8px 0 4px">${esc(live.name)}</h2>
        <p class="muted small">Started ${fmtDate(live.startedAt)}</p>
        <a class="btn primary block big" href="#/session/${live.id}">Resume workout</a>
      </div>` : ''}
    <h2>Start a workout</h2>
    ${plans.map((p) => `
      <button class="btn block big choice" data-action="start" data-plan="${p.id}" style="margin-top:10px;flex-direction:column;align-items:flex-start;padding:10px 16px">
        <span>${esc(p.name)}</span>
        <span class="muted small" style="font-weight:400">${p.exerciseIds.map((id) => esc(exById(id).name)).join(' · ') || 'No exercises yet'}</span>
      </button>`).join('')}
    <button class="btn block big" data-action="start" data-plan="" style="margin-top:10px">＋ Empty workout</button>
    <p class="center" style="margin-top:18px"><a href="#/plans">Build or edit workout plans →</a></p>`;
}

/* ----- A workout session (live or past) ----- */
function renderSession(id) {
  const s = state.sessions.find((x) => x.id === id);
  if (!s) return `<h1>Not found</h1><p><a href="#/">Back</a></p>`;
  const inSession = new Set(s.entries.map((e) => e.exerciseId));
  return `
    <div class="row">
      <h1 class="grow">${esc(s.name)}</h1>
      ${s.finishedAt ? '<span class="tag">PAST</span>' : ''}
    </div>
    <p class="muted small" style="margin-top:-8px">${fmtDate(s.startedAt)}</p>
    ${s.entries.map((entry, i) => entryCard(s, entry, i)).join('') ||
      '<p class="muted">No exercises yet — add one below.</p>'}
    <div class="card">
      <label class="field-label" style="margin-top:0">Add an exercise</label>
      ${exerciseSelect('session-add', inSession)}
    </div>
    <div class="stack" style="margin-top:20px">
      ${s.finishedAt
        ? `<a class="btn primary block big" href="#/history">Done</a>
           <button class="btn danger block" data-action="delete-session" data-s="${s.id}">Delete this workout</button>`
        : `<button class="btn primary block big" data-action="finish" data-s="${s.id}">Finish workout</button>
           <button class="btn danger block" data-action="discard" data-s="${s.id}">Discard workout</button>`}
    </div>`;
}

/** One exercise inside a session: last time, hint, sets, buttons. */
function entryCard(s, entry, i) {
  const ex = exById(entry.exerciseId);
  const last = lastTimeFor(entry.exerciseId, s);
  const lastSets = last?.entry.sets || [];
  const hint = entry.skipped ? null : progressionHint(ex, lastSets);
  const nextN = entry.sets.length;
  const nextLast = lastSets[nextN];
  const d = `data-s="${s.id}" data-e="${i}"`;

  return `
    <section class="card ${entry.skipped ? 'skipped' : ''}">
      <div class="ex-head">
        <a class="ex-name" href="#/exercise/${ex.id}">${esc(ex.name)}</a>
        ${ex.bodyweight ? '<span class="tag">BW</span>' : ''}
      </div>
      ${entry.swappedFrom ? `<p class="muted small" style="margin:2px 0 0">Swapped from ${esc(exById(entry.swappedFrom).name)}</p>` : ''}
      <p class="last-time">${last
        ? `Last time · ${fmtDate(last.session.startedAt)}: <b>${esc(formatSets(lastSets, ex.bodyweight))}</b>`
        : 'First time — no previous sets'}</p>
      ${hint ? `<p class="hint">💡 ${esc(hint)}</p>` : ''}
      ${entry.skipped ? `
        <div class="ex-actions"><button class="btn small" data-action="unskip" ${d}>Un-skip</button></div>
      ` : `
        ${ex.bodyweight && entry.bodyweight != null ? `
          <button class="bw-chip" data-action="change-bw" ${d}>
            <span>Bodyweight today: <b>${fmtKg(entry.bodyweight)} kg</b></span><span class="muted small">change</span>
          </button>` : ''}
        <div class="sets">${entry.sets.length ? `<div class="set set-header"><span class="set-n">Set</span><span class="set-kg">${ex.bodyweight ? 'Bodyweight' : 'kg'}</span><span class="set-reps">Reps</span></div>` : ''}${entry.sets.map((set, j) => setRow(s, entry, i, j, ex, lastSets[j])).join('')}</div>
        <button class="btn primary block add-set" data-action="add-set" ${d}>
          ＋ Set ${nextN + 1}${nextLast ? ` <span style="font-weight:400">· last ${fmtKg(nextLast.kg)} × ${nextLast.reps}</span>` : ''}
        </button>
        <div class="ex-actions">
          <button class="btn small" data-action="swap" ${d}>⇄ Swap</button>
          <button class="btn small" data-action="skip" ${d}>Skip</button>
          <button class="btn small ghost danger" data-action="remove-entry" ${d}>Remove</button>
        </div>
      `}
    </section>`;
}

/** One set row: weight, reps with − / +, comparison with last time, delete. */
function setRow(s, entry, i, j, ex, lastSet) {
  const set = entry.sets[j];
  const d = `data-s="${s.id}" data-e="${i}" data-j="${j}"`;
  return `
    <div class="set">
      <span class="set-n">${j + 1}</span>
      <span class="set-kg">
        ${ex.bodyweight
          ? `<span class="bw-kg">${fmtKg(set.kg)}</span><span class="unit">kg</span>`
          : `<input type="text" inputmode="decimal" autocomplete="off" aria-label="Weight in kg" data-field="kg" ${d} value="${fmtKg(set.kg)}">`}
      </span>
      <span class="set-reps">
        <button class="btn" data-action="reps" data-delta="-1" ${d} aria-label="One less rep">−</button>
        <input type="text" inputmode="numeric" autocomplete="off" aria-label="Reps" data-field="reps" ${d} value="${set.reps ?? ''}">
        <button class="btn" data-action="reps" data-delta="1" ${d} aria-label="One more rep">+</button>
      </span>
      <span class="set-x"><button class="btn ghost" data-action="remove-set" ${d} aria-label="Remove set">✕</button></span>
      <span class="set-last" id="cmp-${s.id}-${i}-${j}">${compareHtml(set, lastSet, ex.bodyweight)}</span>
    </div>`;
}

function compareHtml(set, lastSet, isBodyweight) {
  if (!lastSet) return '';
  const c = compareSet(set, lastSet, isBodyweight);
  return `Last: ${fmtKg(lastSet.kg)} × ${lastSet.reps}${c ? `<span class="cmp ${c.cls}">${c.label}</span>` : ''}`;
}

/**
 * Exercise dropdown grouped by muscle. `purpose` tells the change handler what
 * to do with the choice. `exclude` greys out exercises already in the list.
 */
function exerciseSelect(purpose, exclude = new Set(), extra = '') {
  const byGroup = GROUPS.map((g) => [g, activeExercises().filter((e) => e.group === g).sort((a, b) => a.name.localeCompare(b.name))]);
  return `
    <select data-pick="${purpose}" ${extra}>
      <option value="" selected disabled>Choose exercise…</option>
      ${byGroup.filter(([, list]) => list.length).map(([g, list]) => `
        <optgroup label="${g}">
          ${list.map((e) => `<option value="${e.id}" ${exclude.has(e.id) ? 'disabled' : ''}>${esc(e.name)}${e.bodyweight ? ' (BW)' : ''}</option>`).join('')}
        </optgroup>`).join('')}
      <option value="__new">＋ Create a new exercise…</option>
    </select>`;
}

/* ----- Plans (routines) list ----- */
function renderPlans() {
  const plans = [...state.routines].sort((a, b) => a.name.localeCompare(b.name));
  return `
    <h1>Workout plans</h1>
    <p class="muted small">Build your workouts in advance, then start one from the Workout tab.</p>
    <div class="card">
      ${plans.map((p) => `
        <div class="list-item">
          <a class="grow list-link" href="#/plan/${p.id}">
            <b>${esc(p.name)}</b><br>
            <span class="muted small">${p.exerciseIds.length} exercise${p.exerciseIds.length === 1 ? '' : 's'}</span>
          </a>
          <button class="btn small primary" data-action="start" data-plan="${p.id}">Start</button>
        </div>`).join('') || '<p class="muted">No plans yet.</p>'}
    </div>
    <button class="btn block big" data-action="new-plan">＋ New plan</button>`;
}

/* ----- Edit one plan ----- */
function renderPlanEdit(id) {
  const p = state.routines.find((r) => r.id === id);
  if (!p) return `<h1>Not found</h1><p><a href="#/plans">Back</a></p>`;
  return `
    <p><a href="#/plans">← Plans</a></p>
    <label class="field-label">Plan name</label>
    <input type="text" data-field="plan-name" data-p="${p.id}" value="${esc(p.name)}">
    <div class="card">
      ${p.exerciseIds.map((exId, i) => `
        <div class="list-item">
          <span class="grow">${esc(exById(exId).name)}</span>
          <button class="btn small" data-action="plan-move" data-p="${p.id}" data-i="${i}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
          <button class="btn small" data-action="plan-move" data-p="${p.id}" data-i="${i}" data-dir="1" ${i === p.exerciseIds.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
          <button class="btn small ghost danger" data-action="plan-remove" data-p="${p.id}" data-i="${i}" aria-label="Remove">✕</button>
        </div>`).join('') || '<p class="muted">No exercises yet.</p>'}
      <label class="field-label">Add an exercise</label>
      ${exerciseSelect('plan-add', new Set(p.exerciseIds), `data-p="${p.id}"`)}
    </div>
    <div class="stack">
      <button class="btn primary block big" data-action="start" data-plan="${p.id}">Start this workout</button>
      <button class="btn danger block" data-action="delete-plan" data-p="${p.id}">Delete plan</button>
    </div>`;
}

/* ----- History ----- */
function renderHistory() {
  const list = sessionsNewestFirst();
  return `
    <h1>History</h1>
    <div class="card">
      ${list.map((s) => {
        const done = s.entries.filter((e) => !e.skipped && e.sets.length);
        const sets = done.reduce((n, e) => n + e.sets.length, 0);
        return `
          <a class="list-item list-link" href="#/session/${s.id}">
            <span class="grow">
              <b>${fmtDate(s.startedAt)}</b> · ${esc(s.name)} ${s.finishedAt ? '' : '<span class="tag accent">LIVE</span>'}<br>
              <span class="muted small">${done.map((e) => esc(exById(e.exerciseId).name)).join(', ') || 'No sets'} · ${sets} set${sets === 1 ? '' : 's'}</span>
            </span>
            <span class="muted">›</span>
          </a>`;
      }).join('') || '<p class="muted">No workouts yet.</p>'}
    </div>`;
}

/* ----- Exercises list ----- */
function renderExercises() {
  return `
    <h1>Exercises</h1>
    <button class="btn primary block big" data-action="new-exercise">＋ New exercise</button>
    ${GROUPS.map((g) => {
      const list = activeExercises().filter((e) => e.group === g).sort((a, b) => a.name.localeCompare(b.name));
      if (!list.length) return '';
      return `
        <h2>${g}</h2>
        <div class="card">
          ${list.map((e) => `
            <div class="list-item">
              <a class="grow list-link" href="#/exercise/${e.id}">${esc(e.name)} ${e.bodyweight ? '<span class="tag">BW</span>' : ''}</a>
              <button class="btn small" data-action="edit-exercise" data-x="${e.id}">Edit</button>
              <button class="btn small ghost danger" data-action="delete-exercise" data-x="${e.id}" aria-label="Delete">✕</button>
            </div>`).join('')}
        </div>`;
    }).join('')}`;
}

/* ----- One exercise: progress over time ----- */
function renderExerciseProgress(id) {
  const ex = exById(id);
  // Every session where this exercise was done, oldest first.
  const rows = [...state.sessions]
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .flatMap((s) => s.entries.filter((e) => e.exerciseId === id && !e.skipped && e.sets.length).map((e) => ({ s, e })));

  // Chart value per session: best reps for bodyweight moves, best estimated 1RM otherwise.
  const points = rows.map(({ s, e }) => ({
    date: s.startedAt,
    value: ex.bodyweight
      ? Math.max(...e.sets.map((x) => x.reps || 0))
      : Math.max(...e.sets.map((x) => e1rm(x.kg || 0, x.reps || 0))),
  }));

  return `
    <p><a href="javascript:history.back()">← Back</a></p>
    <h1>${esc(ex.name)} ${ex.bodyweight ? '<span class="tag">BW</span>' : ''}</h1>
    ${points.length >= 2 ? `
      <div class="card">
        <p class="muted small" style="margin-top:0">${ex.bodyweight ? 'Best set (reps)' : 'Best set — estimated 1-rep max (kg)'}</p>
        ${lineChart(points)}
      </div>` : ''}
    <div class="card">
      ${rows.slice().reverse().map(({ s, e }) => `
        <a class="list-item list-link" href="#/session/${s.id}">
          <span class="grow"><b>${fmtDate(s.startedAt)}</b><br><span class="muted">${esc(formatSets(e.sets, ex.bodyweight))}</span></span>
          <span class="muted">›</span>
        </a>`).join('') || '<p class="muted">Not done yet.</p>'}
    </div>`;
}

/** Minimal SVG line chart. points: [{date, value}] oldest first. */
function lineChart(points) {
  const W = 320, H = 170, L = 34, R = 10, T = 10, B = 30;
  const vals = points.map((p) => p.value);
  let min = Math.min(...vals), max = Math.max(...vals);
  if (min === max) { min -= 1; max += 1; }
  const x = (i) => L + (i * (W - L - R)) / (points.length - 1);
  const y = (v) => T + (H - T - B) * (1 - (v - min) / (max - min));
  const path = points.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const short = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return `
    <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Progress chart">
      <line class="grid" x1="${L}" x2="${W - R}" y1="${y(max)}" y2="${y(max)}"/>
      <line class="grid" x1="${L}" x2="${W - R}" y1="${y(min)}" y2="${y(min)}"/>
      <text x="${L - 4}" y="${y(max) + 4}" text-anchor="end">${Math.round(max)}</text>
      <text x="${L - 4}" y="${y(min) + 4}" text-anchor="end">${Math.round(min)}</text>
      <polyline class="line" points="${path}"/>
      ${points.map((p, i) => `<circle class="dot" cx="${x(i)}" cy="${y(p.value)}" r="3.5"/>`).join('')}
      <text x="${L}" y="${H - 4}">${short(points[0].date)}</text>
      <text x="${W - R}" y="${H - 4}" text-anchor="end">${short(points[points.length - 1].date)}</text>
    </svg>`;
}

/* ----- Backup / settings ----- */
function renderBackup() {
  const lb = state.meta.lastBackup;
  return `
    <h1>Backup</h1>
    <div class="card">
      <p style="margin-top:0">Your data is stored only on this phone. Export a backup file now and then and keep it somewhere safe (Files, iCloud Drive, Google Drive, email to yourself).</p>
      <p class="muted small">${lb ? `Last export: ${fmtDate(lb)} (${daysAgo(lb)})` : 'Never exported.'}</p>
      <button class="btn primary block big" data-action="export">⬇ Export backup</button>
    </div>
    <div class="card">
      <p style="margin-top:0"><b>Restore</b> from a backup file. This <b>replaces</b> everything currently in the app.</p>
      <button class="btn block" data-action="import">⬆ Import backup…</button>
      <input type="file" id="import-file" accept=".json,application/json" hidden>
    </div>
    <div class="card small muted">
      <div>Storage protected from clearing: <b id="persist-status">checking…</b></div>
      <div>App version: <b id="app-version">…</b></div>
      <div>${state.exercises.filter((e) => !e.deleted).length} exercises · ${state.routines.length} plans · ${state.sessions.length} workouts</div>
      <button class="btn small" data-action="check-update" style="margin-top:10px">Check for update</button>
    </div>`;
}

/* ===================== 5. Pop-up sheets ===================== */

/** Show a bottom sheet. onMount(el, close) wires up its buttons. */
function openSheet(html, onMount) {
  const backdrop = document.createElement('div');
  backdrop.className = 'sheet-backdrop';
  backdrop.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
  const close = () => backdrop.remove();
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  document.body.appendChild(backdrop);
  onMount(backdrop.querySelector('.sheet'), close);
}

/** Ask for today's morning bodyweight. Resolves to a number, or null if cancelled. */
function askBodyweight(exerciseName, current) {
  return new Promise((resolve) => {
    const prefill = current ?? state.meta.bodyweights?.[dayKey()] ?? latestBodyweight();
    openSheet(`
      <h2>Morning bodyweight</h2>
      <p class="muted">For <b>${esc(exerciseName)}</b>. This is used as the weight for each set.</p>
      <div class="row"><input type="text" inputmode="decimal" id="bw-input" value="${fmtKg(prefill)}" placeholder="e.g. 82.5"><span class="muted">kg</span></div>
      <div class="row" style="margin-top:14px">
        <button class="btn grow" data-x="cancel">Cancel</button>
        <button class="btn primary grow" data-x="ok">Save</button>
      </div>`, (el, close) => {
      const input = el.querySelector('#bw-input');
      input.focus();
      input.select();
      const done = (v) => { close(); resolve(v); };
      el.querySelector('[data-x=cancel]').onclick = () => done(null);
      el.querySelector('[data-x=ok]').onclick = () => {
        const v = parseNum(input.value);
        if (v == null || v <= 0) { input.focus(); return; }
        setMeta('bodyweights', { ...(state.meta.bodyweights || {}), [dayKey()]: v });
        done(v);
      };
      input.onkeydown = (e) => { if (e.key === 'Enter') el.querySelector('[data-x=ok]').click(); };
    });
  });
}

/** Create or edit an exercise. Resolves to the saved exercise, or null. */
function editExerciseSheet(existing, defaultGroup = 'Other') {
  return new Promise((resolve) => {
    const ex = existing || { name: '', group: defaultGroup, bodyweight: false };
    openSheet(`
      <h2>${existing ? 'Edit exercise' : 'New exercise'}</h2>
      <label class="field-label">Name</label>
      <input type="text" id="ex-name" value="${esc(ex.name)}" placeholder="e.g. Flat Bench Press" autocomplete="off">
      <label class="field-label">Muscle group (used for “swap for similar”)</label>
      <select id="ex-group">${GROUPS.map((g) => `<option ${g === ex.group ? 'selected' : ''}>${g}</option>`).join('')}</select>
      <label class="check"><input type="checkbox" id="ex-bw" ${ex.bodyweight ? 'checked' : ''}> Bodyweight exercise (asks for your morning weight)</label>
      <div class="row" style="margin-top:10px">
        <button class="btn grow" data-x="cancel">Cancel</button>
        <button class="btn primary grow" data-x="ok">Save</button>
      </div>`, (el, close) => {
      const name = el.querySelector('#ex-name');
      if (!existing) name.focus();
      el.querySelector('[data-x=cancel]').onclick = () => { close(); resolve(null); };
      el.querySelector('[data-x=ok]').onclick = async () => {
        const n = name.value.trim();
        if (!n) { name.focus(); return; }
        const dup = activeExercises().find((e) => e.name.toLowerCase() === n.toLowerCase() && e.id !== existing?.id);
        if (dup) { toast(`“${dup.name}” already exists`); return; }
        const saved = { ...ex, id: ex.id || db.newId(), name: n, group: el.querySelector('#ex-group').value, bodyweight: el.querySelector('#ex-bw').checked };
        if (existing) Object.assign(existing, saved); else state.exercises.push(saved);
        await db.put('exercises', existing || saved);
        close();
        resolve(existing || saved);
      };
    });
  });
}

/** Pick a replacement for an exercise: same muscle group first, then anything. */
function swapSheet(currentEx, inSession) {
  return new Promise((resolve) => {
    const similar = activeExercises()
      .filter((e) => e.group === currentEx.group && e.id !== currentEx.id && !inSession.has(e.id))
      .sort((a, b) => a.name.localeCompare(b.name));
    openSheet(`
      <h2>Swap ${esc(currentEx.name)}</h2>
      <p class="muted small">Similar (${esc(currentEx.group)}):</p>
      ${similar.map((e) => `<button class="btn block choice" data-pick-id="${e.id}">${esc(e.name)}${e.bodyweight ? ' <span class="tag">BW</span>' : ''}</button>`).join('') || '<p class="muted">No other exercises in this group.</p>'}
      <label class="field-label">Or any exercise</label>
      ${exerciseSelect('swap-any', new Set([...inSession, currentEx.id]))}
      <button class="btn block ghost" data-x="cancel" style="margin-top:12px">Cancel</button>`, (el, close) => {
      const done = (v) => { close(); resolve(v); };
      el.querySelectorAll('[data-pick-id]').forEach((b) => { b.onclick = () => done(exById(b.dataset.pickId)); });
      el.querySelector('[data-x=cancel]').onclick = () => done(null);
      el.querySelector('select').onchange = async (e) => {
        if (e.target.value === '__new') {
          close();
          resolve(await editExerciseSheet(null, currentEx.group));
        } else done(exById(e.target.value));
      };
    });
  });
}

/* ===================== 6. Actions (button handlers) ===================== */

/** Look up the session and entry referenced by a button's data-s / data-e. */
function ctx(el) {
  const s = state.sessions.find((x) => x.id === el.dataset.s);
  const entry = s?.entries[Number(el.dataset.e)];
  return { s, entry, set: entry?.sets[Number(el.dataset.j)] };
}

/** Make sure a bodyweight exercise has today's bodyweight. Returns false if cancelled. */
async function ensureBodyweight(entry) {
  const ex = exById(entry.exerciseId);
  if (!ex.bodyweight || entry.bodyweight != null) return true;
  const bw = await askBodyweight(ex.name);
  if (bw == null) return false;
  entry.bodyweight = bw;
  return true;
}

/** Add an exercise to a session (asks bodyweight straight away for BW moves). */
async function addEntry(s, ex) {
  const entry = { exerciseId: ex.id, skipped: false, bodyweight: null, sets: [] };
  s.entries.push(entry);
  await ensureBodyweight(entry);
  await saveSession(s);
  rerender();
}

const actions = {
  /* --- Workouts --- */
  async start(el) {
    const live = activeSession();
    if (live) {
      if (!confirm(`You have a workout in progress (${live.name}). Finish it and start a new one?`)) {
        location.hash = `#/session/${live.id}`;
        return;
      }
      live.finishedAt = new Date().toISOString();
      await saveSession(live);
    }
    const plan = state.routines.find((r) => r.id === el.dataset.plan);
    const s = {
      id: db.newId(),
      name: plan ? plan.name : 'Workout',
      routineId: plan?.id || null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      entries: (plan?.exerciseIds || []).map((exerciseId) => ({ exerciseId, skipped: false, bodyweight: null, sets: [] })),
    };
    state.sessions.push(s);
    await saveSession(s);
    location.hash = `#/session/${s.id}`;
  },

  async 'add-set'(el) {
    const { s, entry } = ctx(el);
    if (!(await ensureBodyweight(entry))) return;
    const ex = exById(entry.exerciseId);
    const prev = entry.sets[entry.sets.length - 1];
    const lastSets = lastTimeFor(entry.exerciseId, s)?.entry.sets || [];
    const lastSame = lastSets[entry.sets.length];
    // Pre-fill: weight = previous set today (or set 1 last time);
    //           reps   = what you did on this same set last time (the number to beat),
    //                    else the previous set today.
    entry.sets.push({
      kg: ex.bodyweight ? entry.bodyweight : (prev?.kg ?? lastSets[0]?.kg ?? null),
      reps: lastSame?.reps ?? prev?.reps ?? null,
    });
    await saveSession(s);
    rerender();
  },

  async 'remove-set'(el) {
    const { s, entry } = ctx(el);
    entry.sets.splice(Number(el.dataset.j), 1);
    await saveSession(s);
    rerender();
  },

  async reps(el) {
    const { s, set } = ctx(el);
    set.reps = Math.max(0, (set.reps ?? 0) + Number(el.dataset.delta));
    const input = el.parentElement.querySelector('input');
    input.value = set.reps;
    refreshCompare(el);
    saveSessionSoon(s);
  },

  async 'change-bw'(el) {
    const { s, entry } = ctx(el);
    const bw = await askBodyweight(exById(entry.exerciseId).name, entry.bodyweight);
    if (bw == null) return;
    entry.bodyweight = bw;
    entry.sets.forEach((set) => { set.kg = bw; });
    await saveSession(s);
    rerender();
  },

  async skip(el) {
    const { s, entry } = ctx(el);
    if (entry.sets.length && !confirm('Skip this exercise? Its logged sets will be kept but not counted.')) return;
    entry.skipped = true;
    await saveSession(s);
    rerender();
  },

  async unskip(el) {
    const { s, entry } = ctx(el);
    entry.skipped = false;
    await saveSession(s);
    rerender();
  },

  async 'remove-entry'(el) {
    const { s, entry } = ctx(el);
    if (entry.sets.length && !confirm(`Remove ${exById(entry.exerciseId).name} and its ${entry.sets.length} set(s) from this workout?`)) return;
    s.entries.splice(Number(el.dataset.e), 1);
    await saveSession(s);
    rerender();
  },

  async swap(el) {
    const { s, entry } = ctx(el);
    const current = exById(entry.exerciseId);
    const inSession = new Set(s.entries.map((e) => e.exerciseId));
    const next = await swapSheet(current, inSession);
    if (!next) return;
    if (entry.sets.length && !confirm(`Swapping clears the ${entry.sets.length} set(s) logged for ${current.name}. Continue?`)) return;
    entry.swappedFrom = entry.swappedFrom || current.id;
    entry.exerciseId = next.id;
    entry.sets = [];
    entry.bodyweight = null;
    await ensureBodyweight(entry);
    await saveSession(s);
    rerender();
  },

  async finish(el) {
    flushSave();
    const { s } = ctx(el);
    const sets = s.entries.reduce((n, e) => n + (e.skipped ? 0 : e.sets.length), 0);
    if (!sets) {
      if (confirm('No sets logged. Discard this workout?')) return actions.discard(el, true);
      return;
    }
    s.finishedAt = new Date().toISOString();
    await saveSession(s);
    toast(`Workout saved · ${sets} sets`);
    location.hash = '#/';
  },

  async discard(el, skipConfirm) {
    const { s } = ctx(el);
    if (!skipConfirm && !confirm('Discard this workout? Its sets will be deleted.')) return;
    state.sessions = state.sessions.filter((x) => x.id !== s.id);
    await db.del('sessions', s.id);
    location.hash = '#/';
  },

  async 'delete-session'(el) {
    const { s } = ctx(el);
    if (!confirm(`Delete the workout from ${fmtDate(s.startedAt)}? This can't be undone.`)) return;
    state.sessions = state.sessions.filter((x) => x.id !== s.id);
    await db.del('sessions', s.id);
    location.hash = '#/history';
  },

  /* --- Plans --- */
  async 'new-plan'() {
    const p = { id: db.newId(), name: 'New plan', exerciseIds: [] };
    state.routines.push(p);
    await db.put('routines', p);
    location.hash = `#/plan/${p.id}`;
  },

  async 'plan-move'(el) {
    const p = state.routines.find((r) => r.id === el.dataset.p);
    const i = Number(el.dataset.i), j = i + Number(el.dataset.dir);
    [p.exerciseIds[i], p.exerciseIds[j]] = [p.exerciseIds[j], p.exerciseIds[i]];
    await db.put('routines', p);
    rerender();
  },

  async 'plan-remove'(el) {
    const p = state.routines.find((r) => r.id === el.dataset.p);
    p.exerciseIds.splice(Number(el.dataset.i), 1);
    await db.put('routines', p);
    rerender();
  },

  async 'delete-plan'(el) {
    const p = state.routines.find((r) => r.id === el.dataset.p);
    if (!confirm(`Delete plan “${p.name}”? Past workouts are kept.`)) return;
    state.routines = state.routines.filter((r) => r.id !== p.id);
    await db.del('routines', p.id);
    location.hash = '#/plans';
  },

  /* --- Exercises --- */
  async 'new-exercise'() {
    if (await editExerciseSheet(null)) rerender();
  },

  async 'edit-exercise'(el) {
    if (await editExerciseSheet(exById(el.dataset.x))) rerender();
  },

  async 'delete-exercise'(el) {
    const ex = exById(el.dataset.x);
    const used = state.sessions.some((s) => s.entries.some((e) => e.exerciseId === ex.id));
    if (!confirm(`Delete “${ex.name}”?${used ? ' Your past sets for it stay in History.' : ''}`)) return;
    // Remove it from any plans.
    for (const p of state.routines) {
      if (p.exerciseIds.includes(ex.id)) {
        p.exerciseIds = p.exerciseIds.filter((id) => id !== ex.id);
        await db.put('routines', p);
      }
    }
    if (used) {
      ex.deleted = true; // keep the record so history still shows its name
      await db.put('exercises', ex);
    } else {
      state.exercises = state.exercises.filter((e) => e.id !== ex.id);
      await db.del('exercises', ex.id);
    }
    rerender();
  },

  /* --- Backup --- */
  async export() {
    flushSave();
    try {
      if (await exportData()) {
        await setMeta('lastBackup', new Date().toISOString());
        rerender();
        toast('Backup exported');
      }
    } catch (err) {
      alert(`Export failed: ${err.message}`);
    }
  },

  import() {
    document.getElementById('import-file').click();
  },

  async 'check-update'() {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (!reg) return toast('Offline support not active');
    await reg.update().catch(() => {});
    if (!reg.waiting && !reg.installing) toast('You have the latest version');
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || !actions[el.dataset.action]) return;
  e.preventDefault();
  actions[el.dataset.action](el);
});

/* ===================== 7. Input handling ===================== */

/** Re-draw the "Last: 100 × 10 +2" text for the set row that `el` belongs to. */
function refreshCompare(el) {
  const { s, entry, set } = ctx(el);
  const lastSet = lastTimeFor(entry.exerciseId, s)?.entry.sets[Number(el.dataset.j)];
  const target = document.getElementById(`cmp-${s.id}-${el.dataset.e}-${el.dataset.j}`);
  if (target) target.innerHTML = compareHtml(set, lastSet, exById(entry.exerciseId).bodyweight);
}

// Typing in weight / reps / plan-name fields.
let planNameTimer = null;
document.addEventListener('input', (e) => {
  const el = e.target;
  const field = el.dataset?.field;
  if (field === 'kg' || field === 'reps') {
    const { s, set } = ctx(el);
    const n = parseNum(el.value);
    set[field] = field === 'reps' && n != null ? Math.round(n) : n;
    refreshCompare(el);
    saveSessionSoon(s);
  } else if (field === 'plan-name') {
    const p = state.routines.find((r) => r.id === el.dataset.p);
    p.name = el.value.trim() || 'Untitled plan';
    clearTimeout(planNameTimer);
    planNameTimer = setTimeout(() => db.put('routines', p), 400);
  }
});

// Tapping a weight/reps box selects its contents, so you can just type the new number.
document.addEventListener('focusin', (e) => {
  if (e.target.dataset?.field === 'kg' || e.target.dataset?.field === 'reps') {
    setTimeout(() => e.target.select(), 0);
  }
});

// Dropdowns: adding exercises to a session or plan.
document.addEventListener('change', async (e) => {
  const sel = e.target;
  const purpose = sel.dataset?.pick;
  if (purpose === 'session-add' || purpose === 'plan-add') {
    let ex = sel.value === '__new' ? await editExerciseSheet(null) : exById(sel.value);
    sel.value = '';
    if (!ex) return;
    if (purpose === 'session-add') {
      const s = state.sessions.find((x) => x.id === location.hash.split('/')[2]);
      await addEntry(s, ex);
    } else {
      const p = state.routines.find((r) => r.id === sel.dataset.p);
      p.exerciseIds.push(ex.id);
      await db.put('routines', p);
      rerender();
    }
  } else if (sel.id === 'import-file' && sel.files[0]) {
    const file = sel.files[0];
    sel.value = '';
    if (!confirm('Replace ALL current data with this backup?')) return;
    try {
      const r = await importData(file);
      await loadState();
      alert(`Restored ${r.exercises} exercises and ${r.sessions} workouts.`);
      location.hash = '#/';
      render();
    } catch (err) {
      alert(`Import failed: ${err.message}`);
    }
  }
});

// Save any half-typed numbers if the app is closed or put in the background.
document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });
window.addEventListener('pagehide', flushSave);

/* ===================== 8. Startup ===================== */

async function loadState() {
  const all = await db.readEverything();
  state.exercises = all.exercises;
  state.routines = all.routines;
  state.sessions = all.sessions;
  state.meta = Object.fromEntries(all.meta.map((m) => [m.key, m.value]));
}

/** First launch only: add the starter exercise list. */
async function seedIfEmpty() {
  if (state.meta.seeded) return;
  if (!state.exercises.length) {
    for (const [name, group, bodyweight = false] of STARTER_EXERCISES) {
      const ex = { id: db.newId(), name, group, bodyweight };
      state.exercises.push(ex);
      await db.put('exercises', ex);
    }
  }
  await setMeta('seeded', true);
}

/** Ask the browser not to clear our storage when space runs low. */
async function requestPersistence() {
  if (!navigator.storage?.persist) return false;
  try {
    return (await navigator.storage.persisted()) || (await navigator.storage.persist());
  } catch { return false; }
}

/** Offline support + update banner. */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const banner = document.getElementById('update-banner');
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const offer = () => { if (reg.waiting && navigator.serviceWorker.controller) banner.hidden = false; };
    offer();
    reg.addEventListener('updatefound', () => {
      reg.installing?.addEventListener('statechange', offer);
    });
    document.getElementById('update-btn').onclick = () => {
      flushSave();
      reg.waiting?.postMessage('SKIP_WAITING');
    };
    // Check for a new version whenever the app comes back to the foreground.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
  });
  // When the new version takes over, reload once to use it. Data is untouched.
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return;
    reloaded = true;
    location.reload();
  });
}

/** Fill in the version + storage status on the Backup screen when it's open. */
async function fillBackupInfo() {
  const v = document.getElementById('app-version');
  if (v) {
    const ctrl = navigator.serviceWorker?.controller;
    if (ctrl) {
      const ch = new MessageChannel();
      ch.port1.onmessage = (e) => { v.textContent = e.data; };
      ctrl.postMessage('GET_VERSION', [ch.port2]);
    } else v.textContent = 'not installed yet';
  }
  const p = document.getElementById('persist-status');
  if (p) p.textContent = (await navigator.storage?.persisted?.()) ? 'yes' : 'not yet (add to home screen helps)';
}

window.addEventListener('hashchange', () => { flushSave(); render(); });

(async function start() {
  try {
    await loadState();
    await seedIfEmpty();
  } catch (err) {
    $app.innerHTML = `<h1>Storage problem</h1><p>${esc(err.message)}</p><p class="muted">Private browsing can block storage.</p>`;
    return;
  }
  render();
  requestPersistence();
  registerServiceWorker();
})();
