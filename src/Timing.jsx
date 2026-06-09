import { useState, useEffect, useCallback } from "react";

const POLL_INTERVAL = 60_000; // 60 seconds

function toTimeStr(totalMins) {
  const n = ((totalMins % 1440) + 1440) % 1440;
  const h24 = Math.floor(n / 60), m = Math.round(n % 60);
  const ampm = h24 >= 12 ? "pm" : "am";
  return `${h24 % 12 || 12}:${String(m).padStart(2, "0")}${ampm}`;
}

function StatBox({ label, value, color = "#f0f0f0", sub }) {
  return (
    <div style={{ background: "#1c1c1c", border: "1px solid #2e2e2e", borderRadius: 10, padding: "14px 16px", textAlign: "center" }}>
      <div style={{ fontSize: 12, color: "#aaa", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 700, color, fontFamily: "'Barlow Condensed', sans-serif", letterSpacing: "0.04em", lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: "#aaa", marginTop: 5 }}>{sub}</div>}
    </div>
  );
}

export default function Timing() {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [lastFetch, setLastFetch] = useState(null);
  const [secsAgo, setSecsAgo] = useState(null);

  const fetch_ = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/timing");
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      setData(json);
      setLastFetch(Date.now());
      setSecsAgo(0);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch + polling
  useEffect(() => {
    fetch_();
    const id = setInterval(fetch_, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [fetch_]);

  // Staleness counter
  useEffect(() => {
    if (!lastFetch) return;
    const id = setInterval(() => setSecsAgo(Math.floor((Date.now() - lastFetch) / 1000)), 5000);
    return () => clearInterval(id);
  }, [lastFetch]);

  const car     = data?.car;
  const event   = data?.event;
  const session = data?.session;
  const leader  = data?.leader;

  // Gap to leader: laps down or same lap
  const lapsBehind = car && leader ? leader.laps - car.numberOfLaps : null;

  const classColor = (cls) => ({
    A: "#e63946", B: "#f4a261", C: "#2a9d8f",
  }[cls] ?? "#aaa");

  return (
    <div style={{ overflowY: "auto", height: "calc(100vh - 49px)", background: "#111", fontFamily: "'IBM Plex Mono', monospace", color: "#f0f0f0" }}>
      <div style={{ maxWidth: 820, margin: "0 auto", padding: "20px 16px" }}>

        {/* header / refresh */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, gap: 12 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#e63946", letterSpacing: "0.1em", textTransform: "uppercase" }}>
              Car #182 — Live Timing
            </div>
            <div style={{ fontSize: 12, color: "#aaa", marginTop: 3 }}>
              Polling Speedhive every 60s
              {secsAgo != null && secsAgo > 0 && ` · updated ${secsAgo}s ago`}
            </div>
          </div>
          <button
            onClick={fetch_}
            disabled={loading}
            style={{
              background: "#2a2a2a", border: "1.5px solid #444", borderRadius: 6,
              color: loading ? "#555" : "#f0f0f0", padding: "8px 14px", fontSize: 13,
              cursor: loading ? "not-allowed" : "pointer", fontFamily: "'IBM Plex Mono', monospace",
            }}
          >
            {loading ? "FETCHING…" : "↻ REFRESH"}
          </button>
        </div>

        {/* error */}
        {error && (
          <div style={{ background: "#2a0a0a", border: "1.5px solid #7f1d1d", borderRadius: 8, padding: "14px 16px", color: "#f87171", fontSize: 14, marginBottom: 16 }}>
            ⚠ {error}
          </div>
        )}

        {/* no race found */}
        {!loading && !error && !car && (
          <div style={{ background: "#1c1c1c", border: "1px solid #2e2e2e", borderRadius: 10, padding: "32px", textAlign: "center" }}>
            <div style={{ fontSize: 16, color: "#aaa", marginBottom: 8 }}>No race data found for car #182</div>
            <div style={{ fontSize: 13, color: "#555" }}>
              {event ? `Last event: ${event.name} (${event.startDate})` : "No recent Lemons events found in Speedhive"}
            </div>
          </div>
        )}

        {/* event / session info */}
        {event && (
          <div style={{ background: "#1c1c1c", border: "1px solid #2e2e2e", borderRadius: 10, padding: "12px 16px", marginBottom: 16, display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", justifyContent: "space-between" }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#f0f0f0" }}>{event.name}</div>
              <div style={{ fontSize: 12, color: "#aaa", marginTop: 2 }}>
                {event.location} · {event.startDate}
              </div>
            </div>
            {session && (
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 13, color: "#f0f0f0" }}>{session.name}</div>
                <div style={{ fontSize: 11, color: session.status === "Provisional" ? "#fbbf24" : "#aaa", marginTop: 2 }}>
                  {session.status ?? "—"}
                </div>
              </div>
            )}
          </div>
        )}

        {/* main stats */}
        {car && (<>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
            <StatBox
              label="Overall position"
              value={`P${car.position}`}
              color="#f0f0f0"
              sub={`of ${data.totalCars} cars`}
            />
            <StatBox
              label={`Class ${car.resultClass || "?"} position`}
              value={`P${car.positionInClass}`}
              color={classColor(car.resultClass)}
              sub={`Class ${car.resultClass || "?"}`}
            />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 10 }}>
            <StatBox
              label="Laps"
              value={car.numberOfLaps}
              color="#22c55e"
            />
            <StatBox
              label="Best lap"
              value={car.bestTime ?? "—"}
              color="#f4a261"
              sub={car.bestLap ? `lap ${car.bestLap}` : null}
            />
            <StatBox
              label="Gap to leader"
              value={lapsBehind === 0 ? "LEADER" : lapsBehind != null ? `-${lapsBehind}L` : "—"}
              color={lapsBehind === 0 ? "#22c55e" : "#e63946"}
            />
          </div>

          {/* car name */}
          <div style={{ background: "#1c1c1c", border: "1.5px solid #2e2e2e", borderRadius: 10, padding: "14px 16px", marginBottom: 10 }}>
            <div style={{ fontSize: 12, color: "#aaa", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 6 }}>Car name</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: "#f0f0f0" }}>{car.name ?? "—"}</div>
            {car.totalTime && <div style={{ fontSize: 13, color: "#aaa", marginTop: 4 }}>Total time: {car.totalTime}</div>}
          </div>

          {/* leader info */}
          {leader && lapsBehind !== 0 && (
            <div style={{ background: "#1c1c1c", border: "1px solid #2e2e2e", borderRadius: 10, padding: "14px 16px", marginBottom: 10 }}>
              <div style={{ fontSize: 12, color: "#aaa", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 8 }}>Overall leader</div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                <div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: "#22c55e" }}>#{leader.startNumber} — {leader.name}</div>
                  <div style={{ fontSize: 13, color: "#aaa", marginTop: 2 }}>{leader.laps} laps · best {leader.bestLap}</div>
                </div>
              </div>
            </div>
          )}

          {/* note on data freshness */}
          <div style={{ fontSize: 12, color: "#444", textAlign: "center", marginTop: 16, lineHeight: 1.6 }}>
            Data from Speedhive (MyLaps) · org 145414 · session {session?.id}<br />
            During a live race this updates as results are uploaded from Orbits timing software.
          </div>
        </>)}

      </div>
    </div>
  );
}
