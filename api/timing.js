const BASE   = "https://eventresults-api.speedhive.com/api/v0.2.3/eventresults";
const ORIGIN = "https://sporthive.com";
const ORG_ID = 145414;  // 24 Hours of Lemons
const CAR    = "182";   // Our car number

async function sh(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { Origin: ORIGIN } });
  if (!res.ok) throw new Error(`Speedhive ${path} → ${res.status}`);
  return res.json();
}

// "1:49.535" → "1:49.5"
function fmt(t) {
  if (!t) return null;
  const dot = t.indexOf(".");
  return dot === -1 ? t : t.slice(0, dot + 2);
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    // Allow client to pass known sessionId + position to skip discovery calls
    const knownSessionId = req.query?.sessionId ? parseInt(req.query.sessionId) : null;
    const knownPosition  = req.query?.position  ? parseInt(req.query.position)  : null;

    let raceSessionId = knownSessionId;
    let eventMeta = null;
    let sessionMeta = null;

    // 1. Discover event + session if not already known
    if (!raceSessionId) {
      const events = await sh(`/organizations/${ORG_ID}/events?count=10`);
      for (const event of events) {
        const sessionData = await sh(`/events/${event.id}/sessions`);
        const allSessions = [
          ...(sessionData.sessions ?? []),
          ...(sessionData.groups ?? []).flatMap(g => g.sessions ?? []),
        ];
        const raceSessions = allSessions.filter(s => s.type === "race");
        if (!raceSessions.length) continue;
        const raceSession = raceSessions[raceSessions.length - 1];
        raceSessionId = raceSession.id;
        eventMeta   = { id: event.id, name: event.name, startDate: event.startDate };
        sessionMeta = { id: raceSession.id, name: raceSession.name, status: raceSession.resultStatus };
        break;
      }
    }

    if (!raceSessionId) {
      return res.json({ car: null, event: null, fetchedAt: new Date().toISOString() });
    }

    // 2. Classification — find car #182
    const classification = await sh(`/sessions/${raceSessionId}/classification`);
    const rows = classification.rows ?? [];
    const car  = rows.find(r => r.startNumber === CAR);

    if (!car) {
      return res.json({ car: null, event: eventMeta, session: sessionMeta, fetchedAt: new Date().toISOString() });
    }

    // 3. Gap to car ahead in class
    const classRows = rows
      .filter(r => r.resultClass === car.resultClass)
      .sort((a, b) => a.positionInClass - b.positionInClass);
    const carAhead = classRows.find(r => r.positionInClass === car.positionInClass - 1) ?? null;
    const gapLaps  = carAhead ? carAhead.numberOfLaps - car.numberOfLaps : null;

    // 4. Lap data — note: pagination params (count/offset) are ignored by this API;
    //    it always returns the full lap history. We do the slicing ourselves.
    //    This is a server→server call so the full response never hits the driver's phone.
    let lastLap        = null;
    let isYellow       = false;
    let isPersonalBest = false;
    const position = knownPosition ?? car.position;

    if ((car.numberOfLaps ?? 0) > 0) {
      try {
        const lapPage = await sh(`/sessions/${raceSessionId}/lapdata/${position}/laps`);
        const carNr   = lapPage.lapDataInfo?.participantInfo?.startNr;

        // Validate we got the right car (position may have changed)
        if (carNr === CAR) {
          // Take the last non-pit lap
          const cleanLaps = (lapPage.laps ?? []).filter(l => !l.inPit);
          if (cleanLaps.length) {
            const last    = cleanLaps[cleanLaps.length - 1];
            lastLap       = fmt(last.lapTime);
            isYellow      = (last.status ?? []).includes("YELLOW");
            isPersonalBest = last.diffWithBestLap === "0.000";
          }
        }
        // If wrong car, we skip lastLap — client will re-fetch with fresh position next cycle
      } catch (_) {
        // Lap data unavailable — proceed without it
      }
    }

    return res.json({
      event:   eventMeta ?? { id: null, name: null, startDate: null },
      session: sessionMeta ?? { id: raceSessionId, name: null, status: null },
      car: {
        name:            car.name,
        number:          car.startNumber,
        class:           car.resultClass,
        position:        car.position,
        positionInClass: car.positionInClass,
        classSize:       classRows.length,
        numberOfLaps:    car.numberOfLaps,
        bestLap:         fmt(car.bestTime),
        lastLap,
        isYellow,
        isPersonalBest,
      },
      gap: {
        laps:     gapLaps,
        carAhead: carAhead ? { name: carAhead.name, number: carAhead.startNumber } : null,
      },
      fetchedAt: new Date().toISOString(),
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
