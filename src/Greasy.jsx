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

OUR CAR — RACE-SPECIFIC SPECS (override stock manual values where listed):
- Cold tire pressure: 28 psi (our target — not stock spec)
- Oil capacity: 4.9 qts (stock is 4.8L/5.1 qts; we added an oil cooler and run extra headroom)
- Oil: Shell Rotella T6 Full Synthetic 5W-40 Diesel Engine Oil — NOT the stock 5W-30. We run this to handle higher oil temps from racing.
- Oil filter: K&N HP-2009 (higher filtering capacity than OEM)
- Wheel lug nut torque: 100 lb-ft
- Heater core: bypassed with a coolant loop — no heater function
- Power steering: Prius electric power steering unit (not stock Celica hydraulic — no PS fluid, no PS pump to worry about)
- A/C: deleted entirely
- Drivetrain: FWD, C60 6-speed manual swap, no limited-slip differential
- IMPORTANT: This car was originally an automatic and has been manual swapped. The ECU is still the automatic ECU and the gauge cluster is still the automatic gauge cluster. Any advice about transmission, ECU codes, shift behavior, or cluster readings must account for this mismatch — do not assume stock manual ECU/cluster behavior.

BEHAVIOR:
- Be direct and practical. Give torque specs and part numbers, not vague suggestions.
- Use web search for current Lemons rules, parts sourcing, pricing, and community tips. Include source URLs.
- When a question could apply to 1ZZ-FE or 2ZZ-GE, always clarify and default to 2ZZ-GE.
- Flag DBW limitations whenever throttle, ECU, or tune questions come up.
- Always apply our race-specific specs above when relevant — don't quote stock manual values for oil, tires, or wheels without noting our overrides.
- MINIMIZE ASSUMPTIONS. This is critical. If you are making an assumption, say so explicitly and explain your reasoning.
- Always tell the team if information comes from: (a) our shop manual docs, (b) a web search, or (c) general automotive knowledge not specific to the 2005 Celica GT-S. Be explicit about the source.
- If something is not 2005 Celica GT-S ZZT231 specific — e.g. it applies to the ZZT230 or another platform — say so.
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
          flexShrink: 0, width: 34, height: 34, borderRadius: "50%",
          background: "#1a1a1a", border: "1.5px solid #e63946",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 16, marginTop: 2,
        }}>⚙</div>
      )}
      <div style={{
        maxWidth: "80%",
        minWidth: 0,
        overflow: "hidden",
        background: isUser ? "#e63946" : "#1c1c1c",
        border: isUser ? "none" : "1.5px solid #2e2e2e",
        borderRadius: isUser ? "18px 4px 18px 18px" : "4px 18px 18px 18px",
        padding: "14px 16px",
        color: "#f0f0f0",
        fontSize: 15,
        lineHeight: 1.75,
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
          flexShrink: 0, width: 34, height: 34, borderRadius: "50%",
          background: "#e63946", display: "flex", alignItems: "center",
          justifyContent: "center", fontSize: 13, fontWeight: 700,
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
    <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 49px)", width: "100%", maxWidth: "100vw", overflowX: "hidden", background: "#111" }}>
      {/* messages */}
      <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden", WebkitOverflowScrolling: "touch", padding: "24px 20px", maxWidth: 800, margin: "0 auto", width: "100%" }}>
        {empty && (
          <div style={{ textAlign: "center", paddingTop: 40 }}>
            <div style={{
              fontFamily: "'Barlow Condensed', sans-serif",
              fontWeight: 900, fontSize: 52, letterSpacing: "0.1em",
              color: "rgba(230,57,70,0.25)", marginBottom: 6,
            }}>GREASY</div>
            <div style={{ color: "#aaa", fontSize: 13, letterSpacing: "0.12em", marginBottom: 36 }}>
              2ZZ-GE PIT CREW AI · READY
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, maxWidth: 560, margin: "0 auto", textAlign: "left" }}>
              {QUICK_QUESTIONS.map((q, i) => (
                <button key={i} onClick={() => send(q)} style={{
                  background: "#1c1c1c",
                  border: "1.5px solid #333",
                  borderRadius: 8, padding: "11px 14px",
                  color: "#f0f0f0", fontSize: 13,
                  fontFamily: "'IBM Plex Mono', monospace",
                  cursor: "pointer", letterSpacing: "0.02em",
                  lineHeight: 1.4, textAlign: "left",
                }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = "#e63946"; e.currentTarget.style.color = "#e63946"; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = "#333"; e.currentTarget.style.color = "#f0f0f0"; }}
                >{q}</button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => <Bubble key={i} msg={m} />)}

        {loading && (
          <div style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 20 }}>
            <div style={{
              flexShrink: 0, width: 34, height: 34, borderRadius: "50%",
              background: "#1a1a1a", border: "1.5px solid #e63946",
              display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16,
            }}>⚙</div>
            <div style={{
              background: "#1c1c1c", border: "1.5px solid #2e2e2e",
              borderRadius: "4px 18px 18px 18px", padding: "10px 16px",
            }}>
              <Spinner />
            </div>
          </div>
        )}

        {error && (
          <div style={{
            background: "#2a0a0a", border: "1.5px solid #7f1d1d",
            borderRadius: 8, padding: "14px 16px", color: "#f87171",
            fontSize: 14, marginBottom: 16,
          }}>⚠ {error}</div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* input */}
      <div style={{
        borderTop: "1.5px solid #2a2a2a",
        padding: "14px 20px", background: "#1a1a1a",
        overflow: "hidden",
      }}>
        <div style={{ maxWidth: 800, margin: "0 auto", display: "flex", gap: 10, alignItems: "flex-end" }}>
          <div style={{
            flex: 1, minWidth: 0, background: "#222",
            border: "1.5px solid #3a3a3a",
            borderRadius: 10, padding: "11px 14px",
          }}>
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKey}
              placeholder="Ask about specs, fault codes, Lemons rules..."
              rows={1}
              style={{
                width: "100%", background: "transparent", border: "none",
                color: "#f0f0f0", fontSize: 16, fontFamily: "'IBM Plex Mono', monospace",
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
              background: loading || !input.trim() ? "#2a2a2a" : "#e63946",
              border: "none", borderRadius: 10,
              width: 48, height: 48,
              display: "flex", alignItems: "center", justifyContent: "center",
              cursor: loading || !input.trim() ? "not-allowed" : "pointer",
              transition: "background 0.15s", flexShrink: 0,
            }}
          >
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none"
              stroke={loading || !input.trim() ? "#555" : "#fff"}
              strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </div>
        <div style={{ maxWidth: 800, margin: "6px auto 0", fontSize: 12, color: "#555", paddingLeft: 2 }}>
          ENTER to send · SHIFT+ENTER for newline
        </div>
      </div>
    </div>
  );
}
