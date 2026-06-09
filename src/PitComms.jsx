import { useState, useEffect, useRef } from "react";
import { doc, onSnapshot, updateDoc } from "firebase/firestore";
import { db } from "./firebase";

const RACE_DOC = "current";

function toTimeStr(totalMins) {
  const n = ((totalMins % 1440) + 1440) % 1440;
  const h24 = Math.floor(n / 60);
  const m   = Math.round(n % 60);
  const ampm = h24 >= 12 ? "pm" : "am";
  const h12  = h24 % 12 || 12;
  return `${h12}:${String(m).padStart(2, "0")}${ampm}`;
}

const MSG_COLORS = {
  "":       { bg: "#1c1c1c", border: "#f0f0f0", text: "#f0f0f0", swatch: "#444" },
  "red":    { bg: "#7f1d1d", border: "#ef4444", text: "#fff",    swatch: "#ef4444" },
  "green":  { bg: "#14532d", border: "#22c55e", text: "#fff",    swatch: "#22c55e" },
  "blue":   { bg: "#1e3a5f", border: "#60a5fa", text: "#fff",    swatch: "#60a5fa" },
  "yellow": { bg: "#422006", border: "#fbbf24", text: "#fde68a", swatch: "#fbbf24" },
};

const COMMANDS = [
  { key: "SIP_TEA",      label: "🫖 SIP TEA",    color: "#15803d", sub: "stay out — racing" },
  { key: "EASY_TURBO",   label: "EASY, TURBO",   color: "#0c4a6e", sub: "No black flags" },
  { key: "DRIVE_FASTER", label: "DRIVE FASTER",  color: "#7c3aed", sub: null },
  { key: "BOX_SOON",     label: "BOX SOON",      color: "#c2410c", sub: "fuel crew ready" },
  { key: "BOX_NOW",      label: "BOX NOW",       color: "#e63946", sub: "come in this lap" },
];

// ─── Driver display (full-screen in-car view) ──────────────────────────────────

