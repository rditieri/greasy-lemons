import { useState } from "react";
import Greasy from "./Greasy";
import StintPlanner from "./StintPlanner";
import PitComms, { DriverDisplay } from "./PitComms";
import Timing from "./Timing";

const isDriverView = new URLSearchParams(window.location.search).get("driver") === "1";

export default function App() {
  const [tab, setTab] = useState("greasy");

  // Driver display is a standalone full-screen view — no nav, no tabs
  if (isDriverView) return <DriverDisplay />;

  return (
    <div style={{ minHeight: "100vh", background: "#111", fontFamily: "'IBM Plex Mono', monospace", overflowX: "hidden" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;700&family=Barlow+Condensed:wght@700;900&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        html, body { overflow-x: hidden; max-width: 100vw; background: #111; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: #1a1a1a; }
        ::-webkit-scrollbar-thumb { background: #444; border-radius: 2px; }
      `}</style>

      {/* Top nav */}
      <div style={{
        display: "flex",
        alignItems: "center",
        borderBottom: "1px solid #2a2a2a",
        background: "#1a1a1a",
        padding: "0 16px",
        gap: 0,
        overflowX: "auto",
        WebkitOverflowScrolling: "touch",
      }}>
        <div style={{
          fontFamily: "'Barlow Condensed', sans-serif",
          fontWeight: 900,
          fontSize: 18,
          letterSpacing: "0.14em",
          color: "#e63946",
          marginRight: 20,
          padding: "14px 0",
          flexShrink: 0,
        }}>
          ⚙ GREASY
        </div>

        {[
          { key: "greasy", label: "AI MECHANIC" },
          { key: "stints", label: "STINTS" },
          { key: "comms",  label: "PIT COMMS" },
          { key: "timing", label: "TIMING" },
        ].map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            style={{
              background: "transparent",
              border: "none",
              borderBottom: tab === key ? "2px solid #e63946" : "2px solid transparent",
              color: tab === key ? "#f0f0f0" : "#777",
              padding: "14px 14px 12px",
              fontSize: 11,
              letterSpacing: "0.1em",
              cursor: "pointer",
              fontFamily: "'IBM Plex Mono', monospace",
              fontWeight: tab === key ? 700 : 400,
              transition: "color 0.15s",
              flexShrink: 0,
              whiteSpace: "nowrap",
            }}
          >
            {label}
          </button>
        ))}

        <div style={{
          marginLeft: "auto",
          fontSize: 10,
          color: "#444",
          letterSpacing: "0.07em",
          flexShrink: 0,
          paddingLeft: 12,
          whiteSpace: "nowrap",
        }}>
          ZZT231 · 2ZZ-GE
        </div>
      </div>

      {tab === "greasy"  && <Greasy />}
      {tab === "stints"  && <StintPlanner />}
      {tab === "comms"   && <PitComms />}
      {tab === "timing"  && <Timing />}
    </div>
  );
}
