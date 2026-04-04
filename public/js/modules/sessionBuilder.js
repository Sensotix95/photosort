// Session clustering — port of Python's cluster_into_sessions().
// Groups photos by time: a gap > CLUSTER_GAP_HOURS starts a new session.

const CLUSTER_GAP_HOURS   = 4;
const MIN_PHOTOS_FOR_LLM  = 3;   // sessions smaller than this skip Gemini, go flat
const AWAY_MERGE_GAP_DAYS = 3;   // max gap (days) to merge consecutive away sessions
const UNKNOWN_ABSORB_DAYS = 1;   // absorb GPS-less session into adjacent trip if within ±this days
const PROXIMITY_MERGE_KM  = 150; // merge cross-border sessions within this distance (handles Monaco/Nice etc.)
const HOME_EXCLUSION_KM   = 100; // don't proximity-merge trips within this distance of home

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

// Detect the most likely home city from geocoded sessions.
// Weights by photo count so a big home session beats many tiny away sessions.
export function detectHomeCity(sessions) {
  const cityCounts = new Map();
  for (const s of sessions) {
    if (!s.location) continue;
    const city = s.location.split(',')[0].trim();
    cityCounts.set(city, (cityCounts.get(city) || 0) + s.photoCount);
  }
  if (!cityCounts.size) return null;
  return [...cityCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

// Returns the average lat/lon of all sessions matching the detected home city.
export function detectHomeCentroid(sessions, homeCity) {
  if (!homeCity) return { lat: null, lon: null };
  const homeSessions = sessions.filter(s => {
    if (!s.location || s.lat == null) return false;
    return s.location.split(',')[0].trim().toLowerCase() === homeCity.toLowerCase();
  });
  if (!homeSessions.length) return { lat: null, lon: null };
  return {
    lat: avg(homeSessions.map(s => s.lat)),
    lon: avg(homeSessions.map(s => s.lon)),
  };
}

// Group sessions into trips (consecutive away sessions in same country)
// and home sessions. Returns { trips, homeSessions }.
// homeCity is the first geocoder segment (e.g. "Wien") — matched against
// session location's first segment so language is always consistent.
export function detectTrips(sessions, homeCity, homeLat = null, homeLon = null) {
  const trips        = [];
  const homeSessions = [];

  let currentTrip = null;

  for (const session of sessions) {
    const sessionCity = session.location ? session.location.split(',')[0].trim() : null;
    const isHome    = sessionCity && homeCity &&
                      sessionCity.toLowerCase() === homeCity.toLowerCase();
    const isUnknown = session.location == null;
    const isAway    = !isHome && !isUnknown;

    if (isAway) {
      const country = extractCountry(session.location);
      const withinTimeWindow = currentTrip &&
        daysDiff(session.startDate, currentTrip.endDate) <= AWAY_MERGE_GAP_DAYS;
      const sameCountry = currentTrip && country === currentTrip.country;
      const farFromHome = homeLat == null || (
        haversineKm(session.lat ?? 0, session.lon ?? 0, homeLat, homeLon) > HOME_EXCLUSION_KM &&
        haversineKm(currentTrip?.lat ?? 0, currentTrip?.lon ?? 0, homeLat, homeLon) > HOME_EXCLUSION_KM
      );
      const nearbyTrip  = currentTrip && !sameCountry && withinTimeWindow &&
        farFromHome &&
        session.lat != null && currentTrip.lat != null &&
        haversineKm(session.lat, session.lon, currentTrip.lat, currentTrip.lon) <= PROXIMITY_MERGE_KM;
      if (withinTimeWindow && (sameCountry || nearbyTrip)) {
        // Extend existing trip
        currentTrip.sessions.push(session);
        currentTrip.endDate = session.endDate;
        currentTrip.photoCount += session.photoCount;
        if (session.lat != null) { currentTrip.lat = session.lat; currentTrip.lon = session.lon; }
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
          lat:        session.lat,
          lon:        session.lon,
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

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export { MIN_PHOTOS_FOR_LLM };
