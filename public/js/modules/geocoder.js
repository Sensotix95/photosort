// Nominatim reverse geocoder with rate limiting (1 req/s) and in-memory cache.
// Matches the Python Geocoder class behavior exactly.

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/reverse';
const USER_AGENT    = 'PhotoSorterApp/1.0 (contact@example.com)';

// Cache keyed on "lat2,lon2" (2 decimal places = ~1km grid, same as Python)
const cache = new Map();

// Promise queue ensuring ≥1s between requests
let lastRequestTime = 0;

async function throttle() {
  const now  = Date.now();
  const wait = 1100 - (now - lastRequestTime);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastRequestTime = Date.now();
}

export async function reverseGeocode(lat, lon) {
  if (lat == null || lon == null) return null;

  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  if (cache.has(key)) return cache.get(key);

  await throttle();

  try {
    const url    = `${NOMINATIM_URL}?lat=${lat}&lon=${lon}&format=json&zoom=12`;
    const resp   = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data   = await resp.json();
    const addr   = data.address || {};
    // Build "City, Country" string — match Python output format
    const city   = addr.city || addr.town || addr.village || addr.city_district || addr.suburb || addr.municipality || addr.county || '';
    const country = addr.country || '';
    const result = [city, country].filter(Boolean).join(', ') || data.display_name?.split(',').slice(-2).join(',').trim() || null;
    cache.set(key, result);
    return result;
  } catch {
    cache.set(key, null);
    return null;
  }
}

// Compute GPS centroid for a session (average lat/lon of all photos with GPS)
export function sessionCentroid(photos) {
  const gps = photos.filter(p => p.lat != null && p.lon != null);
  if (!gps.length) return { lat: null, lon: null };
  const lat = gps.reduce((s, p) => s + p.lat, 0) / gps.length;
  const lon = gps.reduce((s, p) => s + p.lon, 0) / gps.length;
  return { lat, lon };
}
