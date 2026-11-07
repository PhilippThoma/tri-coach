// Screens, settings, intervals.icu sync and local cache. The coaching itself lives in logic.js.
"use strict";

const API = "https://intervals.icu/api/v1";
const KEYS = { settings: "tc-settings", acts: "tc-acts", well: "tc-well", synced: "tc-synced" };
const REFETCH_DAYS = 14;
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const $ = id => document.getElementById(id);

const store = {
  get(k, fallback = null) { try { const v = localStorage.getItem(k); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

const todayIso = () => isoOf(new Date());
const defaults = () => ({
  apiKey: "", athleteId: "0", historyStart: shift(todayIso(), -540), ftp: null,
  race: { name: "", date: "", swim_km: 2, bike_km: 80, run_km: 18 },
  paces: { runThr: 225, swimCss: 105 }, unavailable: { run: "", swim: "" }, swimsPerWeek: 2,
  commute: { noPowerFrom: "", kmMin: 0, kmMax: 0, keywords: ["commute", "work"] },
});
let cfg = Object.assign(defaults(), store.get(KEYS.settings, {}));
let state = null, feel = "normal";
const fixture = new URLSearchParams(location.search).has("fixture");

// ---------- sync ----------
async function api(path, params) {
  const url = `${API}/athlete/${encodeURIComponent(cfg.athleteId || "0")}/${path}?${new URLSearchParams(params)}`;
  const res = await fetch(url, { headers: { Authorization: "Basic " + btoa("API_KEY:" + cfg.apiKey.trim()) } });
  if (res.status === 401 || res.status === 403) throw new Error("intervals.icu did not accept the API key. Check it in Settings.");
  if (!res.ok) throw new Error(`intervals.icu answered with error ${res.status}. Try again later.`);
  return res.json();
}

async function fetchRange(kind, oldest, newest) {
  const out = [];
  for (let start = oldest; start <= newest; start = shift(start, 366)) {
    const end = shift(start, 365) < newest ? shift(start, 365) : newest;
    out.push(...await api(kind, { oldest: start, newest: end }));
  }
  return out;
}

function merge(key, rows, sortKey) {
  const byId = Object.fromEntries(store.get(key, []).map(r => [String(r.id), r]));
  for (const r of rows) byId[String(r.id)] = r;
  const merged = Object.values(byId).sort((a, b) => (String(a[sortKey]) < String(b[sortKey]) ? -1 : 1));
  if (!store.set(key, merged)) throw new Error("This phone's storage is full. Shorten “History from” in Settings.");
  return merged;
}

async function loadFixture() {
  const [a, w] = await Promise.all(["activities", "wellness"].map(n => fetch(`../data/${n}.json`).then(r => r.json())));
  store.set(KEYS.acts, a.map(compactActivity));
  store.set(KEYS.well, w.map(compactWellness));
  store.set(KEYS.synced, new Date().toISOString());
}

async function sync(full = false) {
  if (fixture) { await loadFixture(); return; }
  if (!cfg.apiKey) { openSettings(true); return; }
  const today = todayIso();
  const isFull = full || !store.get(KEYS.acts);
  const oldest = isFull ? cfg.historyStart : shift(today, -REFETCH_DAYS);
  setStatus(isFull ? "Downloading your history…" : "Syncing…");
  if (isFull) { store.del(KEYS.acts); store.del(KEYS.well); }
  const acts = await fetchRange("activities", oldest, today);
  merge(KEYS.acts, acts.map(compactActivity), "s");
  const well = await fetchRange("wellness", oldest, today);
  merge(KEYS.well, well.map(compactWellness), "id");
  store.set(KEYS.synced, new Date().toISOString());
}

async function refresh(full = false) {
  $("syncBtn").classList.add("spin");
  try {
    await sync(full);
    compute();
  } catch (e) {
    setStatus(e.message === "Failed to fetch" ? "No connection. Showing your last synced data." : e.message, true);
  } finally {
    $("syncBtn").classList.remove("spin");
  }
}

function compute() {
  const acts = store.get(KEYS.acts, []), well = store.get(KEYS.well, []);
  if (!acts.length || !cfg.race.date) { setStatus(cfg.race.date ? "No data yet. Tap sync." : "Add your race in Settings."); return; }
  state = buildState(cfg, acts, well, todayIso());
  renderHome();
  const synced = store.get(KEYS.synced);
  const mins = synced ? Math.round((Date.now() - new Date(synced)) / 6e4) : null;
  setStatus(mins == null ? "" : `Synced ${mins < 1 ? "just now" : mins < 60 ? mins + " min ago" : new Date(synced).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" })}${fixture ? " (test data)" : ""}`);
}

function setStatus(text, err = false) { $("status").textContent = text; $("status").classList.toggle("err", err); }

// ---------- home ----------
const fmtMin = m => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? " " + String(m % 60).padStart(2, "0") + " min" : ""}` : `${m} min`);
const li = t => Object.assign(document.createElement("li"), { textContent: t });

function renderHome() {
  const s = state.sit, race = cfg.race, B = state.baselines;
  const weeks = Math.max(0, Math.round(s.weeks_to_race));
  $("race").replaceChildren(Object.assign(document.createElement("b"), { textContent: race.name || "Race" }),
    ` ${dateOf(race.date).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })} · ${weeks} weeks · ${s.phase} phase`);
  $("dayTitle").textContent = `${DAYS[dateOf(state.today).getDay()]}, ${dateOf(state.today).toLocaleDateString("en-GB", { day: "numeric", month: "long" })}`;
  const hint = (b, unit, dg = 0) => (b ? `usual ${b.mean.toFixed(dg)} ± ${b.sd.toFixed(dg ? 1 : 0)} ${unit}` : "no baseline yet");
  $("hintHrv").textContent = hint(B.hrv, "ms");
  $("hintRhr").textContent = hint(B.rhr, "bpm");
  $("hintSleep").textContent = hint(B.sleep_h, "h", 1);

  const saved = store.get("checkin-" + state.today);
  const w = state.latest;
  if (saved) {
    $("hrv").value = saved.hrv ?? ""; $("rhr").value = saved.rhr ?? ""; $("sleep").value = saved.sleep ?? "";
    feel = saved.feel || "normal"; $("sick").checked = !!saved.sick;
    $("source").textContent = "Your entries for today.";
  } else if (w) {
    $("hrv").value = w.hrv ?? ""; $("rhr").value = w.rhr ?? ""; $("sleep").value = w.sleep_h ? w.sleep_h.toFixed(1) : "";
    feel = "normal"; $("sick").checked = false;
    $("source").textContent = "Filled in from Garmin. Change anything that's off.";
  } else {
    $("hrv").value = $("rhr").value = $("sleep").value = "";
    $("source").textContent = "Last night isn't synced yet. Sync your watch, then tap ↻, or type the values from Garmin Connect.";
  }
  document.querySelectorAll(".seg button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.feel === feel)));

  $("ctl").textContent = Math.round(s.ctl);
  $("form").textContent = (s.form >= 0 ? "+" : "") + Math.round(s.form);
  $("hard7").textContent = s.hard_days_7d;
  $("loadNote").textContent = `Commutes added ${s.commute_load_7d} load in the last 7 days. ` +
    (s.form > 15 ? "You're fresh: room to build." : s.form < -20 ? "Fatigue is high: protect recovery." : "Load and recovery are balanced.");

  const byDay = {};
  state.recent.forEach(a => (byDay[a.date] ||= []).push(a));
  const rows = [];
  for (let i = 7; i >= 1; i--) {
    const k = shift(state.today, -i), d = dateOf(k), all = byDay[k] || [];
    const acts = all.filter(a => a.kind !== "commute"), commutes = all.length - acts.length;
    const label = acts.length ? acts.map(a => `${a.sport === "other" ? a.type : a.sport} ${a.kind === "other" ? "" : a.kind} · ${fmtMin(Math.round(a.dur))}`).join(", ") : "Rest";
    const row = document.createElement("div"); row.className = "row";
    row.append(Object.assign(document.createElement("span"), { className: "k", textContent: `${SHORT[d.getDay()]} ${d.getDate()}.` }),
      Object.assign(document.createElement("span"), { textContent: label + (commutes ? " + commute" : "") }),
      Object.assign(document.createElement("span"), { className: "num tag", textContent: Math.round(all.reduce((t, a) => t + a.load, 0)) }));
    rows.push(row);
  }
  $("week").replaceChildren(...rows);
  renderVerdict();
}

function renderVerdict() {
  if (!state) return;
  const inp = { hrv: $("hrv").value, rhr: $("rhr").value, sleep: $("sleep").value, feel, sick: $("sick").checked };
  const r = readiness(inp, state.baselines, state.sit.hrv_trend_z);
  for (const [k, id] of [["hrv", "dotHrv"], ["rhr", "dotRhr"], ["sleep", "dotSleep"]]) $(id).className = "dot " + (r.sig[k] || "");
  const plan = state.plans[state.today][r.level];
  $("verdict").className = "verdict " + { green: "go", amber: "easy", red: "stop" }[r.level];
  $("pill").textContent = { green: "Ready: train", amber: "Easy day", red: "Recover" }[r.level];
  $("sTitle").textContent = plan.session.title;
  $("sMeta").textContent = plan.session.sport === "rest" ? "No training"
    : `${plan.session.sport[0].toUpperCase() + plan.session.sport.slice(1)} · ${fmtMin(plan.session.minutes)}`;
  $("sSteps").replaceChildren(...plan.session.steps.map(li));
  const why = [...plan.why];
  if (r.zh != null) why.unshift(`HRV ${Math.round(inp.hrv)} ms is ${r.zh >= 0 ? "+" : ""}${r.zh.toFixed(1)} SD from your usual.`);
  $("sWhy").replaceChildren(...why.map(li));
  $("sCommute").hidden = !plan.commute;
  $("sCommute").textContent = plan.commute ? "Commute: " + plan.commute : "";
  const tomorrow = shift(state.today, 1), t = state.plans[tomorrow].green.session;
  $("tTitle").textContent = t.title;
  $("tMeta").textContent = `${DAYS[dateOf(tomorrow).getDay()]} · ${t.sport === "rest" ? "rest" : fmtMin(t.minutes)} · decided by tomorrow's check-in`;
}

