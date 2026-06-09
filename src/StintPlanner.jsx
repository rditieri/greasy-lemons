import { useState, useEffect, useCallback, useRef } from "react";
import { doc, onSnapshot, setDoc, updateDoc } from "firebase/firestore";
import { db } from "./firebase";

const RACE_DOC = "current"; // Firestore document ID — one per race weekend
const FUEL_RESERVE_GAL = 3.0; // corner fuel cut at ~3 gal remaining

// ─── time helpers ─────────────────────────────────────────────────────────────

function toMins(str) {
  if (!str) return 0;
  const [h, m] = str.split(":").map(Number);
  return h * 60 + (m || 0);
}

function toTimeStr(totalMins) {
  const n = ((totalMins % 1440) + 1440) % 1440;
  const h24 = Math.floor(n / 60);
  const m   = Math.round(n % 60);
  const ampm = h24 >= 12 ? "pm" : "am";
  const h12  = h24 % 12 || 12;
  return `${h12}:${String(m).padStart(2, "0")}${ampm}`;
}

// For <input type="time"> — needs "HH:MM" 24-hour format
function toTimeInput(totalMins) {
  const n = ((totalMins % 1440) + 1440) % 1440;
  const h = Math.floor(n / 60);
  const m = Math.round(n % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function durStr(mins) {
  if (mins == null) return "—";
  const abs = Math.abs(mins);
  const h = Math.floor(abs / 60), m = Math.round(abs % 60);
  const sign = mins < 0 ? "-" : "";
  return h === 0 ? `${sign}${m}m` : m === 0 ? `${sign}${h}h` : `${sign}${h}h ${m}m`;
}

// Parses "1:35" → 95 seconds
function parseLapTime(str) {
  if (!str) return 95;
  const parts = String(str).split(":").map(s => parseInt(s, 10));
  if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) return parts[0] * 60 + parts[1];
  if (parts.length === 1 && !isNaN(parts[0])) return parts[0];
  return 95;
}

function fmtSecs(s) {
  const abs = Math.abs(s);
  const m = Math.floor(abs / 60), sec = Math.round(abs % 60);
  const sign = s < 0 ? "-" : "";
  return m === 0 ? `${sign}${sec}s` : `${sign}${m}:${String(sec).padStart(2, "0")}`;
}

// ─── FCY math ─────────────────────────────────────────────────────────────────

function calcFCYSavings(fcyEvents, greenBurnGalPerHr, fcyPctOfGreen) {
  if (!fcyEvents?.length || !greenBurnGalPerHr || !fcyPctOfGreen)
    return { totalFCYMins: 0, fuelSavedGal: 0, extraMins: 0 };
  const fcyRate = greenBurnGalPerHr * (fcyPctOfGreen / 100);
  const totalFCYMins = fcyEvents.reduce((a, e) => a + e.durationMins, 0);
  const fuelSavedGal = (greenBurnGalPerHr - fcyRate) * (totalFCYMins / 60);
  const extraMins = Math.floor((fuelSavedGal / greenBurnGalPerHr) * 60);
  return { totalFCYMins, fuelSavedGal, extraMins };
}

// ─── FuelMaxing tradeoff ──────────────────────────────────────────────────────
// Reference: 15 laps at 12 sec/lap (aggressive) ≈ 20 min extension (empirical).
// Conservative mode: 5 sec/lap, proportionally more laps.

function calcFuelMaxTradeoff(extensionPerStint, numStints, targetPaceStr) {
  if (!extensionPerStint || !numStints) return null;
  const targetPaceSecs = parseLapTime(targetPaceStr || "1:35");

  const REF_LAPS = 15, REF_EXT = 20, AGG = 12, CON = 5;

  const lapsAgg = Math.ceil((extensionPerStint / REF_EXT) * REF_LAPS);
  const lapsCon = Math.ceil(lapsAgg * (AGG / CON));

  const costAggTotal = lapsAgg * AGG * numStints;   // seconds
  const costConTotal = lapsCon * CON * numStints;    // seconds

  // How many minutes of racing are affected
  const raceMinsAgg = Math.round((lapsAgg * targetPaceSecs) / 60);
  const raceMinsCon = Math.round((lapsCon * targetPaceSecs) / 60);

  const pitCost = 300; // 5 min stop

  return {
    lapsAgg, lapsCon,
    costAggTotal, costConTotal,
    raceMinsAgg, raceMinsCon,
    pitCost,
    aggWins: costAggTotal < pitCost,
    conWins: costConTotal < pitCost,
  };
}

// ─── stint generation ─────────────────────────────────────────────────────────

function generateStints({ raceStartMins, raceEndMins, drivers, stintLengthMins, pitTimeMins }) {
  if (raceEndMins <= raceStartMins || !drivers.length || stintLengthMins < 5) return [];
  const stints = [];
  let cursor = raceStartMins, dIdx = 0, id = 1;
  while (cursor < raceEndMins) {
    const remaining = raceEndMins - cursor;
    const planned = Math.min(stintLengthMins, remaining);
    const isLast = cursor + planned >= raceEndMins;
    stints.push({
      id, driver: drivers[dIdx % drivers.length],
      plannedStart: cursor, plannedEnd: cursor + planned,
      plannedDuration: planned,
      actualStart: null, actualEnd: null, fuelAdded: null, note: "",
      fcyEvents: [], isLast,
    });
    cursor += planned + (isLast ? 0 : pitTimeMins);
    dIdx++; id++;
  }
  return stints;
}

// Even mode: same number of stints as Optimized, but drive time split equally.
// Every driver gets the same stint length — no short last stint.
function generateStintsEven({ raceStartMins, raceEndMins, drivers, stintLengthMins, pitTimeMins }) {
  const base = generateStints({ raceStartMins, raceEndMins, drivers, stintLengthMins, pitTimeMins });
  const n = base.length;
  if (n === 0) return [];
  const totalRaceMins = raceEndMins - raceStartMins;
  const evenDuration  = Math.round((totalRaceMins - (n - 1) * pitTimeMins) / n);
  return generateStints({ raceStartMins, raceEndMins, drivers, stintLengthMins: evenDuration, pitTimeMins });
}

function regenFrom(stints, fromIdx, config) {
  const { raceEndMins, drivers, stintLengthMins, pitTimeMins } = config;
  const kept = stints.slice(0, fromIdx + 1);
  const anchor = kept[fromIdx];
  const nextStart = (anchor.actualEnd ?? anchor.plannedEnd) + pitTimeMins;
  if (nextStart >= raceEndMins) return kept.map((s, i) => ({ ...s, isLast: i === fromIdx }));
  const fresh = generateStints({ raceStartMins: nextStart, raceEndMins, drivers, stintLengthMins, pitTimeMins });
  const renumbered = fresh.map((s, i) => ({
    ...s, id: fromIdx + 2 + i,
    driver: drivers[(fromIdx + 1 + i) % drivers.length],
  }));
  return [...kept.map(s => ({ ...s, isLast: false })), ...renumbered];
}

// ─── pit-stop savings suggestion ──────────────────────────────────────────────

function findSavingSuggestion(config) {
  const base = generateStints(config);
  if (base.length <= 1) return null;
  for (let ext = 1; ext <= 25; ext++) {
    const trial = generateStints({ ...config, stintLengthMins: config.stintLengthMins + ext });
    if (trial.length < base.length) {
      const newLength = config.stintLengthMins + ext;
      const burn = parseFloat(config.burnGalPerHr) || null;
      const tank = parseFloat(config.tankGal) || null;
      const extraFuelGal = burn ? ((ext / 60) * burn).toFixed(2) : null;
      const fuelNeeded = burn ? (newLength / 60) * burn : null;
      const usable = tank ? tank - FUEL_RESERVE_GAL : null;
      const exceedsTank = fuelNeeded != null && usable != null ? fuelNeeded > usable : false;
      return {
        extensionPerStint: ext,
        currentStints: base.length, newStints: trial.length,
        timeSavedMins: config.pitTimeMins,
        extraFuelGal, exceedsTank, newStintLength: newLength,
        newLastStintDuration: trial[trial.length - 1]?.plannedDuration ?? null,
      };
    }
  }
  return null;
}

// ─── fuel & flex helpers ──────────────────────────────────────────────────────

function calcFuelRange(tankGal, burnGalPerHr) {
  if (!tankGal || !burnGalPerHr) return null;
  return Math.floor(((tankGal - FUEL_RESERVE_GAL) / burnGalPerHr) * 60);
}

function calcFlex(plannedDuration, tankGal, burnGalPerHr, stintLengthMins) {
  const maxMins = calcFuelRange(parseFloat(tankGal), parseFloat(burnGalPerHr)) ?? stintLengthMins;
  return Math.max(0, maxMins - plannedDuration);
}

// ─── colors ───────────────────────────────────────────────────────────────────

const PALETTE = ["#e63946", "#f4a261", "#2a9d8f", "#457b9d", "#e9c46a", "#a8dadc", "#f77f00"];
function driverColor(name, drivers) {
  const idx = drivers.indexOf(name);
  return PALETTE[idx >= 0 ? idx % PALETTE.length : 0];
}

// ─── shared UI atoms ──────────────────────────────────────────────────────────

function Label({ children }) {
  return <div style={{ fontSize: 12, color: "#aaa", letterSpacing: "0.08em", marginBottom: 6, textTransform: "uppercase" }}>{children}</div>;
}

function SI({ value, onChange, type = "text", placeholder, min, max, style = {} }) {
  return (
    <input type={type} value={value} onChange={onChange} placeholder={placeholder} min={min} max={max} style={{
      width: "100%", background: "#2a2a2a", border: "1.5px solid #444",
      borderRadius: 6, color: "#f0f0f0", padding: "10px 12px",
      fontSize: 16, fontFamily: "'IBM Plex Mono', monospace", ...style,
    }} />
  );
}

function Card({ children, style = {} }) {
  return (
    <div style={{
      background: "#1c1c1c", border: "1px solid #2e2e2e",
      borderRadius: 10, padding: 16, marginBottom: 14, ...style,
    }}>{children}</div>
  );
}

function Btn({ onClick, children, variant = "default", disabled, style = {} }) {
  const t = {
    red:     { background: "#e63946", border: "none", color: "#fff" },
    amber:   { background: "#b45309", border: "none", color: "#fff" },
    yellow:  { background: "#854d0e", border: "none", color: "#fde68a" },
    ghost:   { background: "transparent", border: "1.5px solid #555", color: "#f0f0f0" },
    default: { background: "#2a2a2a", border: "1.5px solid #555", color: "#f0f0f0" },
  };
  return (
    <button onClick={onClick} disabled={disabled} style={{
      ...(t[variant] ?? t.default), borderRadius: 6, padding: "8px 14px",
      fontSize: 13, fontFamily: "'IBM Plex Mono', monospace",
      cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.4 : 1,
      letterSpacing: "0.05em", ...style,
    }}>{children}</button>
  );
}

// ─── Flex Badge ───────────────────────────────────────────────────────────────

function FlexBadge({ flexMins }) {
  if (flexMins <= 0) return (
    <span style={{ fontSize: 12, color: "#aaa", letterSpacing: "0.05em" }}>FULL STINT</span>
  );
  const [bg, fg] = flexMins >= 20 ? ["#14532d", "#4ade80"] : flexMins >= 10 ? ["#451a03", "#fbbf24"] : ["#450a0a", "#f87171"];
  const label = flexMins >= 20 ? "wide window" : flexMins >= 10 ? "moderate" : "tight";
  return (
    <span style={{
      fontSize: 12, color: fg, background: bg,
      borderRadius: 4, padding: "3px 9px", letterSpacing: "0.05em", fontWeight: 700,
    }}>
      FLEX +{flexMins}m — {label}
    </span>
  );
}

// ─── FCY Logger ───────────────────────────────────────────────────────────────

function FCYLogger({ stint, idx, stints, saveStints, greenBurnGalPerHr, fcyPctOfGreen, config }) {
  const [open, setOpen] = useState(false);
  const [durInput, setDurInput] = useState("");

  const canLog = greenBurnGalPerHr && fcyPctOfGreen;
  const savings = calcFCYSavings(stint.fcyEvents, parseFloat(greenBurnGalPerHr), parseFloat(fcyPctOfGreen));

  const logFCY = () => {
    const mins = parseInt(durInput, 10);
    if (!mins || mins <= 0) return;
    const updated = stints.map((s, i) => i === idx
      ? { ...s, fcyEvents: [...s.fcyEvents, { durationMins: mins, loggedAt: new Date().toLocaleTimeString() }] }
      : s);
    saveStints(updated);
    setDurInput(""); setOpen(false);
  };

  const removeFCY = (eIdx) => {
    const updated = stints.map((s, i) => i === idx
      ? { ...s, fcyEvents: s.fcyEvents.filter((_, j) => j !== eIdx) }
      : s);
    saveStints(updated);
  };

  const applyExtension = () => {
    if (!savings.extraMins) return;
    const newEnd = (stint.actualEnd ?? stint.plannedEnd) + savings.extraMins;
    const updated = stints.map((s, i) => i === idx
      ? { ...s, actualEnd: newEnd, plannedEnd: newEnd, plannedDuration: newEnd - (stint.actualStart ?? stint.plannedStart) }
      : s);
    saveStints(regenFrom(updated, idx, config));
  };

  if (!canLog) return null;

  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid #2e2e2e" }}>
      {stint.fcyEvents.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          {stint.fcyEvents.map((e, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, fontSize: 13, color: "#f0f0f0" }}>
              <span style={{ color: "#fde68a" }}>🟡</span>
              <span>FCY {i + 1}: <strong>{e.durationMins} min</strong></span>
              {e.loggedAt && <span style={{ color: "#aaa" }}>@ {e.loggedAt}</span>}
              <button onClick={() => removeFCY(i)} style={{ background: "none", border: "none", color: "#aaa", fontSize: 14, cursor: "pointer", marginLeft: "auto", padding: 0 }}>✕</button>
            </div>
          ))}
        </div>
      )}
      {savings.extraMins > 0 && (
        <div style={{ background: "#1f1a00", border: "1.5px solid #854d0e", borderLeft: "4px solid #fbbf24", borderRadius: 6, padding: "12px 14px", marginBottom: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#fbbf24", letterSpacing: "0.08em", marginBottom: 8 }}>🟡 FCY FUEL BANK</div>
          <div style={{ fontSize: 14, color: "#f0f0f0", lineHeight: 1.75, marginBottom: 12 }}>
            {savings.totalFCYMins} min under yellow saved{" "}
            <strong style={{ color: "#fde68a" }}>~{savings.fuelSavedGal.toFixed(2)} gal</strong>
            {" "}→ driver can stay out{" "}
            <strong style={{ color: "#fde68a" }}>~{savings.extraMins} min longer</strong>
          </div>
          <Btn variant="yellow" onClick={applyExtension}>
            APPLY +{savings.extraMins}m EXTENSION
          </Btn>
        </div>
      )}
      {!open ? (
        <button onClick={() => setOpen(true)} style={{
          background: "#1f1a00", border: "1.5px solid #854d0e",
          borderRadius: 6, padding: "10px 14px", fontSize: 13, color: "#fbbf24",
          fontFamily: "'IBM Plex Mono', monospace", cursor: "pointer", letterSpacing: "0.05em", fontWeight: 700,
        }}>🟡 LOG FULL COURSE YELLOW</button>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, color: "#f0f0f0" }}>FCY duration:</span>
          <input type="number" value={durInput} min={1} max={180}
            onChange={e => setDurInput(e.target.value)}
            onKeyDown={e => e.key === "Enter" && logFCY()}
            placeholder="min" autoFocus
            style={{ width: 80, background: "#2a2a2a", border: "1.5px solid #fbbf24", borderRadius: 5, color: "#fde68a", padding: "8px 10px", fontSize: 15, fontFamily: "'IBM Plex Mono', monospace" }}
          />
          <span style={{ fontSize: 13, color: "#f0f0f0" }}>min</span>
          <Btn variant="yellow" onClick={logFCY}>LOG IT</Btn>
          <button onClick={() => { setOpen(false); setDurInput(""); }} style={{ background: "none", border: "none", color: "#aaa", fontSize: 16, cursor: "pointer" }}>✕</button>
        </div>
      )}
    </div>
  );
}

