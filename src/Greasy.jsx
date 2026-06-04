import { useState, useRef, useEffect } from "react";

const SYSTEM_PROMPT = `You are GREASY, the pit crew mechanic AI for a 24 Hours of Lemons endurance racing team. The team runs a 2005 Toyota Celica GT-S (ZZT231) with a 2ZZ-GE engine.

VEHICLE FACTS — MEMORIZE THESE:
- Engine: 2ZZ-GE, DOHC 1.8L, ~180hp stock
- DRIVE-BY-WIRE (electronic throttle). Never treat this as a cable-throttle car. DBW means you cannot swap a simple throttle cable; any throttle body replacement must be DBW-compatible. The Celica switched from cable to DBW for the 2003 model year — 2000–2002 are cable, 2003–2005 are DBW.
- The 2ZZ-GE uses VVTL-i: standard VVT-i on intake cam timing, PLUS a high-lift cam lobe that engages above ~6000 rpm via oil pressure. Two separate systems, two separate failure modes.
- This engine is shared with the Lotus Elise, Toyota Matrix GT-S, and Pontiac Vibe GT. Cross-referencing those communities is often useful for racing-specific knowledge, but each has different ECU tunes — verify before applying advice from other platforms.
- Timing chain (NOT a belt). Does not need periodic replacement like a belt, but can stretch at high mileage or with oil neglect.
- Transmission: C60 6-speed manual (GT-S)
- Applicable shop manual model codes: ZZT230, ZZT231
- Correct OEM fuel injectors: 23250-22030 (yellow/brown, 328cc/min, 13.9Ω). Do NOT substitute 23250-22070 (grey, different resistance, different flow — not correct for this ECU). Do NOT use 1ZZ-FE injectors (23250-22040 or 23250-0D040) — they flow ~255cc/min and will run lean.

KEY SPECS (from the shop manual):
- Engine oil: 4.8L / 5.1 US qts, API SJ or better, 5W-30. Drain plug 37 Nm.
- Coolant (MT): 5.9L / 6.2 US qts, ethylene glycol base
- Idle speed (MT): 750–850 rpm
- Ignition timing at idle: 8–12° BTDC
- Fuel rail pressure: 301–347 kPa (44–50 psi)
- Spark plugs: DENSO SK20R11 or NGK IFR6A11. Torque: 18 Nm.
- Head bolts: 35 Nm first pass, then +180°, then +180°
- Connecting rod caps: 30 Nm + 90°
- Main bearing caps (12-point): 22 Nm → 44 Nm → +45° → +45°
- Camshaft timing sprocket: 54 Nm
- Crankshaft pulley: 120 Nm
- Exhaust manifold: 50 Nm
- Drive belt tensioner: 100 Nm
- Oil pressure at idle: minimum 39.2 kPa (5.7 psi)
- OCV (oil control valve) resistance: 6.9–7.9Ω
- Thermostat opens: 80–84°C, fully open at 90°C
- Radiator cap: 93–123 kPa (13.5–17.8 psi)

COMMON FAULT CODES:
- P0100/P0101: MAF sensor
- P0115/P0116: coolant temp sensor
- P0171/P0172: fuel trim lean/rich (check MAF, vacuum leaks, fuel pressure, O2 sensor)
- P0300–P0304: misfires (check coils, plugs, compression, valve timing)
- P0505: IAC valve
- P1300/P1305/P1310/P1315: ignition coil failure cylinders 1/2/3/4
- P1349: VVT malfunction
- P1656/P1663: OCV circuit
- P1690/P1693: VVTL-i oil control valve or pressure switch

LEMONS CONTEXT:
- 24 Hours of Lemons: endurance racing on a $500 car budget
- Tech inspection is a hard gate — safety items (cage, harness, fire suppression, helmet, suit, window net) must be right before the car rolls.
- Race priorities: reliability > lap time. Getting back on track matters more than a perfect repair.
- Trailer spares to always have: coil packs (x4), IAC valve, MAF sensor, coolant hoses, serpentine belt, fuses, throttle body (DBW, 2003–2005 compatible)

BEHAVIOR:
- Be direct and practical. Give torque specs and part numbers, not vague suggestions.
- Use web search for current Lemons rules, parts sourcing, pricing, and community tips. Include source URLs.
- When a question could apply to 1ZZ-FE or 2ZZ-GE, always clarify and default to 2ZZ-GE.
- Flag DBW limitations whenever throttle, ECU, or tune questions come up.
- If you're not sure about something, say so and search rather than guess.
- Keep answers tight — the team is in the pits, not a library.`;

