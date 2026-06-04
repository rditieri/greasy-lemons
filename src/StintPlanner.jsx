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
  return `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(Math.round(n % 60)).padStart(2, "0")}`;
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
  return <div style={{ fontSize: 10, color: "#333", letterSpacing: "0.1em", marginBottom: 5, textTransform: "uppercase" }}>{children}</div>;
}

function SI({ value, onChange, type = "text", placeholder, min, max, style = {} }) {
  return (
    <input type={type} value={value} onChange={onChange} placeholder={placeholder} min={min} max={max} style={{
      width: "100%", background: "#fff", border: "1px solid #ccc",
      borderRadius: 6, color: "#111", padding: "8px 10px",
      fontSize: 13, fontFamily: "'IBM Plex Mono', monospace", ...style,
    }} />
  );
}

function Card({ children, style = {} }) {
  return (
    <div style={{
      background: "#ffffff", border: "1px solid #e5e5e5",
      borderRadius: 10, padding: 16, marginBottom: 14, boxShadow: "0 1px 3px rgba(0,0,0,0.05)", ...style,
    }}>{children}</div>
  );
}

function Btn({ onClick, children, variant = "default", disabled, style = {} }) {
  const t = {
    red:     { background: "#e63946", border: "none", color: "#fff" },
    amber:   { background: "#b45309", border: "none", color: "#fff" },
    yellow:  { background: "#854d0e", border: "none", color: "#fef08a" },
    ghost:   { background: "transparent", border: "1px solid #555", color: "#333" },
    default: { background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.2)", color: "#ccc" },
  };
  return (
    <button onClick={onClick} disabled={disabled} style={{
      ...(t[variant] ?? t.default), borderRadius: 6, padding: "6px 12px",
      fontSize: 11, fontFamily: "'IBM Plex Mono', monospace",
      cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.4 : 1,
      letterSpacing: "0.05em", ...style,
    }}>{children}</button>
  );
}

// ─── Flex Badge ───────────────────────────────────────────────────────────────

