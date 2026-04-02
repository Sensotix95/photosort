// Session clustering — port of Python's cluster_into_sessions().
// Groups photos by time: a gap > CLUSTER_GAP_HOURS starts a new session.

const CLUSTER_GAP_HOURS   = 4;
const MIN_PHOTOS_FOR_LLM  = 3;   // sessions smaller than this skip Gemini, go flat
const AWAY_MERGE_GAP_DAYS = 3;   // max gap (days) to merge consecutive same-country away sessions
const UNKNOWN_ABSORB_DAYS = 1;   // absorb GPS-less session into adjacent trip if within ±this days

// photo: { handle, file, date: Date, lat, lon, label: 'real'|'other', relativePath }

export function clusterSessions(photos) {
  if (!photos.length) return [];

  const sorted = [...photos].sort((a, b) => a.date - b.date);
  const gapMs  = CLUSTER_GAP_HOURS * 3600_000;

  const sessions = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].date - sessions.at(-1).at(-1).date;
    if (gap <= gapMs) {
      sessions.at(-1).push(sorted[i]);
    } else {
      sessions.push([sorted[i]]);
    }
  }

  return sessions.map((photos, idx) => buildSession(photos, idx));
}

function buildSession(photos, id) {
  const dates    = photos.map(p => p.date);
  const start    = new Date(Math.min(...dates));
  const end      = new Date(Math.max(...dates));
  const gpsPhotos = photos.filter(p => p.lat != null && p.lon != null);
  const lat      = gpsPhotos.length ? avg(gpsPhotos.map(p => p.lat)) : null;
  const lon      = gpsPhotos.length ? avg(gpsPhotos.map(p => p.lon)) : null;

  return {
    id,
    photos,
    startDate: start,
    endDate:   end,
    date:      toDateStr(start),
    photoCount: photos.length,
    lat,
    lon,
    location:     null,  // filled by geocoder
    content_tags: [],    // filled by CLIP worker
    isAway:       false, // filled by trip detector
  };
}

// Group sessions into trips (consecutive away sessions in same country)
// and home sessions. Returns { trips, homeSessions, unknownSessions }.
export function detectTrips(sessions, homeCity) {
  const trips        = [];
  const homeSessions = [];

  let currentTrip = null;

  for (const session of sessions) {
    const isHome    = session.location && homeCity &&
                      session.location.toLowerCase().includes(homeCity.toLowerCase());
    const isUnknown = session.location == null;
    const isAway    = !isHome && !isUnknown;

    if (isAway) {
      const country = extractCountry(session.location);
      if (
        currentTrip &&
        country === currentTrip.country &&
        daysDiff(session.startDate, currentTrip.endDate) <= AWAY_MERGE_GAP_DAYS
      ) {
        // Extend existing trip
        currentTrip.sessions.push(session);
        currentTrip.endDate = session.endDate;
        currentTrip.photoCount += session.photoCount;
        if (!currentTrip.locations.includes(session.location)) {
          currentTrip.locations.push(session.location);
        }
      } else {
        if (currentTrip) trips.push(finaliseTrip(currentTrip));
        currentTrip = {
          country,
          sessions: [session],
          startDate: session.startDate,
          endDate:   session.endDate,
          photoCount: session.photoCount,
          locations:  [session.location],
        };
      }
    } else {
      if (currentTrip) {
        // Try to absorb nearby unknown sessions into the current trip
        if (isUnknown && daysDiff(session.startDate, currentTrip.endDate) <= UNKNOWN_ABSORB_DAYS) {
          currentTrip.sessions.push(session);
          currentTrip.endDate   = session.endDate;
          currentTrip.photoCount += session.photoCount;
        } else {
          trips.push(finaliseTrip(currentTrip));
          currentTrip = null;
          homeSessions.push(session);
        }
      } else {
        homeSessions.push(session);
      }
    }
  }

  if (currentTrip) trips.push(finaliseTrip(currentTrip));

  return { trips, homeSessions };
}

function finaliseTrip(trip) {
  return {
    ...trip,
    id:           trips_counter++,
    date_start:   toDateStr(trip.startDate),
    date_end:     toDateStr(trip.endDate),
    content_tags: [], // merged from sessions later
  };
}

// Simple counter — reset per call via module scope
let trips_counter = 0;
export function resetTripCounter() { trips_counter = 0; }

// ── Helpers ───────────────────────────────────────────────────────────────────

function avg(arr) { return arr.reduce((s, v) => s + v, 0) / arr.length; }

function toDateStr(date) {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD
}

function daysDiff(dateA, dateB) {
  return Math.abs(dateA - dateB) / 86_400_000;
}

function extractCountry(location) {
  if (!location) return null;
  const parts = location.split(',').map(s => s.trim());
  return parts.at(-1) || null;
}

export { MIN_PHOTOS_FOR_LLM };