const QUICK_QUESTIONS = [
  "What spare parts should we always carry on the trailer?",
  "Torque spec for spark plugs?",
  "What does P1349 mean?",
  "What does Lemons tech inspect for safety?",
  "Can we swap a cable throttle body onto this car?",
  "Oil capacity and spec for the 2ZZ-GE?",
];

const DRIVER_COLORS = ["#e63946","#f4a261","#2a9d8f","#457b9d","#e9c46a","#f77f00"];

function Spinner() {
  return (
    <div style={{ display: "flex", gap: 5, alignItems: "center", padding: "10px 2px" }}>
      {[0, 1, 2].map(i => (
        <div key={i} style={{
          width: 7, height: 7, borderRadius: "50%", background: "#e63946",
          animation: `gb 1s ease-in-out ${i * 0.15}s infinite`,
        }} />
      ))}
      <style>{`@keyframes gb{0%,100%{transform:translateY(0);opacity:.35}50%{transform:translateY(-6px);opacity:1}}`}</style>
    </div>
  );
}

function Bubble({ msg }) {
  const isUser = msg.role === "user";
  return (
    <div style={{
      display: "flex",
      flexDirection: isUser ? "row-reverse" : "row",
      alignItems: "flex-start",
      gap: 10,
      marginBottom: 20,
    }}>
      {!isUser && (
        <div style={{
          flexShrink: 0, width: 30, height: 30, borderRadius: "50%",
          background: "#1a1a1a", border: "1.5px solid #e63946",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 14, marginTop: 2,
        }}>⚙</div>
      )}
      <div style={{
        maxWidth: "80%",
        minWidth: 0,
        overflow: "hidden",
        background: isUser ? "linear-gradient(135deg,#e63946,#c1121f)" : "#ffffff",
        border: isUser ? "none" : "1px solid #e5e5e5",
        borderRadius: isUser ? "18px 4px 18px 18px" : "4px 18px 18px 18px",
        padding: "12px 16px",
        color: isUser ? "#fff" : "#111",
        fontSize: 13,
        lineHeight: 1.7,
        fontFamily: "'IBM Plex Mono', monospace",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        overflowWrap: "break-word",
        textAlign: "left",
        minWidth: 0,
      }}>
        {msg.content}
      </div>
      {isUser && (
        <div style={{
          flexShrink: 0, width: 30, height: 30, borderRadius: "50%",
          background: "#e63946", display: "flex", alignItems: "center",
          justifyContent: "center", fontSize: 12, fontWeight: 700,
          color: "#fff", marginTop: 2,
        }}>U</div>
      )}
    </div>
  );
}