export function DriverDisplay() {
  const [comms, setComms]       = useState(null);
  const [timing, setTiming]     = useState(null);
  const [commsUpdated, setCommsUpdated] = useState(null);
  const [timingUpdated, setTimingUpdated] = useState(null);
  const [commsAgo, setCommsAgo] = useState(null);
  const [timingAgo, setTimingAgo] = useState(null);
  const [flashing, setFlashing] = useState(false);
  const pollRef    = useRef(null);
  const prevCmdRef = useRef(null);

  // Firebase — pit commands
  useEffect(() => {
    const unsub = onSnapshot(doc(db, "races", RACE_DOC), snap => {
      if (snap.exists()) {
        const d = snap.data();
        const newCmd = d.pitComms?.command ?? null;
        // Flash for 3s when command changes
        if (prevCmdRef.current !== undefined && newCmd !== prevCmdRef.current) {
          setFlashing(false);
          setTimeout(() => setFlashing(true), 10);
          setTimeout(() => setFlashing(false), 3000);
        }
        prevCmdRef.current = newCmd;
        setComms(d.pitComms ?? null);
        setCommsUpdated(d.pitComms?.updatedAt ? new Date(d.pitComms.updatedAt) : null);
      }
    });
    return unsub;
  }, []);

  // Timing API — poll every 20 seconds
  // Cache session ID + position to skip discovery on subsequent calls
  const sessionIdRef = useRef(null);
  const positionRef  = useRef(null);

  const fetchTiming = async () => {
    try {
      const params = new URLSearchParams();
      if (sessionIdRef.current) params.set("sessionId", sessionIdRef.current);
      if (positionRef.current)  params.set("position",  positionRef.current);
      const qs  = params.toString() ? `?${params}` : "";
      const res  = await fetch(`/api/timing${qs}`);
      const json = await res.json();
      if (!json.error && json.car) {
        // Cache for next poll
        if (json.session?.id)   sessionIdRef.current = json.session.id;
        if (json.car?.position) positionRef.current  = json.car.position;
        setTiming(json);
        setTimingUpdated(new Date());
        setTimingAgo(0);
      }
    } catch (_) {}
  };
  useEffect(() => {
    fetchTiming();
    pollRef.current = setInterval(fetchTiming, 20_000);
    return () => clearInterval(pollRef.current);
  }, []);

  // Staleness counters
  useEffect(() => {
    const id = setInterval(() => {
      if (commsUpdated)  setCommsAgo(Math.floor((Date.now() - commsUpdated) / 1000));
      if (timingUpdated) setTimingAgo(Math.floor((Date.now() - timingUpdated) / 1000));
    }, 5000);
    return () => clearInterval(id);
  }, [commsUpdated, timingUpdated]);

  // Wake lock
  useEffect(() => {
    let lock = null;
    const acquire = async () => {
      try { lock = await navigator.wakeLock?.request("screen"); } catch (_) {}
    };
    acquire();
    const onVisible = () => { if (document.visibilityState === "visible") acquire(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { lock?.release(); document.removeEventListener("visibilitychange", onVisible); };
  }, []);

  const cmd         = comms?.command ?? null;
  const cmdDef      = COMMANDS.find(c => c.key === cmd);
  const pitIn       = comms?.pitInTime ?? null;
  const hotPit      = comms?.hotPitTime ?? null;
  const custom      = comms?.customMessage ?? null;
  const customColor = comms?.customMessageColor ?? "";
  const msgStyle    = MSG_COLORS[customColor] ?? MSG_COLORS[""];
  const stale       = commsAgo != null && commsAgo > 60;

  const car = timing?.car ?? null;

  // Last lap color — pit crew sets pace expectations via commands, not the app
  function lapColor(isYellow, isPersonalBest) {
    if (isPersonalBest) return "#a78bfa"; // purple — new fastest lap!
    if (isYellow)       return "#fbbf24"; // yellow — FCY, no judgment
    return "#f0f0f0";                     // white — neutral
  }

  return (
    <div style={{
      minHeight: "100vh", background: "#0a0a0a", display: "flex",
      flexDirection: "column", alignItems: "center", justifyContent: "center",
      fontFamily: "'IBM Plex Mono', monospace", padding: "20px 16px",
      overflowX: "hidden", gap: 14,
    }}>

      {/* staleness warning */}
      {stale && (
        <div style={{ fontSize: 13, color: "#f87171", letterSpacing: "0.08em", textAlign: "center" }}>
          ⚠ NO COMMS UPDATE IN {Math.floor(commsAgo / 60)}m
        </div>
      )}

      {/* flash keyframes */}
      <style>{`
        @keyframes cmdflash {
          0%,100% { opacity:1; transform:scale(1); }
          20%     { opacity:0.3; transform:scale(0.96); }
          40%     { opacity:1; transform:scale(1.03); }
          60%     { opacity:0.5; transform:scale(0.98); }
          80%     { opacity:1; transform:scale(1.01); }
        }
        .cmd-flash { animation: cmdflash 0.7s ease-in-out 4; }
      `}</style>

      {/* main command */}
      {cmdDef ? (
        <div className={flashing ? "cmd-flash" : ""} style={{ background: cmdDef.color, borderRadius: 14, padding: "28px 20px", textAlign: "center", width: "100%", maxWidth: 480 }}>
          <div style={{
            fontSize: cmdDef.label.length > 11 ? 38 : cmdDef.label.length > 8 ? 46 : 56,
            fontWeight: 900, color: "#fff", letterSpacing: "0.06em", lineHeight: 1.1,
            fontFamily: "'Barlow Condensed', sans-serif", wordBreak: "break-word", overflowWrap: "break-word",
          }}>
            {cmdDef.label}
          </div>
        </div>
      ) : (
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 20, color: "#f0f0f0", letterSpacing: "0.1em" }}>STANDING BY</div>
        </div>
      )}

      {/* custom message */}
      {custom && (
        <div style={{ background: msgStyle.bg, border: `1.5px solid ${msgStyle.border}`, borderRadius: 12, padding: "16px 20px", textAlign: "center", width: "100%", maxWidth: 480, fontSize: 18, color: msgStyle.text, lineHeight: 1.5, fontWeight: 700 }}>
          {custom}
        </div>
      )}

      {/* pit timing — PIT TARGET (big), Pit window start (smaller, below) */}
      {(pitIn || hotPit) && (
        <div style={{ background: "#1c1c1c", border: "1.5px solid #f4a261", borderRadius: 12, padding: "16px 20px", textAlign: "center", width: "100%", maxWidth: 480 }}>
          {pitIn && (
            <div style={{ marginBottom: hotPit ? 10 : 0 }}>
              <div style={{ fontSize: 12, color: "#f0f0f0", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 3 }}>Pit target</div>
              <div style={{ fontSize: 42, fontWeight: 900, color: "#f4a261", fontFamily: "'Barlow Condensed', sans-serif" }}>{pitIn}</div>
            </div>
          )}
          {hotPit && (
            <div>
              <div style={{ fontSize: 11, color: "#ccc", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 2 }}>Pit window start</div>
              <div style={{ fontSize: 26, fontWeight: 700, color: "#fbbf24", fontFamily: "'Barlow Condensed', sans-serif" }}>{hotPit}</div>
            </div>
          )}
        </div>
      )}

      {/* lap timing */}
      {car && (
        <div style={{ width: "100%", maxWidth: 480 }}>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 10, marginBottom: 10 }}>
            <div style={{
              background: car.isPersonalBest ? "#1a1535" : car.isYellow ? "#1f1a00" : "#1c1c1c",
              border: `1.5px solid ${car.isPersonalBest ? "#a78bfa" : car.isYellow ? "#fbbf24" : "#2e2e2e"}`,
              borderRadius: 10, padding: "12px 10px", textAlign: "center",
              minWidth: 0, overflow: "hidden",
            }}>
              <div style={{ fontSize: 11, color: car.isPersonalBest ? "#a78bfa" : car.isYellow ? "#fbbf24" : "#f0f0f0", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 6, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {car.isPersonalBest ? "⚡ NEW BEST" : car.isYellow ? "🟡 FCY lap" : "Last lap"}
              </div>
              <div style={{ fontSize: 26, fontWeight: 700, color: lapColor(car.isYellow, car.isPersonalBest), fontFamily: "'Barlow Condensed', sans-serif", letterSpacing: "0.02em", whiteSpace: "nowrap" }}>
                {car.lastLap ?? "—"}
              </div>
            </div>
            <div style={{ background: "#1c1c1c", border: "1.5px solid #2e2e2e", borderRadius: 10, padding: "12px 10px", textAlign: "center", minWidth: 0, overflow: "hidden" }}>
              <div style={{ fontSize: 11, color: "#f0f0f0", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 6 }}>Best lap</div>
              <div style={{ fontSize: 26, fontWeight: 700, color: "#4ade80", fontFamily: "'Barlow Condensed', sans-serif", letterSpacing: "0.02em", whiteSpace: "nowrap" }}>
                {car.bestLap ?? "—"}
              </div>
            </div>
          </div>

          <div style={{ textAlign: "center", fontSize: 12, color: "#ccc" }}>
            timing {timingAgo != null && timingAgo < 30 ? "just now" : timingAgo != null ? `${timingAgo}s ago` : "…"}
            {" · "}comms {commsAgo != null && commsAgo < 30 ? "just now" : commsAgo != null ? `${commsAgo}s ago` : "…"}
          </div>
        </div>
      )}

      {/* no timing yet */}
      {!car && (
        <div style={{ fontSize: 14, color: "#ccc", textAlign: "center" }}>
          Fetching timing data…
        </div>
      )}

    </div>
  );
}