function onCheckin() {
  if (!state) return;
  store.set("checkin-" + state.today, { hrv: $("hrv").value, rhr: $("rhr").value, sleep: $("sleep").value, feel, sick: $("sick").checked });
  $("source").textContent = "Your entries for today.";
  renderVerdict();
}

// ---------- settings ----------
const toPace = s => { const m = /^(\d+):(\d{1,2})$/.exec((s || "").trim()); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const fromPace = n => `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;

function openSettings(firstRun = false) {
  $("firstRun").hidden = !firstRun;
  const v = (id, val) => { $(id).value = val ?? ""; };
  v("apiKey", cfg.apiKey); v("athleteId", cfg.athleteId); v("historyStart", cfg.historyStart);
  v("raceName", cfg.race.name); v("raceDate", cfg.race.date); v("swimKm", cfg.race.swim_km); v("bikeKm", cfg.race.bike_km); v("runKm", cfg.race.run_km);
  v("ftp", cfg.ftp); v("runThr", fromPace(cfg.paces.runThr)); v("swimCss", fromPace(cfg.paces.swimCss));
  v("noRun", cfg.unavailable.run); v("noSwim", cfg.unavailable.swim); v("swimsPerWeek", cfg.swimsPerWeek);
  v("noPowerFrom", cfg.commute.noPowerFrom); v("kmMin", cfg.commute.kmMin); v("kmMax", cfg.commute.kmMax);
  v("keywords", cfg.commute.keywords.join(", "));
  $("home").hidden = true; $("settings").hidden = false;
  window.scrollTo(0, 0);
}

function closeSettings() { $("settings").hidden = true; $("home").hidden = false; }

function saveSettings(e) {
  e.preventDefault();
  const n = id => ($(id).value === "" ? null : Number($(id).value));
  const historyChanged = $("historyStart").value !== cfg.historyStart || $("apiKey").value.trim() !== cfg.apiKey;
  cfg = {
    apiKey: $("apiKey").value.trim(), athleteId: $("athleteId").value.trim() || "0",
    historyStart: $("historyStart").value || defaults().historyStart, ftp: n("ftp"),
    race: { name: $("raceName").value.trim(), date: $("raceDate").value, swim_km: n("swimKm") || 0, bike_km: n("bikeKm") || 0, run_km: n("runKm") || 0 },
    paces: { runThr: toPace($("runThr").value) || 225, swimCss: toPace($("swimCss").value) || 105 },
    unavailable: { run: $("noRun").value, swim: $("noSwim").value }, swimsPerWeek: n("swimsPerWeek") ?? 2,
    commute: { noPowerFrom: $("noPowerFrom").value, kmMin: n("kmMin") || 0, kmMax: n("kmMax") || 0,
      keywords: $("keywords").value.split(",").map(s => s.trim()).filter(Boolean) },
  };
  store.set(KEYS.settings, cfg);
  closeSettings();
  refresh(historyChanged);
}

// ---------- wiring ----------
document.querySelectorAll(".seg button").forEach(b => b.addEventListener("click", () => {
  feel = b.dataset.feel;
  document.querySelectorAll(".seg button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
  onCheckin();
}));
["hrv", "rhr", "sleep", "sick"].forEach(id => $(id).addEventListener("input", onCheckin));
$("syncBtn").addEventListener("click", () => refresh());
$("settingsBtn").addEventListener("click", () => openSettings());
$("closeSettings").addEventListener("click", closeSettings);
$("settingsForm").addEventListener("submit", saveSettings);
$("resetData").addEventListener("click", () => { closeSettings(); refresh(true); });
document.addEventListener("visibilitychange", () => {
  const synced = store.get(KEYS.synced);
  if (document.visibilityState === "visible" && cfg.apiKey && (!synced || Date.now() - new Date(synced) > 30 * 6e4)) refresh();
});

if ("serviceWorker" in navigator && !fixture) navigator.serviceWorker.register("sw.js").catch(() => {});

if (!cfg.apiKey && !fixture) openSettings(true);
else { compute(); refresh(); }