export default function Greasy() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const send = async (text) => {
    const userText = (text || input).trim();
    if (!userText || loading) return;
    setInput("");
    setError(null);

    const next = [...messages, { role: "user", content: userText }];
    setMessages(next);
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          max_tokens: 1024,
          system: SYSTEM_PROMPT,
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          messages: next,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status}`);

      const reply = (data.content || [])
        .filter(b => b.type === "text")
        .map(b => b.text)
        .join("\n")
        .trim();

      setMessages(prev => [...prev, { role: "assistant", content: reply || "(no response)" }]);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleKey = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  };

  const empty = messages.length === 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 49px)", width: "100%", maxWidth: "100vw", overflowX: "hidden" }}>
      {/* messages */}
      <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden", WebkitOverflowScrolling: "touch", padding: "24px 20px", maxWidth: 800, margin: "0 auto", width: "100%" }}>
        {empty && (
          <div style={{ textAlign: "center", paddingTop: 40 }}>
            <div style={{
              fontFamily: "'Barlow Condensed', sans-serif",
              fontWeight: 900, fontSize: 52, letterSpacing: "0.1em",
              color: "rgba(230,57,70,0.2)", marginBottom: 6,
            }}>GREASY</div>
            <div style={{ color: "#444", fontSize: 11, letterSpacing: "0.1em", marginBottom: 36 }}>
              2ZZ-GE PIT CREW AI · READY
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", maxWidth: 580, margin: "0 auto" }}>
              {QUICK_QUESTIONS.map((q, i) => (
                <button key={i} onClick={() => send(q)} style={{
                  background: "#fff",
                  border: "1px solid #e0e0e0",
                  borderRadius: 6, padding: "8px 13px",
                  color: "#333", fontSize: 11,
                  fontFamily: "'IBM Plex Mono', monospace",
                  cursor: "pointer", letterSpacing: "0.02em",
                  transition: "all 0.15s",
                }}
                  onMouseEnter={e => { e.target.style.borderColor = "#e63946"; e.target.style.color = "#e63946"; }}
                  onMouseLeave={e => { e.target.style.borderColor = "#e0e0e0"; e.target.style.color = "#555"; }}
                >{q}</button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => <Bubble key={i} msg={m} />)}

        {loading && (
          <div style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 20 }}>
            <div style={{
              flexShrink: 0, width: 30, height: 30, borderRadius: "50%",
              background: "#fff", border: "1.5px solid #e63946",
              display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14,
            }}>⚙</div>
            <div style={{
              background: "#fff", border: "1px solid #e5e5e5",
              borderRadius: "4px 18px 18px 18px", padding: "8px 14px",
            }}>
              <Spinner />
            </div>
          </div>
        )}

        {error && (
          <div style={{
            background: "rgba(230,57,70,0.1)", border: "1px solid rgba(230,57,70,0.35)",
            borderRadius: 8, padding: "10px 14px", color: "#e63946",
            fontSize: 12, marginBottom: 16,
          }}>⚠ {error}</div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* input */}
      <div style={{
        borderTop: "1px solid #e5e5e5",
        padding: "14px 20px", background: "#ffffff",
        overflow: "hidden",
      }}>
        <div style={{ maxWidth: 800, margin: "0 auto", display: "flex", gap: 10, alignItems: "flex-end" }}>
          <div style={{
            flex: 1, minWidth: 0, background: "#f9f9f9",
            border: "1px solid #e0e0e0",
            borderRadius: 10, padding: "10px 14px",
          }}>
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKey}
              placeholder="Ask about specs, fault codes, Lemons rules..."
              rows={1}
              style={{
                width: "100%", background: "transparent", border: "none",
                color: "#111", fontSize: 13, fontFamily: "'IBM Plex Mono', monospace",
                lineHeight: 1.5, resize: "none", minHeight: 22, maxHeight: 120,
                overflow: "auto", outline: "none",
              }}
              onInput={e => {
                e.target.style.height = "auto";
                e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px";
              }}
            />
          </div>
          <button
            onClick={() => send()}
            disabled={loading || !input.trim()}
            style={{
              background: loading || !input.trim() ? "#e0e0e0" : "#e63946",
              border: "none", borderRadius: 10,
              width: 44, height: 44,
              display: "flex", alignItems: "center", justifyContent: "center",
              cursor: loading || !input.trim() ? "not-allowed" : "pointer",
              transition: "background 0.15s", flexShrink: 0,
            }}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none"
              stroke={loading || !input.trim() ? "#555" : "#fff"}
              strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </div>
        <div style={{ maxWidth: 800, margin: "5px auto 0", fontSize: 10, color: "#444", paddingLeft: 2 }}>
          ENTER to send · SHIFT+ENTER for newline
        </div>
      </div>
    </div>
  );
}