// ─── Suggestion Banner (with FuelMaxing tradeoff) ─────────────────────────────

function SuggestionBanner({ suggestion, onApply, targetPace }) {
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => setDismissed(false), [suggestion]);
  if (!suggestion || dismissed) return null;

  const { extensionPerStint, currentStints, newStints, timeSavedMins,
          extraFuelGal, exceedsTank, newStintLength, newLastStintDuration } = suggestion;
  const accent = exceedsTank ? "#dc2626" : "#f59e0b";

  const fm = exceedsTank ? null : calcFuelMaxTradeoff(extensionPerStint, newStints, targetPace);

  return (
    <div style={{
      background: exceedsTank ? "#1a0505" : "#1f1700",
      border: `1.5px solid ${exceedsTank ? "#7f1d1d" : "#f59e0b"}`,
      borderLeft: `5px solid ${accent}`, borderRadius: 8, padding: "16px", marginBottom: 14,
    }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8, marginBottom: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.1em", color: accent, textTransform: "uppercase" }}>
          {exceedsTank ? "⚠ Fuel warning — stop reduction not feasible" : "💡 Pit stop savings opportunity"}
        </div>
        <button onClick={() => setDismissed(true)} style={{ background: "none", border: "none", color: "#aaa", fontSize: 18, cursor: "pointer", padding: 0, lineHeight: 1 }}>✕</button>
      </div>

      <div style={{ fontSize: 14, color: "#f0f0f0", lineHeight: 1.8, marginBottom: 12 }}>
        {exceedsTank ? (
          <>Extending stints by <strong style={{ color: "#f87171" }}>{extensionPerStint} min</strong> each would eliminate a pit stop but needs ~<strong style={{ color: "#f87171" }}>{extraFuelGal} gal more per stint</strong> — beyond usable tank. Not achievable on green-flag pace.</>
        ) : (
          <>Extending each stint by <strong style={{ color: "#fbbf24" }}>{extensionPerStint} min</strong> drops from <strong style={{ color: "#fbbf24" }}>{currentStints} → {newStints} stints</strong>, saving <strong style={{ color: "#fbbf24" }}>{timeSavedMins} min</strong> of pit time. New stint: <strong style={{ color: "#fbbf24" }}>{newStintLength} min</strong>.{newLastStintDuration != null && newLastStintDuration < newStintLength && <> Final stint: <strong style={{ color: "#fbbf24" }}>{newLastStintDuration} min</strong>.</>}{extraFuelGal && <> Each stop needs ~<strong style={{ color: "#fbbf24" }}>{extraFuelGal} gal more</strong> — verify against tank.</>}</>
        )}
      </div>

      {/* FuelMaxing tradeoff */}
      {fm && (
        <div style={{ background: "#1c1c1c", border: "1px solid #333", borderRadius: 6, padding: "12px 14px", marginBottom: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#a78bfa", letterSpacing: "0.1em", marginBottom: 10, textTransform: "uppercase" }}>⚡ FuelMax alternative</div>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 10, marginBottom: 10 }}>
            {[
              { label: "Conservative (-5 s/lap)", laps: fm.lapsCon, cost: fm.costConTotal, mins: fm.raceMinsCon, wins: fm.conWins },
              { label: "Aggressive (-12 s/lap)",  laps: fm.lapsAgg, cost: fm.costAggTotal, mins: fm.raceMinsAgg, wins: fm.aggWins },
            ].map(({ label, laps, cost, mins, wins }) => (
              <div key={label} style={{ background: wins ? "#14532d" : "#450a0a", border: `1.5px solid ${wins ? "#166534" : "#7f1d1d"}`, borderRadius: 6, padding: "10px 12px" }}>
                <div style={{ fontSize: 12, color: wins ? "#86efac" : "#fca5a5", letterSpacing: "0.06em", marginBottom: 6, textTransform: "uppercase" }}>{label}</div>
                <div style={{ fontSize: 16, color: wins ? "#4ade80" : "#f87171", fontWeight: 700 }}>
                  {fmtSecs(cost)} total
                </div>
                <div style={{ fontSize: 12, color: wins ? "#86efac" : "#fca5a5", marginTop: 4 }}>
                  {laps} laps/stint · {mins} min of racing
                </div>
                <div style={{ fontSize: 12, color: wins ? "#4ade80" : "#f87171", marginTop: 4 }}>
                  {wins ? `✓ ${fmtSecs(fm.pitCost - cost)} faster than pitting` : `✗ ${fmtSecs(cost - fm.pitCost)} slower than pitting`}
                </div>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 12, color: "#aaa" }}>Pit stop cost: {fmtSecs(fm.pitCost)} · Across {newStints} stints · Target pace {targetPace ?? "1:35"}/lap</div>
        </div>
      )}

      {!exceedsTank && <Btn variant="amber" onClick={onApply} style={{ width: "100%", padding: "13px", fontSize: 14 }}>APPLY — REBUILD WITH {newStintLength}-MIN STINTS</Btn>}
    </div>
  );
}

// ─── StintRow ─────────────────────────────────────────────────────────────────

function StintRow({ stint, idx, drivers, stints, saveStints, removeStint, config, nowMins }) {
  const [editingName, setEditingName]   = useState(false);
  const [nameInput, setNameInput]       = useState(stint.driver);
  const [editing, setEditing]           = useState(false);
  const [editVals, setEditVals]         = useState({});
  const [editingPlan, setEditingPlan]   = useState(false);
  const [planVals, setPlanVals]         = useState({});
  const nameRef = useRef(null);

  const color = driverColor(stint.driver, drivers);
  const displayStart = toTimeStr(stint.actualStart ?? stint.plannedStart);
  const displayEnd   = toTimeStr(stint.actualEnd   ?? stint.plannedEnd);
  const displayDur   = durStr((stint.actualEnd ?? stint.plannedEnd) - (stint.actualStart ?? stint.plannedStart));
  const isActive = nowMins != null && nowMins >= (stint.actualStart ?? stint.plannedStart) && nowMins < (stint.actualEnd ?? stint.plannedEnd);
  const isPast   = nowMins != null && nowMins >= (stint.actualEnd ?? stint.plannedEnd);

  const hotPitTime = toTimeStr((stint.actualEnd ?? stint.plannedEnd) - 10);
  const flexMins   = calcFlex(stint.plannedDuration, config.tankGal, config.burnGalPerHr, config.stintLengthMins);

  // ── driver name edit ──
  const saveName = () => {
    const n = nameInput.trim();
    if (n && n !== stint.driver) {
      saveStints(stints.map((s, i) => i === idx ? { ...s, driver: n } : s));
    }
    setEditingName(false);
  };

  useEffect(() => { if (editingName) nameRef.current?.focus(); }, [editingName]);

  // ── stint edit ──
  const openEdit = () => {
    setEditVals({
      actualStart:      stint.actualStart      != null ? toTimeStr(stint.actualStart) : "",
      actualEnd:        stint.actualEnd        != null ? toTimeStr(stint.actualEnd)   : "",
      fuelAdded:        stint.fuelAdded        != null ? String(stint.fuelAdded)      : "",
      durationOverride: stint.durationOverride != null ? String(stint.durationOverride) : "",
      note: stint.note || "",
    });
    setEditing(true);
  };

  const saveEdit = () => {
    const aStart      = editVals.actualStart      ? toMins(editVals.actualStart) : null;
    const aEnd        = editVals.actualEnd        ? toMins(editVals.actualEnd)   : null;
    const fuel        = editVals.fuelAdded        ? parseFloat(editVals.fuelAdded) : null;
    const durOverride = editVals.durationOverride ? parseInt(editVals.durationOverride, 10) : null;
    const base = aStart ?? stint.actualStart ?? stint.plannedStart;
    const updated = stints.map((s, i) => i === idx ? {
      ...s,
      actualStart: aStart,
      actualEnd: aEnd,
      fuelAdded: fuel,
      note: editVals.note,
      durationOverride: durOverride,
      plannedEnd: durOverride != null ? base + durOverride : s.plannedEnd,
      plannedDuration: durOverride != null ? durOverride : s.plannedDuration,
    } : s);
    saveStints(aEnd != null || durOverride != null ? regenFrom(updated, idx, config) : updated);
    setEditing(false);
  };

  // ── plan edit ──
  const openPlanEdit = () => {
    setPlanVals({
      plannedStart: toTimeInput(stint.plannedStart),
      duration: String(stint.plannedDuration),
    });
    setEditingPlan(true);
  };

  const savePlanEdit = () => {
    const newStart = planVals.plannedStart ? toMins(planVals.plannedStart) : stint.plannedStart;
    const newDur   = planVals.duration     ? parseInt(planVals.duration, 10) : stint.plannedDuration;
    const newEnd   = newStart + newDur;
    const updated  = stints.map((s, i) => i === idx ? {
      ...s,
      plannedStart:    newStart,
      plannedEnd:      newEnd,
      plannedDuration: newDur,
    } : s);
    saveStints(regenFrom(updated, idx, config));
    setEditingPlan(false);
  };

  const nudgeEnd = (delta) => {
    const current = stint.actualEnd ?? stint.plannedEnd;
    const newEnd = current + delta;  // no raceEndMins cap — allows manual overrides past race end
    const updated = stints.map((s, i) => i === idx
      ? { ...s, actualEnd: newEnd, plannedEnd: newEnd, plannedDuration: newEnd - (stint.actualStart ?? stint.plannedStart) }
      : s);
    saveStints(regenFrom(updated, idx, config));
  };

  return (
    <div style={{
      border: `1.5px solid ${isActive ? "#22c55e" : isPast ? "#333" : "#2e2e2e"}`,
      borderLeft: `4px solid ${isActive ? "#22c55e" : isPast ? "#555" : color}`,
      borderRadius: 8, padding: "14px 16px", marginBottom: 10,
      background: isActive ? "#1f2a1f" : isPast ? "#181818" : "#1c1c1c",
      opacity: isPast && !isActive ? 0.8 : 1, transition: "all 0.2s",
    }}>
      {/* header row */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
        <div style={{ width: 32, height: 32, borderRadius: 6, background: isPast ? "#333" : color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, color: isPast ? "#aaa" : "#000", flexShrink: 0, marginTop: 2 }}>
          S{stint.id}
        </div>

        <div style={{ flex: 1, minWidth: 130 }}>
          {/* editable driver name */}
          {editingName ? (
            <input ref={nameRef} value={nameInput}
              onChange={e => setNameInput(e.target.value)}
              onBlur={saveName}
              onKeyDown={e => { if (e.key === "Enter") saveName(); if (e.key === "Escape") { setNameInput(stint.driver); setEditingName(false); } }}
              style={{ background: "#2a2a2a", border: `1.5px solid ${color}`, borderRadius: 4, color, fontWeight: 700, fontSize: 18, padding: "4px 8px", fontFamily: "'IBM Plex Mono', monospace", width: "80%" }}
            />
          ) : (
            <div
              onClick={() => { setNameInput(stint.driver); setEditingName(true); }}
              title="Click to edit driver name"
              style={{ color: isPast ? "#aaa" : color, fontWeight: 700, fontSize: 18, letterSpacing: "0.04em", cursor: "text", display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}
            >
              {stint.driver || "—"}
              {stint.actualEnd != null && <span style={{ color: "#4ade80", fontSize: 13, fontWeight: 700 }}>✓ LOGGED</span>}
              {isActive && <span style={{ color: "#4ade80", fontSize: 13, fontWeight: 700 }}>● ACTIVE</span>}
              {stint.fcyEvents.length > 0 && <span style={{ color: "#fde68a", fontSize: 13, fontWeight: 700 }}>🟡 {stint.fcyEvents.reduce((a, e) => a + e.durationMins, 0)}m FCY</span>}
            </div>
          )}
          {/* timing */}
          <div style={{ fontSize: 14, color: "#f0f0f0", marginTop: 4 }}>
            {displayStart} → {displayEnd}
            <span style={{ color: "#aaa", marginLeft: 8 }}>({displayDur})</span>
          </div>
          {/* hot pit arrival */}
          {!stint.isLast && (
            <div style={{ fontSize: 13, color: "#fbbf24", marginTop: 6 }}>
              🏎 <strong style={{ color: "#fff" }}>Hot pit: {hotPitTime}</strong>
              <span style={{ color: "#aaa", marginLeft: 6 }}>(10 min before end)</span>
            </div>
          )}
          {/* flex / pit window */}
          <div style={{ marginTop: 8 }}>
            <FlexBadge flexMins={flexMins} />
          </div>
        </div>

        {/* nudge buttons */}
        {!isPast && !stint.isLast && (
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <Btn onClick={() => nudgeEnd(-5)}>-5m</Btn>
            <Btn onClick={() => nudgeEnd(5)}  style={{ color: "#fbbf24", borderColor: "#fbbf24" }}>+5m</Btn>
            <Btn onClick={() => nudgeEnd(10)} style={{ color: "#fbbf24", borderColor: "#fbbf24" }}>+10m</Btn>
          </div>
        )}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <Btn onClick={openPlanEdit} style={{ color: "#60a5fa", borderColor: "#60a5fa" }}>✎ PLAN</Btn>
          <Btn onClick={openEdit}>
            {stint.actualEnd != null ? "✎ EDIT" : "LOG ACTUAL"}
          </Btn>
        </div>
      </div>

      {/* fuel / note summary */}
      {(stint.fuelAdded != null || stint.note) && (
        <div style={{ marginTop: 10, fontSize: 13, color: "#f0f0f0", display: "flex", gap: 16, flexWrap: "wrap" }}>
          {stint.fuelAdded != null && <span>⛽ {stint.fuelAdded} gal added</span>}
          {stint.note && <span>📝 {stint.note}</span>}
        </div>
      )}

      {/* FCY logger */}
      {!isPast && (
        <FCYLogger stint={stint} idx={idx} stints={stints} saveStints={saveStints}
          greenBurnGalPerHr={config.burnGalPerHr} fcyPctOfGreen={config.fcyPctOfGreen} config={config} />
      )}

      {/* plan edit panel */}
      {editingPlan && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid #2e2e2e", display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 10 }}>
          <div>
            <Label>Planned start</Label>
            <SI type="time" value={planVals.plannedStart} onChange={e => setPlanVals(v => ({ ...v, plannedStart: e.target.value }))} />
          </div>
          <div>
            <Label>Duration (min)</Label>
            <SI type="number" value={planVals.duration} onChange={e => setPlanVals(v => ({ ...v, duration: e.target.value }))} placeholder="e.g. 90" />
            <div style={{ fontSize: 11, color: "#aaa", marginTop: 4 }}>Re-plans all subsequent stints</div>
          </div>
          <div style={{ gridColumn: "1/-1", display: "flex", gap: 8, justifyContent: "space-between", flexWrap: "wrap" }}>
            <Btn onClick={() => { if (window.confirm(`Remove S${stint.id} (${stint.driver})?`)) { removeStint(idx); setEditingPlan(false); } }} variant="red">REMOVE STINT</Btn>
            <div style={{ display: "flex", gap: 8 }}>
              <Btn onClick={() => setEditingPlan(false)}>CANCEL</Btn>
              <Btn onClick={savePlanEdit} style={{ background: "#1e3a5f", borderColor: "#60a5fa", color: "#60a5fa" }}>SAVE PLAN CHANGE</Btn>
            </div>
          </div>
        </div>
      )}

      {/* log actual edit panel */}
      {editing && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid #2e2e2e", display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 10 }}>
          <div><Label>Fuel added (gal)</Label><SI type="number" value={editVals.fuelAdded} onChange={e => setEditVals(v => ({ ...v, fuelAdded: e.target.value }))} placeholder="e.g. 3.2" /></div>
          <div><Label>Actual start</Label><SI type="time" value={editVals.actualStart} onChange={e => setEditVals(v => ({ ...v, actualStart: e.target.value }))} /></div>
          <div><Label>Actual end (triggers re-plan)</Label><SI type="time" value={editVals.actualEnd} onChange={e => setEditVals(v => ({ ...v, actualEnd: e.target.value }))} /></div>
          <div>
            <Label>Duration override (min)</Label>
            <SI type="number" value={editVals.durationOverride} onChange={e => setEditVals(v => ({ ...v, durationOverride: e.target.value }))} placeholder="e.g. 60" />
            <div style={{ fontSize: 11, color: "#aaa", marginTop: 4 }}>Overrides this stint's length and re-plans the rest</div>
          </div>
          <div><Label>Note</Label><SI value={editVals.note} onChange={e => setEditVals(v => ({ ...v, note: e.target.value }))} placeholder="yellow flag, short stint, friend driving..." /></div>
          <div style={{ gridColumn: "1/-1", display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Btn onClick={() => setEditing(false)}>CANCEL</Btn>
            <Btn onClick={saveEdit} variant="red">SAVE & UPDATE PLAN</Btn>
          </div>
        </div>
      )}

      {/* pit stop spacer */}
      {!stint.isLast && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid #2e2e2e", fontSize: 13, color: "#f0f0f0", letterSpacing: "0.04em" }}>
          🔧 <strong style={{ color: "#f4a261" }}>PIT STOP</strong> — {durStr(config.pitTimeMins)} · next driver out: <strong style={{ color: "#f0f0f0" }}>{toTimeStr((stint.actualEnd ?? stint.plannedEnd) + config.pitTimeMins)}</strong>
        </div>
      )}
    </div>
  );
}

// ─── defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  raceStart: "09:00", raceEnd: "09:00",
  drivers: ["Driver 1", "Driver 2"],
  stintLengthMins: 103, pitTimeMins: 5,
  tankGal: "14.5", burnGalPerHr: "6.7",
  fcyPctOfGreen: 40,
  targetPace: "1:35",
  stintMode: "optimized", // "optimized" | "even"
};

// ─── main component ───────────────────────────────────────────────────────────

export default function StintPlanner() {
  const [config, setConfig]           = useState(DEFAULT_CONFIG);
  const [driverInput, setDriverInput] = useState("Driver 1, Driver 2");
  const [stints, setStints]           = useState([]);
  const [built, setBuilt]             = useState(false);
  const [suggestion, setSuggestion]   = useState(null);
  const [useRealClock, setUseRealClock] = useState(false);
  const [manualTime, setManualTime]   = useState("12:00");
  const [nowMins, setNowMins]         = useState(null);
  const [fbLoading, setFbLoading]     = useState(true);
  const [fbError, setFbError]         = useState(null);
  const [lastSync, setLastSync]       = useState(null);

  // ── Firebase listener ──────────────────────────────────────────────────────
  useEffect(() => {
    const unsub = onSnapshot(
      doc(db, "races", RACE_DOC),
      (snap) => {
        if (snap.exists()) {
          const d = snap.data();
          if (d.config) {
            setConfig(d.config);
            setDriverInput((d.config.drivers || []).join(", "));
          }
          if (d.stints) setStints(d.stints);
          if (d.built != null) setBuilt(d.built);
          setLastSync(d.updatedAt ? new Date(d.updatedAt).toLocaleTimeString() : null);
        }
        setFbLoading(false);
      },
      (err) => { setFbError(err.message); setFbLoading(false); }
    );
    return unsub;
  }, []);

  // ── write helpers ──────────────────────────────────────────────────────────
  const savePlan = async (newConfig, newStints, newBuilt) => {
    try {
      await setDoc(doc(db, "races", RACE_DOC), {
        config: newConfig, stints: newStints, built: newBuilt,
        updatedAt: new Date().toISOString(),
      });
    } catch (e) { console.error("Firebase write error:", e); }
  };

  const saveStints = useCallback(async (newStints) => {
    setStints(newStints); // optimistic
    try {
      await updateDoc(doc(db, "races", RACE_DOC), {
        stints: newStints, updatedAt: new Date().toISOString(),
      });
    } catch (e) { console.error("Firebase write error:", e); }
  }, []);

  // ── real clock ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!useRealClock) return;
    const tick = () => {
      const d = new Date();
      setNowMins(d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60);
    };
    tick(); const id = setInterval(tick, 20000); return () => clearInterval(id);
  }, [useRealClock]);

  useEffect(() => {
    if (!useRealClock) setNowMins(toMins(manualTime));
  }, [manualTime, useRealClock]);

  // ── build ──────────────────────────────────────────────────────────────────
  const buildWithLength = useCallback((stintLengthMins) => {
    const raceStartMins = toMins(config.raceStart);
    const raceEndMins   = toMins(config.raceEnd);
    const newConfig = { ...config, stintLengthMins };
    const cfg = { ...newConfig, raceStartMins, raceEndMins };
    const gen = config.stintMode === "even" ? generateStintsEven : generateStints;
    const newStints = gen(cfg);
    setSuggestion(config.stintMode === "even" ? null : findSavingSuggestion(cfg));
    savePlan(newConfig, newStints, true);
  }, [config]);

  const build = useCallback(() => buildWithLength(config.stintLengthMins), [buildWithLength, config.stintLengthMins]);

  const applySuggestion = () => {
    if (!suggestion) return;
    buildWithLength(suggestion.newStintLength);
  };

  const addStint = useCallback(() => {
    if (!stints.length) return;
    const raceEndMins   = toMins(config.raceEnd);
    const last          = stints[stints.length - 1];
    const newStintDur   = config.stintLengthMins;
    const spaceNeeded   = config.pitTimeMins + newStintDur;
    const lastEnd       = last.actualEnd ?? last.plannedEnd;
    const lastStart     = last.actualStart ?? last.plannedStart;

    let updatedLast = { ...last, isLast: false };

    // If adding would exceed race end, shorten the current last stint to make room
    // Only shorten if there's actually room (new end must be after the stint's start)
    if (lastEnd + spaceNeeded > raceEndMins) {
      const newLastEnd = raceEndMins - spaceNeeded;
      if (newLastEnd > lastStart) {
        updatedLast = { ...updatedLast, plannedEnd: newLastEnd, plannedDuration: newLastEnd - lastStart };
      }
      // else: no room to fit cleanly — append past race end and let user adjust via PLAN
    }

    const newStart = (updatedLast.actualEnd ?? updatedLast.plannedEnd) + config.pitTimeMins;
    const newStint = {
      id: last.id + 1,
      driver: config.drivers[stints.length % config.drivers.length],
      plannedStart: newStart,
      plannedEnd: newStart + newStintDur,
      plannedDuration: newStintDur,
      actualStart: null, actualEnd: null, fuelAdded: null, note: "",
      fcyEvents: [], isLast: true,
    };
    saveStints([...stints.slice(0, -1).map(s => ({ ...s, isLast: false })), updatedLast, newStint]);
  }, [stints, config, saveStints]);

  const removeStint = useCallback((idx) => {
    if (stints.length <= 1) return;
    const filtered = stints.filter((_, i) => i !== idx);
    const renumbered = filtered.map((s, i) => ({ ...s, id: i + 1, isLast: i === filtered.length - 1 }));
    if (idx === 0) {
      saveStints(renumbered);
    } else {
      saveStints(regenFrom(renumbered, idx - 1, { ...config, raceEndMins: toMins(config.raceEnd) }).map((s, i) => ({ ...s, id: i + 1 })));
    }
  }, [stints, config, saveStints]);

  const resetRace = async () => {
    if (!window.confirm("Reset the entire race plan? This clears all stints and logs for everyone.")) return;
    const newConfig = { ...config };
    await setDoc(doc(db, "races", RACE_DOC), {
      config: newConfig, stints: [], built: false,
      updatedAt: new Date().toISOString(),
    });
  };

  const setDrivers = (val) => {
    setDriverInput(val);
    setConfig(c => ({ ...c, drivers: val.split(",").map(s => s.trim()).filter(Boolean) }));
  };

  // ── derived values ─────────────────────────────────────────────────────────
  const raceStartMins  = toMins(config.raceStart);
  const raceEndMins    = toMins(config.raceEnd);
  const totalRaceMins  = raceEndMins - raceStartMins;
  const totalDriveMins = stints.reduce((a, s) => a + (s.actualEnd ?? s.plannedEnd) - (s.actualStart ?? s.plannedStart), 0);
  const totalPitMins   = (stints.length - 1) * config.pitTimeMins;
  const completedStints = stints.filter(s => s.actualEnd != null).length;
  const fuelLogged      = stints.filter(s => s.fuelAdded != null);
  const avgFuel = fuelLogged.length ? (fuelLogged.reduce((a, s) => a + s.fuelAdded, 0) / fuelLogged.length).toFixed(2) : null;
  const totalFCYMins = stints.flatMap(s => s.fcyEvents).reduce((a, e) => a + e.durationMins, 0);

  const derivedConfig = { ...config, raceEndMins };

  const autoStintLen = calcFuelRange(parseFloat(config.tankGal), parseFloat(config.burnGalPerHr));

  const clockPct = totalRaceMins > 0
    ? Math.min(100, Math.max(0, ((nowMins ?? raceStartMins) - raceStartMins) / totalRaceMins * 100)) : 0;
  const elapsed   = nowMins != null ? nowMins - raceStartMins : 0;
  const remaining = nowMins != null ? raceEndMins - nowMins : totalRaceMins;

  // ── render ─────────────────────────────────────────────────────────────────
  if (fbLoading) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "calc(100vh - 49px)", color: "#aaa", fontFamily: "'IBM Plex Mono', monospace", fontSize: 14, background: "#111" }}>
      Connecting to race server…
    </div>
  );

  return (
    <div style={{ overflowY: "auto", height: "calc(100vh - 49px)", fontFamily: "'IBM Plex Mono', monospace", color: "#f0f0f0", background: "#111" }}>
      <div style={{ maxWidth: 820, margin: "0 auto", padding: "20px 16px" }}>

        {/* Firebase status bar */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, fontSize: 12, color: "#aaa" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: fbError ? "#e63946" : "#22c55e", flexShrink: 0 }} />
            {fbError ? <span style={{ color: "#f87171" }}>Sync error: {fbError}</span> : <span>{lastSync ? `Synced ${lastSync}` : "Connected"} · All team members see live changes</span>}
          </div>
          {built && <button onClick={resetRace} style={{ background: "none", border: "1.5px solid #555", borderRadius: 4, color: "#f0f0f0", padding: "4px 10px", fontSize: 12, fontFamily: "'IBM Plex Mono', monospace", cursor: "pointer" }}>RESET RACE</button>}
        </div>

        {/* CONFIG */}
        <Card>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#e63946", letterSpacing: "0.1em", marginBottom: 14, textTransform: "uppercase" }}>⚙ Race Configuration</div>

          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: "0 16px" }}>
            <div style={{ marginBottom: 12 }}><Label>Race start</Label><SI type="time" value={config.raceStart} onChange={e => setConfig(c => ({ ...c, raceStart: e.target.value }))} /></div>
            <div style={{ marginBottom: 12 }}><Label>Race end</Label><SI type="time" value={config.raceEnd} onChange={e => setConfig(c => ({ ...c, raceEnd: e.target.value }))} /></div>
          </div>

          <div style={{ marginBottom: 12 }}>
            <Label>Drivers — comma-separated, in rotation order</Label>
            <SI value={driverInput} onChange={e => setDrivers(e.target.value)} placeholder="Alex, Jordan, Sam" />
          </div>

          {/* fuel profile */}
          <div style={{ background: "#1f1a12", border: "1.5px solid #7c4a00", borderRadius: 8, padding: 14, marginBottom: 12 }}>
            <div style={{ fontSize: 13, color: "#f4a261", letterSpacing: "0.1em", marginBottom: 12, fontWeight: 700, textTransform: "uppercase" }}>⛽ Fuel profile</div>
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr)", gap: 10, marginBottom: 12 }}>
              <div><Label>Tank (gal)</Label><SI type="number" value={config.tankGal} onChange={e => setConfig(c => ({ ...c, tankGal: e.target.value }))} placeholder="14.5" /></div>
              <div><Label>Green burn (gal/hr)</Label><SI type="number" value={config.burnGalPerHr} onChange={e => setConfig(c => ({ ...c, burnGalPerHr: e.target.value }))} placeholder="6.7" /></div>
              <div>
                <Label>Stint length (min)</Label>
                <SI type="number" value={config.stintLengthMins} onChange={e => setConfig(c => ({ ...c, stintLengthMins: Number(e.target.value) }))} placeholder="103" />
                {autoStintLen && <div style={{ fontSize: 12, color: "#f4a261", marginTop: 6 }}>↳ fuel calc: {autoStintLen}m <button onClick={() => setConfig(c => ({ ...c, stintLengthMins: autoStintLen }))} style={{ background: "none", border: "none", color: "#f4a261", fontSize: 12, cursor: "pointer", textDecoration: "underline", padding: 0, fontFamily: "inherit" }}>USE</button></div>}
              </div>
            </div>

            {/* FCY burn rate */}
            <div style={{ borderTop: "1px solid #3a2a00", paddingTop: 12, marginBottom: 2 }}>
              <div style={{ fontSize: 13, color: "#fde68a", letterSpacing: "0.08em", marginBottom: 10, fontWeight: 700, textTransform: "uppercase" }}>🟡 FCY burn rate</div>
              <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 10, alignItems: "end" }}>
                <div>
                  <Label>FCY burn (% of green rate)</Label>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <SI type="number" value={config.fcyPctOfGreen} min={5} max={95} onChange={e => setConfig(c => ({ ...c, fcyPctOfGreen: Number(e.target.value) }))} style={{ width: 80 }} />
                    <span style={{ fontSize: 13, color: "#ccc" }}>% (typ. 30–45%)</span>
                  </div>
                </div>
                <div style={{ fontSize: 13, color: "#f0f0f0", lineHeight: 1.9 }}>
                  {config.burnGalPerHr && config.fcyPctOfGreen ? (<>
                    Green: <span style={{ color: "#f4a261" }}>{parseFloat(config.burnGalPerHr).toFixed(1)} gal/hr</span><br />
                    FCY: <span style={{ color: "#fde68a" }}>{(parseFloat(config.burnGalPerHr) * config.fcyPctOfGreen / 100).toFixed(1)} gal/hr</span>
                  </>) : <span style={{ color: "#aaa" }}>Enter burn rate to see FCY rate</span>}
                </div>
              </div>
            </div>
          </div>

          {/* FuelMaxing config */}
          <div style={{ background: "#19142a", border: "1.5px solid #4c3a8a", borderRadius: 8, padding: 14, marginBottom: 12 }}>
            <div style={{ fontSize: 13, color: "#a78bfa", letterSpacing: "0.1em", marginBottom: 10, fontWeight: 700, textTransform: "uppercase" }}>⚡ FuelMax settings</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 10, alignItems: "end" }}>
              <div>
                <Label>Target lap time</Label>
                <SI value={config.targetPace} onChange={e => setConfig(c => ({ ...c, targetPace: e.target.value }))} placeholder="1:35" style={{ width: "100%" }} />
                <div style={{ fontSize: 12, color: "#aaa", marginTop: 6 }}>format: m:ss (e.g. 1:35)</div>
              </div>
              <div style={{ fontSize: 13, color: "#c4b5fd", lineHeight: 1.9, paddingBottom: 4 }}>
                Conservative: -5 sec/lap<br />
                Aggressive: -12 sec/lap
              </div>
            </div>
          </div>

          <div style={{ fontSize: 13, color: "#ccc", marginBottom: 16 }}>🔧 Pit stop: <strong style={{ color: "#f0f0f0" }}>5 min</strong> (driver change + fuel)</div>

          {/* Stint mode toggle */}
          <div style={{ marginBottom: 16 }}>
            <Label>Stint distribution mode</Label>
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 8 }}>
              {[
                { key: "optimized", label: "OPTIMIZED", sub: "Full stints, short last" },
                { key: "even",      label: "EVEN",      sub: "Equal time every driver" },
              ].map(({ key, label, sub }) => (
                <button
                  key={key}
                  onClick={() => setConfig(c => ({ ...c, stintMode: key }))}
                  style={{
                    background: config.stintMode === key ? "#e63946" : "#2a2a2a",
                    border: `1.5px solid ${config.stintMode === key ? "#e63946" : "#444"}`,
                    borderRadius: 8, padding: "12px 10px", cursor: "pointer",
                    fontFamily: "'IBM Plex Mono', monospace", textAlign: "center",
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#fff", letterSpacing: "0.06em" }}>{label}</div>
                  <div style={{ fontSize: 11, color: config.stintMode === key ? "rgba(255,255,255,0.8)" : "#aaa", marginTop: 4 }}>{sub}</div>
                </button>
              ))}
            </div>
          </div>

          <button onClick={build} style={{ width: "100%", background: "#e63946", border: "none", borderRadius: 8, color: "#fff", padding: "16px", fontSize: 15, fontWeight: 700, letterSpacing: "0.08em", cursor: "pointer", fontFamily: "'IBM Plex Mono', monospace" }}>
            {built ? "↻ REBUILD PLAN (syncs to all devices)" : "BUILD STINT PLAN →"}
          </button>
        </Card>

        {built && stints.length > 0 && (<>

          {/* SUMMARY */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(70px, 1fr))", background: "#1c1c1c", border: "1px solid #2e2e2e", borderRadius: 10, padding: "14px 16px", marginBottom: 14, gap: 12 }}>
            {[
              ["STINTS", stints.length, "#f0f0f0"],
              ["RACE", durStr(totalRaceMins), "#f0f0f0"],
              ["DRIVE", durStr(totalDriveMins), "#f0f0f0"],
              ["PIT", durStr(totalPitMins), "#f4a261"],
              ["DONE", `${completedStints}/${stints.length}`, "#22c55e"],
              totalFCYMins > 0 && ["FCY", durStr(totalFCYMins), "#fde68a"],
              avgFuel && ["AVG FUEL", `${avgFuel}g`, "#f4a261"],
            ].filter(Boolean).map(([label, val, clr]) => (
              <div key={label} style={{ textAlign: "center" }}>
                <div style={{ color: clr, fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, fontSize: 24, letterSpacing: "0.05em" }}>{val}</div>
                <div style={{ color: "#aaa", fontSize: 11, letterSpacing: "0.08em", marginTop: 2 }}>{label}</div>
              </div>
            ))}
          </div>

          {/* SUGGESTION */}
          <SuggestionBanner suggestion={suggestion} onApply={applySuggestion} targetPace={config.targetPace} />

          {/* CLOCK */}
          <Card>
            <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap", marginBottom: 12 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: "#f0f0f0", cursor: "pointer" }}>
                <input type="checkbox" checked={useRealClock} onChange={e => setUseRealClock(e.target.checked)} style={{ accentColor: "#22c55e", width: 18, height: 18 }} />
                Use real clock
              </label>
              {!useRealClock && (<>
                <span style={{ fontSize: 13, color: "#aaa" }}>MANUAL TIME:</span>
                <input type="time" value={manualTime} onChange={e => setManualTime(e.target.value)}
                  style={{ background: "#2a2a2a", border: "1.5px solid #444", borderRadius: 6, color: "#f0f0f0", padding: "8px 10px", fontSize: 15, fontFamily: "'IBM Plex Mono', monospace" }} />
              </>)}
              {nowMins != null && (
                <div style={{ marginLeft: "auto", fontSize: 14 }}>
                  <span style={{ color: "#22c55e", fontWeight: 700 }}>{toTimeStr(nowMins)}</span>
                  <span style={{ color: "#aaa", marginLeft: 10 }}>+{durStr(Math.max(0, elapsed))}</span>
                  <span style={{ color: remaining < 60 ? "#e63946" : "#aaa", marginLeft: 10, fontWeight: remaining < 60 ? 700 : 400 }}>
                    {remaining > 0 ? `${durStr(remaining)} left` : "RACE OVER"}
                  </span>
                </div>
              )}
            </div>
            <div style={{ height: 8, background: "#2a2a2a", borderRadius: 4, overflow: "hidden", marginBottom: 6 }}>
              <div style={{ width: `${clockPct}%`, height: "100%", background: "#22c55e", borderRadius: 4, transition: "width 2s linear" }} />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#aaa" }}>
              <span>{config.raceStart} START</span>
              <span style={{ color: "#22c55e" }}>{Math.round(clockPct)}% complete</span>
              <span>{config.raceEnd} END</span>
            </div>
          </Card>

          {/* STINTS */}
          <Card>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#e63946", letterSpacing: "0.1em", marginBottom: 6, textTransform: "uppercase" }}>Stint schedule</div>
            <div style={{ fontSize: 13, color: "#aaa", marginBottom: 14 }}>
              Tap driver name to edit · LOG ACTUAL after each stop · ±5m nudge · 🟡 FCY bank
            </div>
            {stints.map((s, i) => (
              <StintRow key={s.id} stint={s} idx={i}
                drivers={config.drivers} stints={stints} saveStints={saveStints}
                removeStint={removeStint}
                config={derivedConfig} nowMins={nowMins} />
            ))}
            <button onClick={addStint} style={{
              width: "100%", background: "#1c1c1c", border: "1.5px dashed #444",
              borderRadius: 8, color: "#aaa", padding: "14px", fontSize: 14,
              fontFamily: "'IBM Plex Mono', monospace", cursor: "pointer", marginTop: 4,
              letterSpacing: "0.06em",
            }}>
              + ADD STINT
            </button>
          </Card>

          {/* FUEL LOG */}
          {fuelLogged.length > 0 && (
            <Card>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#f4a261", letterSpacing: "0.1em", marginBottom: 14, textTransform: "uppercase" }}>⛽ Fuel log</div>
              {fuelLogged.map(s => (
                <div key={s.id} style={{ display: "flex", gap: 12, marginBottom: 8, fontSize: 14, color: "#f0f0f0", alignItems: "center" }}>
                  <span style={{ color: driverColor(s.driver, config.drivers), width: 28, fontWeight: 700 }}>S{s.id}</span>
                  <span>{s.driver}</span>
                  <span style={{ marginLeft: "auto", color: "#f4a261", fontWeight: 700 }}>{s.fuelAdded} gal</span>
                  <span style={{ color: "#aaa" }}>@ {toTimeStr(s.actualEnd)}</span>
                </div>
              ))}
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid #2e2e2e", fontSize: 13, color: "#f0f0f0" }}>
                Total: <strong>{fuelLogged.reduce((a, s) => a + s.fuelAdded, 0).toFixed(2)} gal</strong> · Avg/stop: <strong>{avgFuel} gal</strong>
                {config.tankGal && <span style={{ marginLeft: 12, color: "#aaa" }}>(tank: {config.tankGal} gal · {FUEL_RESERVE_GAL} gal reserve)</span>}
              </div>
            </Card>
          )}

        </>)}
      </div>
    </div>
  );
}
