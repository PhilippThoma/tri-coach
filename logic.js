// Coach logic: a JavaScript port of analyze.py and coach.py.
// Pure functions only. Everything works on the compact records made by compactActivity/compactWellness.
"use strict";

const SPORTS = ["swim", "bike", "run"];
const CTL_DAYS = 42, ATL_DAYS = 7, BASELINE_DAYS = 60;
const LONG_MIN = { swim: 60, bike: 150, run: 90 };
const DEFAULT_BACK = { hard: 1, long: 2, brick: 3 };
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// ---------- dates ----------
const isoOf = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const dateOf = s => { const [y, m, d] = s.slice(0, 10).split("-").map(Number); return new Date(y, m - 1, d); };
const shift = (s, n) => { const d = dateOf(s); d.setDate(d.getDate() + n); return isoOf(d); };
const daysBetween = (a, b) => Math.round((dateOf(b) - dateOf(a)) / 864e5);
const weekdayMon0 = s => (dateOf(s).getDay() + 6) % 7;
function* range(a, b) { for (let d = a; d <= b; d = shift(d, 1)) yield d; }

// ---------- stats ----------
const mean = xs => xs.reduce((t, x) => t + x, 0) / xs.length;
const pstdev = xs => { const m = mean(xs); return Math.sqrt(mean(xs.map(x => (x - m) ** 2))); };
const median = xs => { const s = [...xs].sort((a, b) => a - b), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
function q3(sorted) { // Python statistics.quantiles(n=4)[2], exclusive method
  const n = sorted.length, pos = (n + 1) * 0.75, j = Math.floor(pos), f = pos - j;
  if (j < 1) return sorted[0];
  if (j >= n) return sorted[n - 1];
  return sorted[j - 1] + f * (sorted[j] - sorted[j - 1]);
}
const num = x => (typeof x === "number" && x > 0 ? x : null);

// ---------- compact storage format ----------
function compactActivity(a) {
  return { id: a.id, s: a.start_date_local, t: a.type, n: a.name, mt: a.moving_time, et: a.elapsed_time, d: a.distance,
    l: a.icu_training_load, tr: a.trimp, i: a.icu_intensity, hr: a.average_heartrate, np: a.icu_weighted_avg_watts,
    ap: a.icu_average_watts, c: a.commute, tn: a.trainer, ftp: a.icu_ftp };
}
function compactWellness(w) {
  return { id: w.id, hrv: w.hrv, rhr: w.restingHR, ss: w.sleepSecs, sc: w.sleepScore };
}

// ---------- normalising ----------
function sportOf(type) {
  const t = (type || "").toLowerCase();
  if (t.includes("swim")) return "swim";
  if (t.includes("ride") || t.includes("bike") || t.includes("cycl")) return "bike";
  if (t.includes("run")) return "run";
  return "other";
}

function dedupe(raw) {
  const kept = [];
  const list = raw.filter(a => a.s).sort((a, b) => (a.s < b.s ? -1 : 1));
  for (const a of list) {
    const p = kept[kept.length - 1];
    if (p && sportOf(p.t) === sportOf(a.t) && sportOf(a.t) !== "other"
        && (new Date(a.s) - new Date(p.s)) / 1000 < 180
        && Math.abs((a.mt || 0) - (p.mt || 0)) < 0.1 * (p.mt || 1)) {
      const filled = o => Object.values(o).filter(v => v != null).length;
      if (filled(a) > filled(p)) kept[kept.length - 1] = a;
      continue;
    }
    kept.push(a);
  }
  return kept;
}

function normalise(raw, cfg) {
  const acts = [];
  for (const a of dedupe(raw)) {
    if (!a.s || a.s.length < 13) continue;
    const dur = (num(a.mt) || num(a.et) || 0) / 60;
    if (dur < 5) continue;
    let intensity = num(a.i);
    if (intensity && intensity > 3) intensity /= 100;
    acts.push({
      date: a.s.slice(0, 10), hour: Number(a.s.slice(11, 13)), sport: sportOf(a.t), type: a.t || "",
      indoor: !!a.tn || (a.t || "").toLowerCase().includes("virtual"), name: a.n || "",
      dur, km: (num(a.d) || 0) / 1000, load: num(a.l) || num(a.tr) || dur * 0.6, intensity,
      hr: num(a.hr), power: num(a.np) || num(a.ap), commute: !!a.c,
    });
  }
  const c = cfg.commute, kw = c.keywords.map(k => k.toLowerCase());
  for (const a of acts) {
    if (kw.some(k => k && a.name.toLowerCase().includes(k))) a.commute = true;
    else if (a.sport === "bike" && !a.power && !a.indoor)
      a.commute = a.commute || (!!c.noPowerFrom && a.date >= c.noPowerFrom) || (c.kmMax > 0 && a.km >= c.kmMin && a.km <= c.kmMax);
  }
  return acts;
}

function classify(acts) {
  for (const sport of SPORTS) {
    const rates = acts.filter(a => a.sport === sport && !a.commute && a.dur >= 20).map(a => a.load / (a.dur / 60)).sort((a, b) => a - b);
    const hardRate = rates.length >= 8 ? q3(rates) : Infinity;
    for (const a of acts) {
      if (a.sport !== sport) continue;
      const rate = a.load / (a.dur / 60);
      if (a.commute) a.kind = "commute";
      else if (a.dur >= LONG_MIN[sport]) a.kind = "long";
      else if ((a.intensity && a.intensity >= 0.85) || (a.dur >= 20 && rate >= hardRate)) a.kind = "hard";
      else a.kind = "easy";
    }
  }
  for (const a of acts) a.kind = a.kind || "other";
}

function wellnessMap(raw) {
  const out = {};
  for (const w of raw) out[w.id] = { hrv: num(w.hrv), rhr: num(w.rhr), sleep_h: num(w.ss) ? w.ss / 3600 : null, sleep_score: num(w.sc) };
  return out;
}

// ---------- daily series ----------
function dailyTable(acts, wellness, start, end) {
  const days = {};
  for (const d of range(start, end)) days[d] = { load: 0, train_load: 0, swim: 0, bike: 0, run: 0, kinds: new Set() };
  for (const a of acts) {
    const d = days[a.date];
    if (!d) continue;
    d.load += a.load;
    if (SPORTS.includes(a.sport)) d[a.sport] += a.load;
    if (a.kind !== "commute") { d.train_load += a.load; d.kinds.add(`${a.sport}-${a.kind}`); }
  }
  let ctl = 0, atl = 0;
  for (const d of Object.values(days)) {
    if (["bike-easy", "bike-hard", "bike-long"].some(k => d.kinds.has(k)) && [...d.kinds].some(k => k.startsWith("run-"))) d.kinds.add("brick");
    ctl += (d.load - ctl) / CTL_DAYS;
    atl += (d.load - atl) / ATL_DAYS;
    Object.assign(d, { ctl, atl, tsb: ctl - atl });
  }
  for (const metric of ["hrv", "rhr", "sleep_h"]) {
    for (const [day, d] of Object.entries(days)) {
      const hist = [];
      for (const x of range(shift(day, -BASELINE_DAYS), shift(day, -1))) { const v = wellness[x]?.[metric]; if (v) hist.push(v); }
      const today = wellness[day]?.[metric] ?? null;
      d[metric] = today;
      d[metric + "_z"] = today && hist.length >= 14 ? (today - mean(hist)) / (pstdev(hist) || 1e-9) : null;
    }
  }
  return days;
}

// ---------- your recovery ----------
function personalBackDays(days) {
  const groups = {};
  for (const [day, d] of Object.entries(days)) {
    const kinds = [...d.kinds];
    if (!kinds.length) continue;
    for (const k of kinds.filter(k => k.endsWith("-hard") || k.endsWith("-long") || k === "brick")) (groups[k] ||= []).push(day);
  }
  const out = {};
  for (const [kind, sessions] of Object.entries(groups)) {
    const back = [];
    for (const day of sessions) {
      let done = false;
      for (let k = 1; k <= 5; k++) {
        const pair = [days[shift(day, k)], days[shift(day, k + 1)]];
        if (!pair.every(p => p && p.hrv_z != null)) { done = true; break; }
        if (mean(pair.map(p => p.hrv_z)) >= -0.25) { back.push(k); done = true; break; }
      }
      if (!done) back.push(6);
    }
    if (back.length >= 5) out[kind] = Math.min(Math.trunc(median(back)), 4);
  }
  return out;
}

// ---------- coaching ----------
const isHard = kinds => [...kinds].some(k => k.endsWith("-hard") || k === "brick");
const phaseOf = w => (w > 16 ? "base" : w > 8 ? "build" : w > 2 ? "race-specific" : "taper");

function baseline(days, today, metric) {
  const vals = [];
  for (const d of range(shift(today, -60), shift(today, -1))) if (days[d]?.[metric]) vals.push(days[d][metric]);
  return vals.length < 14 ? null : { mean: mean(vals), sd: pstdev(vals) || 1, n: vals.length };
}

function situation(cfg, acts, days, today) {
  const weeks = daysBetween(today, cfg.race.date) / 7;
  const yday = shift(today, -1), dy = days[yday];
  const lastWeek = [1, 2, 3, 4, 5, 6, 7].map(i => shift(today, -i));
  const keySessions = [];
  for (const d of lastWeek) for (const k of [...days[d].kinds].sort())
    if (k.endsWith("-hard") || k.endsWith("-long") || k === "brick") keySessions.push({ date: d, kind: k });
  const lastHard = {};
  const sorted = Object.keys(days).sort().reverse();
  for (const s of SPORTS) lastHard[s] = sorted.find(d => d < today && (days[d].kinds.has(`${s}-hard`) || days[d].kinds.has(`${s}-long`))) || null;
  const monday = shift(today, -weekdayMon0(today));
  const hrv7 = lastWeek.map(d => days[d].hrv_z).filter(z => z != null);
  return {
    today, weeks_to_race: weeks, phase: phaseOf(weeks), ctl: dy.ctl, atl: dy.atl, form: dy.tsb,
    ramp_7d: dy.ctl - days[shift(yday, -7)].ctl,
    hard_days_7d: lastWeek.filter(d => isHard(days[d].kinds)).length,
    rest_days_7d: lastWeek.filter(d => days[d].train_load === 0).length,
    key_sessions_7d: keySessions, last_hard: lastHard,
    swims_this_week: acts.filter(a => a.sport === "swim" && a.date >= monday && a.date < today).length,
    commute_load_7d: Math.round(acts.filter(a => a.commute && lastWeek.includes(a.date)).reduce((t, a) => t + a.load, 0)),
    hrv_trend_z: hrv7.length >= 4 ? mean(hrv7) : null,
  };
}

const pace = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

function zones(cfg, ftp) {
  const w = (lo, hi) => `${Math.round(ftp * lo / 5) * 5}–${Math.round(ftp * hi / 5) * 5} W`;
  const t = cfg.paces.runThr, css = cfg.paces.swimCss;
  return { ftp, z2: w(0.60, 0.72), ss: w(0.88, 0.92), thr: w(0.96, 1.0), race: w(0.78, 0.83),
    run_easy: `${pace(t * 1.25)}–${pace(t * 1.38)}/km`, run_thr: `${pace(t)}–${pace(t * 1.03)}/km`,
    run_tempo: `${pace(t * 1.06)}–${pace(t * 1.09)}/km`, swim_css: `${pace(css)}/100 m`, swim_easy: `${pace(css + 12)}/100 m` };
}

function session(z, sport, kind, ph, minutes) {
  if (kind === "rest") return { sport: "rest", title: "Rest day", minutes: 0,
    steps: ["No training. A walk or 15 min of mobility is fine.", "Ride the commute home very easy."] };
  if (sport === "bike") {
    if (kind === "recovery") { const m = minutes || 45;
      return { sport, title: "Recovery spin", minutes: m, steps: [`${m} min very easy, under ${z.z2.split("–")[0]} W`, "High cadence (90+), no efforts."] }; }
    if (kind === "endurance") { const m = minutes || 75;
      return { sport, title: "Endurance ride", minutes: m, steps: [`${m} min at ${z.z2}`, "Include 6×1 min at 100–110 rpm (same power) for pedalling technique."] }; }
    if (kind === "long") { const m = minutes || 180;
      return { sport, title: "Long ride", minutes: m, steps: [`${Math.floor(m / 60)}–${Math.floor(m / 60) + 1} h at ${z.z2}, outside or ${Math.min(m, 120)} min indoors`,
        "Eat 70–80 g carbs per hour from the first 30 min: race fuelling practice.", "Climb at most 10–15 % above endurance power."] }; }
    if (ph === "base") return { sport, title: "Sweet spot intervals", minutes: 75, steps: ["15 min warm-up, building",
      `3×12 min at ${z.ss}, 5 min easy between`, "Cadence 88–95, aim for steady power", "10 min easy", "60–80 g carbs/h for gut training"] };
    return { sport, title: "Race-power blocks", minutes: 90, steps: ["15 min warm-up", `2×25 min at ${z.race}, as steady as possible (VI under 1.05)`,
      "5 min easy between", "Then 10 min easy", "Fuel exactly as on race day"] };
  }
  if (sport === "run") {
    if (kind === "recovery" || kind === "endurance") { const m = minutes || (kind === "recovery" ? 30 : 50);
      return { sport, title: kind === "endurance" ? "Easy run" : "Short easy run", minutes: m, steps: [`${m} min at ${z.run_easy} (or HR under ~150)`,
        kind === "endurance" ? "Finish with 4–6×20 s strides, cadence focus (~168 spm)" : "Keep it relaxed."] }; }
    if (kind === "long") { const m = minutes || 90;
      return { sport, title: "Long run", minutes: m, steps: [`${m} min at ${z.run_easy}`, "Last 15 min may drift to steady, never hard",
        "Practise drinking and a gel after 45 min"] }; }
    if (ph === "base") return { sport, title: "Threshold intervals", minutes: 60, steps: ["15 min easy + 4 strides",
      `6×3 min at ${z.run_thr}, 90 s jog between`, "10–15 min easy"] };
    return { sport, title: "Tempo run", minutes: 65, steps: ["15 min easy", `2×15 min at ${z.run_tempo}, 3 min jog`, "10 min easy"] };
  }
  if (sport === "swim") {
    if (kind === "quality") return { sport, title: "Swim: race-pace set", minutes: 50, steps: ["300 m easy + 4×50 m drills (catch-up, single-arm)",
      `10×100 m at ${z.swim_css}, 15 s rest`, "200 m easy, counting strokes per length"] };
    return { sport, title: "Swim: technique", minutes: 40, steps: ["300 m easy", "8×50 m drills (catch-up, fingertip drag, single-arm), 15 s rest",
      `6×100 m at ${z.swim_easy}, focus on long strokes`, "100 m easy"] };
  }
  return session(z, "bike", "recovery", ph);
}

function planDay(cfg, z, sit, date, level, extraKey, back) {
  const why = [], wd = weekdayMon0(date), ph = sit.phase;
  const can = Object.fromEntries(SPORTS.map(s => [s, !cfg.unavailable[s] || date >= cfg.unavailable[s]]));
  const blocked = SPORTS.filter(s => !can[s]);
  if (blocked.length) why.push(`No ${blocked.join(" / ")} yet (injury pause).`);

  const keys = [...sit.key_sessions_7d, ...(extraKey ? [extraKey] : [])];
  const noHard = [];
  for (const k of keys) {
    const need = back[k.kind] || DEFAULT_BACK[k.kind === "brick" ? "brick" : k.kind.split("-")[1]];
    const gap = daysBetween(k.date, date);
    if (gap <= need) noHard.push(`Your ${k.kind.replace("-", " ")} on ${WEEKDAYS[weekdayMon0(k.date)]} usually needs ${need} day${need > 1 ? "s" : ""} to recover.`);
  }
  const hardDays = sit.hard_days_7d + (extraKey && extraKey.hard ? 1 : 0);
  if (hardDays >= 3) noHard.push(`Already ${hardDays} hard days in the last 7. More than that tipped you over in the past.`);
  if (sit.form < -20) noHard.push(`Fatigue is high (form ${Math.round(sit.form)}).`);
  if (sit.ramp_7d > 6) noHard.push(`Load rose fast this week (+${Math.round(sit.ramp_7d)} fitness).`);

  const pick = (kind, prefs, minutes) => { for (const s of prefs) if (can[s]) return session(z, s, kind, ph, minutes); return session(z, "bike", "recovery", ph); };
  const swimDue = can.swim && sit.swims_this_week < cfg.swimsPerWeek;
  const out = (s, commute) => ({ level, session: s, why, commute: wd >= 5 ? "" : commute });

  if (level === "red") {
    why.unshift("Your body shows clear stress (HRV, resting HR, sleep or how you feel).");
    const s = sit.rest_days_7d === 0 || wd === 0 || wd === 4 ? session(z, "rest", "rest", ph) : pick("recovery", ["bike", "swim"], 40);
    return out(s, "Ride home very easy, or take the train.");
  }
  if (level === "amber") {
    why.unshift("Recovery is not complete: easy training only today.");
    let s;
    if (wd === 5) { s = pick("long", ["bike"], 120); s.title = "Shortened long ride"; }
    else if (swimDue) s = pick("endurance", ["swim"]);
    else s = pick("endurance", ["bike", "run"], 60);
    return out(s, "Ride home easy, no ramp efforts.");
  }
  if (wd === 0 && sit.rest_days_7d === 0) { why.push("No rest day in the last week. Monday is a good one."); return out(session(z, "rest", "rest", ph), "Ride home easy."); }
  if (wd === 5 && can.bike) { why.push("Weekend long ride: the base for 80 km at race power."); return out(pick("long", ["bike"]), ""); }
  if (wd === 6) {
    if (can.run && !noHard.length) { why.push("The long run builds durability for the run off the bike."); return out(pick("long", ["run"], 80), ""); }
    why.push(...noHard);
    return out(pick("endurance", ["swim", "bike", "run"], 75), "");
  }
  if (noHard.length) {
    why.push(...noHard);
    if (swimDue) { why.push("A swim fits well: it trains your weakest discipline and spares your legs."); return out(pick("endurance", ["swim"]), "Ride home easy."); }
    return out(pick("endurance", ["bike", "run"]), "Ride home easy.");
  }
  const since = s => (sit.last_hard[s] ? daysBetween(sit.last_hard[s], date) : 99);
  const order = ["bike", "run"].filter(s => can[s]).sort((a, b) => since(b) - since(a));
  if (order.length) {
    const sport = order[0];
    why.push(`You're recovered and your last hard ${sport} session was ${since(sport)} days ago.`);
    return out(session(z, sport, "quality", ph), sport === "bike"
      ? "Alternative: skip the indoor session and do 4–6 hard ramps on the way home instead."
      : "This session is your hard work. Ride home easy.");
  }
  if (can.swim) { why.push("Running and cycling are off, so a hard swim is today's quality."); return out(session(z, "swim", "quality", ph), "Ride home easy."); }
  return out(session(z, "bike", "endurance", ph), "Ride home easy.");
}

// Everything the screen needs, for today and tomorrow at every readiness level.
function buildState(cfg, rawActs, rawWell, today) {
  const acts = normalise(rawActs, cfg);
  classify(acts);
  const wellness = wellnessMap(rawWell);
  const firstAct = acts.reduce((m, a) => (a.date < m ? a.date : m), today);
  const start = firstAct > cfg.historyStart ? firstAct : cfg.historyStart;
  const end = [today, ...acts.map(a => a.date), ...Object.keys(wellness)].sort().pop();
  const days = dailyTable(acts, wellness, start, end);
  const back = personalBackDays(days);
  const sit = situation(cfg, acts, days, today);
  const ftp = cfg.ftp || [...rawActs].sort((a, b) => (a.s < b.s ? -1 : 1)).reverse().find(a => a.ftp)?.ftp || 250;
  const z = zones(cfg, ftp);

  const plans = {};
  const tomorrow = shift(today, 1);
  for (const date of [today, tomorrow]) {
    plans[date] = {};
    for (const level of ["green", "amber", "red"]) {
      let extra = null;
      if (date === tomorrow) {
        const s0 = plans[today].green.session, t = s0.title.toLowerCase();
        if (/interval|blocks|tempo|race-pace/.test(t) || t.startsWith("long")) {
          const kind = `${s0.sport}-${t.startsWith("long") ? "long" : "hard"}`;
          extra = { date: today, kind, hard: kind.endsWith("-hard") };
        }
      }
      plans[date][level] = planDay(cfg, z, sit, date, level, extra, back);
    }
  }
  const latest = wellness[today] && (wellness[today].hrv || wellness[today].rhr) ? { date: today, ...wellness[today] } : null;
  const recent = acts.filter(a => a.date >= shift(today, -7));
  return { today, sit, plans, back, zones: z, latest, recent,
    baselines: { hrv: baseline(days, today, "hrv"), rhr: baseline(days, today, "rhr"), sleep_h: baseline(days, today, "sleep_h") } };
}

// Morning readiness from the check-in.
function readiness(inp, B, trend) {
  const z = (v, b) => (v === "" || v == null || !b ? null : (Number(v) - b.mean) / b.sd);
  const zh = z(inp.hrv, B.hrv), zr = z(inp.rhr, B.rhr);
  const sleep = inp.sleep === "" || inp.sleep == null ? null : Number(inp.sleep);
  const sig = {
    hrv: zh == null ? null : zh <= -1.5 ? "stop" : zh <= -0.75 ? "easy" : "go",
    rhr: zr == null ? null : zr >= 1.5 ? "stop" : zr >= 1 ? "easy" : "go",
    sleep: sleep == null ? null : sleep < 5.5 ? "stop" : sleep < 6.5 ? "easy" : "go",
  };
  let level = "green";
  if (inp.sick || (zh != null && zh <= -1.5) || (zh != null && zr != null && zh <= -1 && zr >= 1)
      || (inp.feel === "tired" && zh != null && zh <= -1)) level = "red";
  else if ((zh != null && zh <= -0.75) || (zr != null && zr >= 1) || (sleep != null && sleep < 6.5)
      || inp.feel === "tired" || (trend != null && trend <= -0.75 && zh != null && zh < 0)) level = "amber";
  return { level, sig, zh, zr };
}

if (typeof module !== "undefined") module.exports = { buildState, readiness, compactActivity, compactWellness, isoOf, shift };