// ─── Pit crew comms panel ──────────────────────────────────────────────────────

export default function PitComms() {
  const [stints, setStints]       = useState([]);
  const [comms, setComms]         = useState({});
  const [customMsg, setCustomMsg] = useState("");
  const [msgColor, setMsgColor]   = useState("");
  const [sending, setSending]     = useState(false);

  useEffect(() => {
    const unsub = onSnapshot(doc(db, "races", RACE_DOC), snap => {
      if (snap.exists()) {
        const d = snap.data();
        setStints(d.stints ?? []);
        setComms(d.pitComms ?? {});
        setCustomMsg(d.pitComms?.customMessage ?? "");
        setMsgColor(d.pitComms?.customMessageColor ?? "");
      }
    });
    return unsub;
  }, []);

  // ── auto pit-in time from active/next stint ──────────────────────────────────
  const nowMins = (() => {
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
  })();

  const activeStint = stints.find(s =>
    nowMins >= (s.actualStart ?? s.plannedStart) &&
    nowMins <  (s.actualEnd   ?? s.plannedEnd)
  );
  const nextStint = !activeStint
    ? stints.find(s => (s.actualStart ?? s.plannedStart) > nowMins)
    : null;
  const relevantStint = activeStint ?? nextStint ?? stints[stints.length - 1] ?? null;

  const autoPitInMins  = relevantStint ? (relevantStint.actualEnd ?? relevantStint.plannedEnd) : null;
  const autoHotPitMins = autoPitInMins != null ? autoPitInMins - 10 : null;
  const autoPitInStr   = autoPitInMins  != null ? toTimeStr(autoPitInMins)  : null;
  const autoHotPitStr  = autoHotPitMins != null ? toTimeStr(autoHotPitMins) : null;

  const send = async (command, overrideCustom) => {
    setSending(true);
    try {
      await updateDoc(doc(db, "races", RACE_DOC), {
        "pitComms.command":            command,
        "pitComms.customMessage":      overrideCustom ?? (command === "CUSTOM" ? customMsg : ""),
        "pitComms.customMessageColor": command === "CUSTOM" ? msgColor : "",
        "pitComms.pitInTime":          autoPitInStr,
        "pitComms.hotPitTime":         autoHotPitStr,
        "pitComms.updatedAt":          new Date().toISOString(),
      });
    } catch (e) {
      console.error("Comms write error:", e);
    } finally {
      setSending(false);
    }
  };

  const clearComms = async () => {
    try {
      await updateDoc(doc(db, "races", RACE_DOC), {
        "pitComms.command":            null,
        "pitComms.customMessage":      "",
        "pitComms.customMessageColor": "",
        "pitComms.updatedAt":          new Date().toISOString(),
      });
      setCustomMsg("");
      setMsgColor("");
    } catch (e) {
      console.error(e);
    }
  };

  const driverUrl = `${window.location.origin}${window.location.pathname}?driver=1`;
  const activeCmd = comms.command ?? null;

  return (
    <div style={{ overflowY: "auto", height: "calc(100vh - 49px)", background: "#111", fontFamily: "'IBM Plex Mono', monospace", color: "#f0f0f0" }}>
      <div style={{ maxWidth: 820, margin: "0 auto", padding: "20px 16px" }}>

        {/* driver link */}
        <div style={{ background: "#1c1c1c", border: "1px solid #2e2e2e", borderRadius: 10, padding: "14px 16px", marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: "#aaa", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 }}>Driver display URL</div>
          <div style={{ fontSize: 13, color: "#4ade80", wordBreak: "break-all", marginBottom: 10 }}>{driverUrl}</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={() => navigator.clipboard.writeText(driverUrl)} style={{
              background: "#2a2a2a", border: "1.5px solid #444", borderRadius: 6,
              color: "#f0f0f0", padding: "8px 14px", fontSize: 13, cursor: "pointer",
              fontFamily: "'IBM Plex Mono', monospace",
            }}>COPY LINK</button>
            <button onClick={() => window.open(driverUrl, "_blank")} style={{
              background: "#2a2a2a", border: "1.5px solid #444", borderRadius: 6,
              color: "#f0f0f0", padding: "8px 14px", fontSize: 13, cursor: "pointer",
              fontFamily: "'IBM Plex Mono', monospace",
            }}>OPEN DRIVER VIEW ↗</button>
          </div>
        </div>

        {/* pit-in time */}
        <div style={{ background: "#1f1a12", border: "1.5px solid #7c4a00", borderRadius: 10, padding: "14px 16px", marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: "#aaa", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 6 }}>Auto pit times (from stint planner)</div>
          {relevantStint ? (<>
            <div style={{ fontSize: 14, color: "#f0f0f0", marginBottom: 4 }}>
              Driver: <strong style={{ color: "#f4a261" }}>{relevantStint.driver}</strong>
              {activeStint ? " (currently in car)" : " (next up)"}
            </div>
            <div style={{ fontSize: 16, color: "#f0f0f0" }}>
              Pit target: <strong style={{ color: "#f4a261" }}>{autoPitInStr}</strong>
              &nbsp;·&nbsp;
              Window start: <strong style={{ color: "#fbbf24" }}>{autoHotPitStr}</strong>
            </div>
            <div style={{ fontSize: 12, color: "#aaa", marginTop: 6 }}>These are sent automatically with every command.</div>
          </>) : (
            <div style={{ fontSize: 14, color: "#aaa" }}>No stint plan built yet — go to Stint Planner first.</div>
          )}
        </div>

        {/* active command display */}
        {activeCmd && (
          <div style={{
            background: COMMANDS.find(c => c.key === activeCmd)?.color ?? "#1c1c1c",
            borderRadius: 10, padding: "14px 16px", marginBottom: 16,
            display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
          }}>
            <div>
              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.7)", letterSpacing: "0.1em", marginBottom: 4 }}>ACTIVE COMMAND</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: "#fff", letterSpacing: "0.06em" }}>
                {COMMANDS.find(c => c.key === activeCmd)?.label ?? activeCmd}
              </div>
              {comms.customMessage && <div style={{ fontSize: 14, color: "rgba(255,255,255,0.8)", marginTop: 4 }}>{comms.customMessage}</div>}
            </div>
            <button onClick={clearComms} style={{
              background: "rgba(0,0,0,0.3)", border: "1.5px solid rgba(255,255,255,0.3)",
              borderRadius: 6, color: "#fff", padding: "8px 14px", fontSize: 13,
              cursor: "pointer", fontFamily: "'IBM Plex Mono', monospace", flexShrink: 0,
            }}>CLEAR</button>
          </div>
        )}

        {/* command buttons — layout: EASY TURBO | DRIVE FASTER, SIP TEA | BOX SOON, BOX NOW full width */}
        {(() => {
          const btn = (cmd) => (
            <button
              key={cmd.key}
              onClick={() => send(cmd.key)}
              disabled={sending}
              style={{
                background: activeCmd === cmd.key ? cmd.color : "#1c1c1c",
                border: `2px solid ${cmd.color}`,
                borderRadius: 10, padding: "16px 10px", textAlign: "center",
                cursor: sending ? "not-allowed" : "pointer", opacity: sending ? 0.6 : 1,
                fontFamily: "'IBM Plex Mono', monospace",
              }}
            >
              <div style={{ fontSize: 15, fontWeight: 700, color: activeCmd === cmd.key ? "#fff" : cmd.color, letterSpacing: "0.06em" }}>{cmd.label}</div>
              {cmd.sub && <div style={{ fontSize: 12, color: activeCmd === cmd.key ? "rgba(255,255,255,0.9)" : "#ccc", marginTop: 4 }}>{cmd.sub}</div>}
            </button>
          );
          const c = Object.fromEntries(COMMANDS.map(c => [c.key, c]));
          return (<>
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 10, marginBottom: 10 }}>
              {btn(c.EASY_TURBO)}
              {btn(c.DRIVE_FASTER)}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 10, marginBottom: 10 }}>
              {btn(c.SIP_TEA)}
              {btn(c.BOX_SOON)}
            </div>
            <div style={{ marginBottom: 16 }}>
              {btn(c.BOX_NOW)}
            </div>
          </>);
        })()}

        {/* custom message */}
        <div style={{ background: "#1c1c1c", border: "1px solid #2e2e2e", borderRadius: 10, padding: "14px 16px" }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 10 }}>
            <div style={{ fontSize: 12, color: "#ccc", letterSpacing: "0.08em", textTransform: "uppercase" }}>Custom message</div>
            <div style={{ fontSize: 12, color: customMsg.length > 40 ? "#f87171" : "#ccc", fontFamily: "'IBM Plex Mono', monospace" }}>
              {customMsg.length}/40
            </div>
          </div>
          <textarea
            value={customMsg}
            onChange={e => setCustomMsg(e.target.value.slice(0, 80))}
            placeholder="Type anything to display to the driver…"
            rows={2}
            style={{
              width: "100%", background: "#2a2a2a",
              border: `1.5px solid ${customMsg.length > 40 ? "#f87171" : "#444"}`,
              borderRadius: 6, color: "#f0f0f0", padding: "10px 12px",
              fontSize: 15, fontFamily: "'IBM Plex Mono', monospace",
              resize: "none", outline: "none", boxSizing: "border-box",
            }}
          />

          {/* color swatches */}
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12 }}>
            <div style={{ fontSize: 12, color: "#ccc", flexShrink: 0 }}>Color:</div>
            {Object.entries(MSG_COLORS).map(([key, c]) => (
              <button
                key={key}
                onClick={() => setMsgColor(key)}
                title={key || "none"}
                style={{
                  width: 28, height: 28, borderRadius: "50%",
                  background: c.swatch,
                  border: msgColor === key ? "2.5px solid #fff" : "2px solid transparent",
                  boxShadow: msgColor === key ? "0 0 0 2px rgba(255,255,255,0.3)" : "none",
                  cursor: "pointer", flexShrink: 0, padding: 0,
                }}
              />
            ))}
          </div>

          <button
            onClick={() => send("CUSTOM")}
            disabled={!customMsg.trim() || sending}
            style={{
              marginTop: 12, width: "100%",
              background: customMsg.trim() ? (MSG_COLORS[msgColor]?.bg ?? "#1f1f1f") : "#1a1a1a",
              border: `1.5px solid ${customMsg.trim() ? (MSG_COLORS[msgColor]?.border ?? "#f0f0f0") : "#333"}`,
              borderRadius: 8, color: customMsg.trim() ? (MSG_COLORS[msgColor]?.text ?? "#f0f0f0") : "#555",
              padding: "13px", fontSize: 14, fontWeight: 700,
              fontFamily: "'IBM Plex Mono', monospace", cursor: customMsg.trim() ? "pointer" : "not-allowed",
              letterSpacing: "0.06em",
            }}
          >
            SEND CUSTOM MESSAGE
          </button>
        </div>

      </div>
    </div>
  );
}