function FlexBadge({ flexMins }) {
  if (flexMins <= 0) return (
    <span style={{ fontSize: 10, color: "#444", letterSpacing: "0.05em" }}>FULL STINT</span>
  );
  const color = flexMins >= 20 ? "#22c55e" : flexMins >= 10 ? "#f59e0b" : "#e63946";
  const label = flexMins >= 20 ? "wide window" : flexMins >= 10 ? "moderate" : "tight";
  return (
    <span style={{
      fontSize: 10, color,
      background: `${color}18`, border: `1px solid ${color}40`,
      borderRadius: 4, padding: "2px 7px", letterSpacing: "0.05em",
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
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid rgba(255,255,0,0.05)" }}>
      {stint.fcyEvents.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          {stint.fcyEvents.map((e, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, fontSize: 11, color: "#444" }}>
              <span style={{ color: "#facc15" }}>🟡</span>
              <span>FCY {i + 1}: {e.durationMins} min</span>
              {e.loggedAt && <span style={{ color: "#333" }}>@ {e.loggedAt}</span>}
              <button onClick={() => removeFCY(i)} style={{ background: "none", border: "none", color: "#3a3a3a", fontSize: 12, cursor: "pointer", marginLeft: "auto", padding: 0 }}>✕</button>
            </div>
          ))}
        </div>
      )}
      {savings.extraMins > 0 && (
        <div style={{ background: "rgba(250,204,21,0.07)", border: "1px solid rgba(250,204,21,0.22)", borderLeft: "3px solid #facc15", borderRadius: 6, padding: "10px 12px", marginBottom: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#facc15", letterSpacing: "0.08em", marginBottom: 6 }}>🟡 FCY FUEL BANK</div>
          <div style={{ fontSize: 12, color: "#d4d4d4", lineHeight: 1.7, marginBottom: 10 }}>
            {savings.totalFCYMins} min under yellow saved{" "}
            <strong style={{ color: "#fde047" }}>~{savings.fuelSavedGal.toFixed(2)} gal</strong>
            {" "}→ driver can stay out{" "}
            <strong style={{ color: "#fde047" }}>~{savings.extraMins} min longer</strong>
          </div>
          <Btn variant="yellow" onClick={applyExtension} style={{ fontSize: 10 }}>
            APPLY +{savings.extraMins}m EXTENSION
          </Btn>
        </div>
      )}
      {!open ? (
        <button onClick={() => setOpen(true)} style={{
          background: "rgba(250,204,21,0.07)", border: "1px solid rgba(250,204,21,0.18)",
          borderRadius: 5, padding: "4px 10px", fontSize: 10, color: "#a16207",
          fontFamily: "'IBM Plex Mono', monospace", cursor: "pointer", letterSpacing: "0.05em",
        }}>🟡 LOG FULL COURSE YELLOW</button>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 11, color: "#444" }}>FCY duration:</span>
          <input type="number" value={durInput} min={1} max={180}
            onChange={e => setDurInput(e.target.value)}
            onKeyDown={e => e.key === "Enter" && logFCY()}
            placeholder="min" autoFocus
            style={{ width: 70, background: "#fff", border: "1px solid #facc15", borderRadius: 5, color: "#92400e", padding: "4px 8px", fontSize: 12, fontFamily: "'IBM Plex Mono', monospace" }}
          />
          <span style={{ fontSize: 11, color: "#333" }}>min</span>
          <Btn variant="yellow" onClick={logFCY} style={{ fontSize: 10, padding: "4px 10px" }}>LOG IT</Btn>
          <button onClick={() => { setOpen(false); setDurInput(""); }} style={{ background: "none", border: "none", color: "#444", fontSize: 13, cursor: "pointer" }}>✕</button>
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
      background: exceedsTank ? "rgba(220,38,38,0.07)" : "rgba(245,158,11,0.07)",
      border: `1px solid ${exceedsTank ? "rgba(220,38,38,0.3)" : "rgba(245,158,11,0.3)"}`,
      borderLeft: `4px solid ${accent}`, borderRadius: 8, padding: "14px 16px", marginBottom: 14,
    }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8, marginBottom: 10 }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", color: accent }}>
          {exceedsTank ? "⚠ FUEL WARNING — STOP REDUCTION NOT FEASIBLE" : "💡 PIT STOP SAVINGS OPPORTUNITY"}
        </div>
        <button onClick={() => setDismissed(true)} style={{ background: "none", border: "none", color: "#444", fontSize: 15, cursor: "pointer", padding: 0 }}>✕</button>
      </div>

      <div style={{ fontSize: 13, color: "#ccc", lineHeight: 1.75, marginBottom: 10 }}>
        {exceedsTank ? (
          <>Extending stints by <strong style={{ color: "#f87171" }}>{extensionPerStint} min</strong> each would eliminate a pit stop but needs ~<strong style={{ color: "#f87171" }}>{extraFuelGal} gal more per stint</strong> — beyond usable tank. Not achievable on green-flag pace.</>
        ) : (
          <>Extending each stint by <strong style={{ color: "#fbbf24" }}>{extensionPerStint} min</strong> drops from <strong style={{ color: "#fbbf24" }}>{currentStints} → {newStints} stints</strong>, saving <strong style={{ color: "#fbbf24" }}>{timeSavedMins} min</strong> of pit time. New stint: <strong style={{ color: "#fbbf24" }}>{newStintLength} min</strong>.{newLastStintDuration != null && newLastStintDuration < newStintLength && <> Final stint: <strong style={{ color: "#fbbf24" }}>{newLastStintDuration} min</strong>.</>}{extraFuelGal && <> Each stop needs ~<strong style={{ color: "#fbbf24" }}>{extraFuelGal} gal more</strong> — verify against tank.</>}</>
        )}
      </div>

      {/* FuelMaxing tradeoff */}
      {fm && (
        <div style={{ background: "#f9f9f9", border: "1px solid #e5e5e5", borderRadius: 6, padding: "10px 12px", marginBottom: 12 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#444", letterSpacing: "0.1em", marginBottom: 8 }}>⚡ FUELMAX ALTERNATIVE</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
            {[
              { label: "CONSERVATIVE (-5 sec/lap)", laps: fm.lapsCon, cost: fm.costConTotal, mins: fm.raceMinsCon, wins: fm.conWins },
              { label: "AGGRESSIVE (-12 sec/lap)",  laps: fm.lapsAgg, cost: fm.costAggTotal, mins: fm.raceMinsAgg, wins: fm.aggWins },
            ].map(({ label, laps, cost, mins, wins }) => (
              <div key={label} style={{ background: wins ? "rgba(34,197,94,0.06)" : "rgba(230,57,70,0.05)", border: `1px solid ${wins ? "rgba(34,197,94,0.2)" : "rgba(230,57,70,0.15)"}`, borderRadius: 5, padding: "8px 10px" }}>
                <div style={{ fontSize: 9, color: "#333", letterSpacing: "0.08em", marginBottom: 5 }}>{label}</div>
                <div style={{ fontSize: 12, color: wins ? "#22c55e" : "#e63946", fontWeight: 700 }}>
                  {fmtSecs(cost)} total
                </div>
                <div style={{ fontSize: 10, color: "#333", marginTop: 2 }}>
                  {laps} laps/stint · {mins} min of racing
                </div>
                <div style={{ fontSize: 10, color: wins ? "#22c55e" : "#e63946", marginTop: 3 }}>
                  {wins ? `✓ ${fmtSecs(fm.pitCost - cost)} faster than pitting` : `✗ ${fmtSecs(cost - fm.pitCost)} slower than pitting`}
                </div>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 10, color: "#333" }}>Pit stop cost: {fmtSecs(fm.pitCost)} · Across {newStints} stints · Target pace {targetPace ?? "1:35"}/lap</div>
        </div>
      )}

      {!exceedsTank && <Btn variant="amber" onClick={onApply} style={{ fontSize: 11 }}>APPLY — REBUILD WITH {newStintLength}-MIN STINTS</Btn>}
    </div>
  );
}

// ─── StintRow ─────────────────────────────────────────────────────────────────

function StintRow({ stint, idx, drivers, stints, saveStints, config, nowMins }) {
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput]     = useState(stint.driver);
  const [editing, setEditing]         = useState(false);
  const [editVals, setEditVals]       = useState({});
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
      actualStart: stint.actualStart != null ? toTimeStr(stint.actualStart) : "",
      actualEnd:   stint.actualEnd   != null ? toTimeStr(stint.actualEnd)   : "",
      fuelAdded:   stint.fuelAdded   != null ? String(stint.fuelAdded)      : "",
      note: stint.note || "",
    });
    setEditing(true);
  };

  const saveEdit = () => {
    const aStart = editVals.actualStart ? toMins(editVals.actualStart) : null;
    const aEnd   = editVals.actualEnd   ? toMins(editVals.actualEnd)   : null;
    const fuel   = editVals.fuelAdded   ? parseFloat(editVals.fuelAdded) : null;
    const updated = stints.map((s, i) => i === idx
      ? { ...s, actualStart: aStart, actualEnd: aEnd, fuelAdded: fuel, note: editVals.note }
      : s);
    saveStints(aEnd != null ? regenFrom(updated, idx, config) : updated);
    setEditing(false);
  };

  const nudgeEnd = (delta) => {
    const current = stint.actualEnd ?? stint.plannedEnd;
    const newEnd = Math.max(current + 5, Math.min(config.raceEndMins, current + delta));
    const updated = stints.map((s, i) => i === idx
      ? { ...s, actualEnd: newEnd, plannedEnd: newEnd, plannedDuration: newEnd - (stint.actualStart ?? stint.plannedStart) }
      : s);
    saveStints(regenFrom(updated, idx, config));
  };

  return (
    <div style={{
      border: "1px solid #e5e5e5", borderLeft: `3px solid ${color}`,
      borderRadius: 8, padding: "12px 14px", marginBottom: 10,
      background: isActive ? "rgba(230,57,70,0.04)" : isPast ? "#f5f5f5" : "#ffffff",
      opacity: isPast && !isActive ? 0.55 : 1, transition: "all 0.2s",
    }}>
      {/* header row */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
        <div style={{ width: 26, height: 26, borderRadius: 5, background: color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "#000", flexShrink: 0, marginTop: 2 }}>
          S{stint.id}
        </div>

        <div style={{ flex: 1, minWidth: 130 }}>
          {/* editable driver name */}
          {editingName ? (
            <input ref={nameRef} value={nameInput}
              onChange={e => setNameInput(e.target.value)}
              onBlur={saveName}
              onKeyDown={e => { if (e.key === "Enter") saveName(); if (e.key === "Escape") { setNameInput(stint.driver); setEditingName(false); } }}
              style={{ background: "#fff", border: `1px solid ${color}`, borderRadius: 4, color, fontWeight: 700, fontSize: 14, padding: "2px 6px", fontFamily: "'IBM Plex Mono', monospace", width: "80%" }}
            />
          ) : (
            <div
              onClick={() => { setNameInput(stint.driver); setEditingName(true); }}
              title="Click to edit driver name"
              style={{ color, fontWeight: 700, fontSize: 14, letterSpacing: "0.04em", cursor: "text", display: "inline-flex", alignItems: "center", gap: 5 }}
            >
              {stint.driver || "—"}
              <span style={{ fontSize: 9, color: "#444", opacity: 0 }} className="edit-hint">✎</span>
              {stint.actualEnd != null && <span style={{ color: "#22c55e", fontSize: 10, marginLeft: 4 }}>✓ LOGGED</span>}
              {isActive && <span style={{ color: "#22c55e", fontSize: 10, marginLeft: 4 }}>● ACTIVE</span>}
              {stint.fcyEvents.length > 0 && <span style={{ color: "#facc15", fontSize: 10, marginLeft: 4 }}>🟡 {stint.fcyEvents.reduce((a, e) => a + e.durationMins, 0)}m FCY</span>}
            </div>
          )}
          {/* timing */}
          <div style={{ fontSize: 11, color: "#333", marginTop: 2 }}>
            {displayStart} → {displayEnd}
            <span style={{ color: "#444", marginLeft: 8 }}>({displayDur})</span>
          </div>
          {/* hot pit arrival */}
          {!stint.isLast && (
            <div style={{ fontSize: 10, color: "#333", marginTop: 4 }}>
              🏎 <strong style={{ color: "#f4a261" }}>Hot pit arrival: {hotPitTime}</strong>
              <span style={{ color: "#444", marginLeft: 6 }}>(10 min before end)</span>
            </div>
          )}
          {/* flex / pit window */}
          <div style={{ marginTop: 5 }}>
            <FlexBadge flexMins={flexMins} />
          </div>
        </div>

        {/* nudge buttons */}
        {!isPast && !stint.isLast && (
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <Btn onClick={() => nudgeEnd(-5)} style={{ fontSize: 10, padding: "3px 8px" }}>-5m</Btn>
            <Btn onClick={() => nudgeEnd(5)}  style={{ fontSize: 10, padding: "3px 8px", color: "#f4a261" }}>+5m</Btn>
            <Btn onClick={() => nudgeEnd(10)} style={{ fontSize: 10, padding: "3px 8px", color: "#f4a261" }}>+10m</Btn>
          </div>
        )}
        <Btn onClick={openEdit} style={{ fontSize: 10, padding: "4px 10px" }}>
          {stint.actualEnd != null ? "✎ EDIT" : "LOG ACTUAL"}
        </Btn>
      </div>

      {/* fuel / note summary */}
      {(stint.fuelAdded != null || stint.note) && (
        <div style={{ marginTop: 8, fontSize: 11, color: "#333", display: "flex", gap: 16 }}>
          {stint.fuelAdded != null && <span>⛽ {stint.fuelAdded} gal added</span>}
          {stint.note && <span>📝 {stint.note}</span>}
        </div>
      )}

      {/* FCY logger */}
      {!isPast && (
        <FCYLogger stint={stint} idx={idx} stints={stints} saveStints={saveStints}
          greenBurnGalPerHr={config.burnGalPerHr} fcyPctOfGreen={config.fcyPctOfGreen} config={config} />
      )}

      {/* log actual edit panel */}
      {editing && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid #e5e5e5", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <div><Label>FUEL ADDED (gal)</Label><SI type="number" value={editVals.fuelAdded} onChange={e => setEditVals(v => ({ ...v, fuelAdded: e.target.value }))} placeholder="e.g. 3.2" /></div>
          <div><Label>ACTUAL START</Label><SI type="time" value={editVals.actualStart} onChange={e => setEditVals(v => ({ ...v, actualStart: e.target.value }))} /></div>
          <div><Label>ACTUAL END (triggers re-plan)</Label><SI type="time" value={editVals.actualEnd} onChange={e => setEditVals(v => ({ ...v, actualEnd: e.target.value }))} /></div>
          <div><Label>NOTE</Label><SI value={editVals.note} onChange={e => setEditVals(v => ({ ...v, note: e.target.value }))} placeholder="yellow flag, penalty box..." /></div>
          <div style={{ gridColumn: "1/-1", display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Btn onClick={() => setEditing(false)}>CANCEL</Btn>
            <Btn onClick={saveEdit} variant="red">SAVE & UPDATE PLAN</Btn>
          </div>
        </div>
      )}

      {/* pit stop spacer */}
      {!stint.isLast && (
        <div style={{ marginTop: 10, paddingTop: 8, borderTop: "1px solid rgba(255,255,255,0.08)", fontSize: 10, color: "#444", letterSpacing: "0.05em" }}>
          🔧 PIT STOP — {durStr(config.pitTimeMins)} · next driver out: {toTimeStr((stint.actualEnd ?? stint.plannedEnd) + config.pitTimeMins)}
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
  targetPace: "1:35",  // FuelMaxing target lap time
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
    const newStints = generateStints(cfg);
    setSuggestion(findSavingSuggestion(cfg));
    savePlan(newConfig, newStints, true);
  }, [config]);

  const build = useCallback(() => buildWithLength(config.stintLengthMins), [buildWithLength, config.stintLengthMins]);

  const applySuggestion = () => {
    if (!suggestion) return;
    buildWithLength(suggestion.newStintLength);
  };

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
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "calc(100vh - 49px)", color: "#333", fontFamily: "'IBM Plex Mono', monospace", fontSize: 12 }}>
      Connecting to race server…
    </div>
  );

  return (
    <div style={{ overflowY: "auto", height: "calc(100vh - 49px)", fontFamily: "'IBM Plex Mono', monospace", color: "#111" }}>
      <div style={{ maxWidth: 820, margin: "0 auto", padding: "20px 16px" }}>

        {/* Firebase status bar */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12, fontSize: 10, color: "#444" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: fbError ? "#e63946" : "#22c55e" }} />
            {fbError ? <span style={{ color: "#e63946" }}>Sync error: {fbError}</span> : <span style={{ color: "#444" }}>{lastSync ? `Synced ${lastSync}` : "Connected"} · All team members see live changes</span>}
          </div>
          {built && <button onClick={resetRace} style={{ background: "none", border: "1px solid #555", borderRadius: 4, color: "#333", padding: "2px 8px", fontSize: 10, fontFamily: "'IBM Plex Mono', monospace", cursor: "pointer" }}>RESET RACE</button>}
        </div>

        {/* CONFIG */}
        <Card>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#e63946", letterSpacing: "0.1em", marginBottom: 14 }}>⚙ RACE CONFIGURATION</div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 16px" }}>
            <div style={{ marginBottom: 12 }}><Label>RACE START</Label><SI type="time" value={config.raceStart} onChange={e => setConfig(c => ({ ...c, raceStart: e.target.value }))} /></div>
            <div style={{ marginBottom: 12 }}><Label>RACE END</Label><SI type="time" value={config.raceEnd} onChange={e => setConfig(c => ({ ...c, raceEnd: e.target.value }))} /></div>
          </div>

          <div style={{ marginBottom: 12 }}>
            <Label>DRIVERS (comma-separated, in rotation order)</Label>
            <SI value={driverInput} onChange={e => setDrivers(e.target.value)} placeholder="Alex, Jordan, Sam" />
          </div>

          {/* fuel profile */}
          <div style={{ background: "rgba(244,162,97,0.1)", border: "1px solid rgba(244,162,97,0.35)", borderRadius: 8, padding: 12, marginBottom: 12 }}>
            <div style={{ fontSize: 10, color: "#f4a261", letterSpacing: "0.1em", marginBottom: 10 }}>⛽ FUEL PROFILE</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 12 }}>
              <div><Label>TANK SIZE (gal)</Label><SI type="number" value={config.tankGal} onChange={e => setConfig(c => ({ ...c, tankGal: e.target.value }))} placeholder="14.5" /></div>
              <div><Label>GREEN FLAG BURN (gal/hr)</Label><SI type="number" value={config.burnGalPerHr} onChange={e => setConfig(c => ({ ...c, burnGalPerHr: e.target.value }))} placeholder="6.7" /></div>
              <div>
                <Label>STINT LENGTH (min)</Label>
                <SI type="number" value={config.stintLengthMins} onChange={e => setConfig(c => ({ ...c, stintLengthMins: Number(e.target.value) }))} placeholder="103" />
                {autoStintLen && <div style={{ fontSize: 10, color: "#f4a261", marginTop: 4 }}>↳ fuel calc: {autoStintLen}m (3 gal reserve) <button onClick={() => setConfig(c => ({ ...c, stintLengthMins: autoStintLen }))} style={{ background: "none", border: "none", color: "#f4a261", fontSize: 10, cursor: "pointer", textDecoration: "underline", padding: 0, fontFamily: "inherit" }}>USE</button></div>}
              </div>
            </div>

            {/* FCY burn rate */}
            <div style={{ borderTop: "1px solid rgba(250,204,21,0.1)", paddingTop: 10, marginBottom: 2 }}>
              <div style={{ fontSize: 10, color: "#facc15", letterSpacing: "0.1em", marginBottom: 8 }}>🟡 FCY BURN RATE</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, alignItems: "end" }}>
                <div>
                  <Label>FCY BURN (% of green rate)</Label>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <SI type="number" value={config.fcyPctOfGreen} min={5} max={95} onChange={e => setConfig(c => ({ ...c, fcyPctOfGreen: Number(e.target.value) }))} style={{ width: 70 }} />
                    <span style={{ fontSize: 11, color: "#333" }}>% &nbsp;(typ. 30–45%)</span>
                  </div>
                </div>
                <div style={{ fontSize: 11, color: "#333", lineHeight: 1.8 }}>
                  {config.burnGalPerHr && config.fcyPctOfGreen ? (<>
                    Green: <span style={{ color: "#f4a261" }}>{parseFloat(config.burnGalPerHr).toFixed(1)} gal/hr</span><br />
                    FCY: <span style={{ color: "#facc15" }}>{(parseFloat(config.burnGalPerHr) * config.fcyPctOfGreen / 100).toFixed(1)} gal/hr</span>
                  </>) : <span style={{ color: "#444" }}>Enter burn rate to see FCY rate</span>}
                </div>
              </div>
            </div>
          </div>

          {/* FuelMaxing config */}
          <div style={{ background: "rgba(139,92,246,0.08)", border: "1px solid rgba(139,92,246,0.3)", borderRadius: 8, padding: 12, marginBottom: 12 }}>
            <div style={{ fontSize: 10, color: "#a78bfa", letterSpacing: "0.1em", marginBottom: 8 }}>⚡ FUELMAX SETTINGS</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 10, alignItems: "end" }}>
              <div>
                <Label>TARGET PACE LAP TIME</Label>
                <SI value={config.targetPace} onChange={e => setConfig(c => ({ ...c, targetPace: e.target.value }))} placeholder="1:35" style={{ width: "100%" }} />
                <div style={{ fontSize: 10, color: "#333", marginTop: 4 }}>format: m:ss (e.g. 1:35)</div>
              </div>
              <div style={{ fontSize: 11, color: "#333", lineHeight: 1.8, paddingBottom: 4 }}>
                Used to estimate laps affected during FuelMaxing.<br />
                Conservative: -5 sec/lap · Aggressive: -12 sec/lap
              </div>
            </div>
          </div>

          <div style={{ fontSize: 11, color: "#444", marginBottom: 14 }}>🔧 Pit stop: <span style={{ color: "#333" }}>5 min</span> (driver change + fuel)</div>

          <button onClick={build} style={{ width: "100%", background: "#e63946", border: "none", borderRadius: 8, color: "#fff", padding: "12px", fontSize: 13, fontWeight: 700, letterSpacing: "0.08em", cursor: "pointer", fontFamily: "'IBM Plex Mono', monospace" }}>
            {built ? "↻ REBUILD PLAN (syncs to all devices)" : "BUILD STINT PLAN →"}
          </button>
        </Card>

        {built && stints.length > 0 && (<>

          {/* SUMMARY */}
          <div style={{ display: "flex", justifyContent: "space-around", background: "#ffffff", border: "1px solid #e5e5e5", borderRadius: 10, padding: "14px 16px", marginBottom: 14, flexWrap: "wrap", gap: 12, boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
            {[
              ["STINTS", stints.length],
              ["RACE", durStr(totalRaceMins)],
              ["DRIVE", durStr(totalDriveMins)],
              ["PIT TIME", durStr(totalPitMins)],
              ["DONE", `${completedStints}/${stints.length}`],
              totalFCYMins > 0 && ["FCY", durStr(totalFCYMins)],
              avgFuel && ["AVG FUEL", `${avgFuel} gal`],
            ].filter(Boolean).map(([label, val]) => (
              <div key={label} style={{ textAlign: "center" }}>
                <div style={{ color: label === "FCY" ? "#facc15" : "#e63946", fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, fontSize: 20, letterSpacing: "0.05em" }}>{val}</div>
                <div style={{ color: "#444", fontSize: 10, letterSpacing: "0.08em", marginTop: 1 }}>{label}</div>
              </div>
            ))}
          </div>

          {/* SUGGESTION */}
          <SuggestionBanner suggestion={suggestion} onApply={applySuggestion} targetPace={config.targetPace} />

          {/* CLOCK */}
          <Card>
            <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap", marginBottom: 10 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#444", cursor: "pointer" }}>
                <input type="checkbox" checked={useRealClock} onChange={e => setUseRealClock(e.target.checked)} style={{ accentColor: "#22c55e" }} />
                Use real clock
              </label>
              {!useRealClock && (<>
                <span style={{ fontSize: 10, color: "#444" }}>MANUAL TIME:</span>
                <input type="time" value={manualTime} onChange={e => setManualTime(e.target.value)}
                  style={{ background: "#fff", border: "1px solid #ccc", borderRadius: 6, color: "#111", padding: "4px 8px", fontSize: 12, fontFamily: "'IBM Plex Mono', monospace" }} />
              </>)}
              {nowMins != null && (
                <div style={{ marginLeft: "auto", fontSize: 11 }}>
                  <span style={{ color: "#22c55e" }}>{toTimeStr(nowMins)}</span>
                  <span style={{ color: "#444", marginLeft: 10 }}>+{durStr(Math.max(0, elapsed))}</span>
                  <span style={{ color: remaining < 60 ? "#e63946" : "#555", marginLeft: 10 }}>
                    {remaining > 0 ? `${durStr(remaining)} left` : "RACE OVER"}
                  </span>
                </div>
              )}
            </div>
            <div style={{ height: 4, background: "#e5e5e5", borderRadius: 2, overflow: "hidden" }}>
              <div style={{ width: `${clockPct}%`, height: "100%", background: "#22c55e", borderRadius: 2, transition: "width 2s linear" }} />
            </div>
          </Card>

          {/* STINTS */}
          <Card>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#e63946", letterSpacing: "0.1em", marginBottom: 6 }}>STINT SCHEDULE</div>
            <div style={{ fontSize: 11, color: "#444", marginBottom: 14 }}>
              Click driver name to edit · LOG ACTUAL after each stop · ±5m nudge · 🟡 FCY bank
            </div>
            {stints.map((s, i) => (
              <StintRow key={s.id} stint={s} idx={i}
                drivers={config.drivers} stints={stints} saveStints={saveStints}
                config={derivedConfig} nowMins={nowMins} />
            ))}
          </Card>

          {/* FUEL LOG */}
          {fuelLogged.length > 0 && (
            <Card>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#f4a261", letterSpacing: "0.1em", marginBottom: 12 }}>⛽ FUEL LOG</div>
              {fuelLogged.map(s => (
                <div key={s.id} style={{ display: "flex", gap: 12, marginBottom: 6, fontSize: 12, color: "#ccc" }}>
                  <span style={{ color: driverColor(s.driver, config.drivers), width: 24 }}>S{s.id}</span>
                  <span>{s.driver}</span>
                  <span style={{ marginLeft: "auto", color: "#f4a261" }}>{s.fuelAdded} gal</span>
                  <span style={{ color: "#444" }}>@ {toTimeStr(s.actualEnd)}</span>
                </div>
              ))}
              <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid rgba(255,255,255,0.1)", fontSize: 11, color: "#333" }}>
                Total: {fuelLogged.reduce((a, s) => a + s.fuelAdded, 0).toFixed(2)} gal · Avg/stop: {avgFuel} gal
                {config.tankGal && <span style={{ marginLeft: 12, color: "#444" }}>(tank: {config.tankGal} gal · {FUEL_RESERVE_GAL} gal reserve)</span>}
              </div>
            </Card>
          )}

        </>)}
      </div>
    </div>
  );
}
