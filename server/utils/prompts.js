// Gemini prompts — ported exactly from the Python photo_sorter.py

const TRIP_NAME_PROMPT = `Name photo trip folders for {year}.

Rules:
- 1-3 words; use the most prominent city or region name
- If multiple cities in one country, use the country or the most-visited city
- NO generic suffixes (no Trip/Visit/Vacation/Journey/Tour/Holiday)
- Examples: "Portugal", "Hamburg", "Rome", "French Alps", "Lisbon"

Trips (id: date_range, n_photos, locations, [tags]):
{trips_compact}

JSON only: {"trips":[{"id":0,"folder_name":"Porto"}]}`;

const HOME_EVENTS_PROMPT = `Identify special events from home/unknown photo sessions in {year}.

EVENT=yes: weddings, concerts, parties, birthdays, sports events, any notable gathering — typically a burst of photos on the same day or consecutive days that clearly belong together.
EVENT=no: everyday pet photos, casual selfies, random food, shopping, errands, scattered unthemed photos.

You may group multiple consecutive sessions into one event if they clearly belong together (e.g. a wedding spanning two days).

Sessions (id,date,n_photos,tags):
{sessions_compact}

JSON only: {"events":[{"session_ids":[0,1],"folder_name":"Wedding"}],"flat_session_ids":[2,3]}
Folder names: short descriptor only ("Wedding", "Concert", "Birthday"). No location. Unsure=flat.`;

module.exports = { TRIP_NAME_PROMPT, HOME_EVENTS_PROMPT };
