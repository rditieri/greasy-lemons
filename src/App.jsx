import { useState } from "react";
import Greasy from "./Greasy";
import StintPlanner from "./StintPlanner";

export default function App() {
  const [tab, setTab] = useState("greasy");

  return (
    <div style={{ minHeight: "100vh", background: "#f5f5f5", fontFamily: "'IBM Plex Mono', monospace", overflowX: "hidden" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;700&family=Barlow+Condensed:wght@700;900&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        html, body { overflow-x: hidden; max-width: 100vw; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: #eee; }
        ::-webkit-scrollbar-thumb { background: #ccc; border-radius: 2px; }
      `}</style>

      {/* Top nav */}
      <div style={{
        display: "flex",
        alignItems: "center",
        borderBottom: "1px solid #e0e0e0",
        background: "#ffffff",
        padding: "0 20px",
        gap: 0,
        boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
      }}>
        <div style={{
          fontFamily: "'Barlow Condensed', sans-serif",
          fontWeight: 900,
          fontSize: 18,
          letterSpacing: "0.14em",
          color: "#e63946",
          marginRight: 28,
          padding: "14px 0",
          flexShrink: 0,
        }}>
          ⚙ GREASY
        </div>

        {[
          { key: "greasy", label: "AI MECHANIC" },
          { key: "stints", label: "STINT PLANNER" },
        ].map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            style={{
              background: "transparent",
              border: "none",
              borderBottom: tab === key ? "2px solid #e63946" : "2px solid transparent",
              color: tab === key ? "#111" : "#444",
              padding: "14px 16px 12px",
              fontSize: 11,
              letterSpacing: "0.1em",
              cursor: "pointer",
              fontFamily: "'IBM Plex Mono', monospace",
              fontWeight: tab === key ? 700 : 400,
              transition: "color 0.15s",
            }}
          >
            {label}
          </button>
        ))}

        <div style={{
          marginLeft: "auto",
          fontSize: 10,
          color: "#666",
          letterSpacing: "0.07em",
        }}>
          2005 CELICA GT-S · ZZT231 · 2ZZ-GE
        </div>
      </div>

      {tab === "greasy" && <Greasy />}
      {tab === "stints" && <StintPlanner />}
    </div>
  );
}
