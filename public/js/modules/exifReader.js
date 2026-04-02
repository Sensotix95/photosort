// EXIF data extraction using exifr.
// Returns { date: Date|null, lat: number|null, lon: number|null } for each file.

// exifr loaded from CDN via import map in index.html
import Exifr from 'https://cdn.jsdelivr.net/npm/exifr@7.1.3/dist/full.esm.js';

const CONCURRENCY = 8; // max simultaneous EXIF reads

export async function readExif(file) {
  try {
    const data = await Exifr.parse(file, {
      tiff: true,
      exif: true,
      gps:  true,
      // Only request what we need
      pick: ['DateTimeOriginal', 'CreateDate', 'GPSLatitude', 'GPSLongitude',
             'GPSLatitudeRef', 'GPSLongitudeRef'],
    });

    if (!data) return fallback(file);

    const date = parseExifDate(data.DateTimeOriginal || data.CreateDate) || fallbackDate(file);
    const lat  = typeof data.latitude  === 'number' ? data.latitude  : null;
    const lon  = typeof data.longitude === 'number' ? data.longitude : null;

    return { date, lat, lon, dateSource: data.DateTimeOriginal ? 'exif' : 'file_mtime' };
  } catch {
    return fallback(file);
  }
}

// Read EXIF for a batch of File objects with concurrency control
export async function readExifBatch(files, onProgress) {
  const results = new Array(files.length);
  let done = 0;

  // Process in chunks of CONCURRENCY
  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const chunk = files.slice(i, i + CONCURRENCY);
    const chunkResults = await Promise.all(chunk.map(f => readExif(f)));
    for (let j = 0; j < chunkResults.length; j++) {
      results[i + j] = chunkResults[j];
    }
    done += chunk.length;
    onProgress?.(done, files.length);
  }

  return results;
}

function fallback(file) {
  return { date: new Date(file.lastModified), lat: null, lon: null, dateSource: 'file_mtime' };
}

function fallbackDate(file) {
  return new Date(file.lastModified);
}

function parseExifDate(raw) {
  if (!raw) return null;
  if (raw instanceof Date) return raw;
  // EXIF format: "2024:07:15 14:23:01"
  const fixed = String(raw).replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3');
  const d = new Date(fixed);
  return isNaN(d.getTime()) ? null : d;
}
