import { makeSongDbKey } from './song-matching.js';

export const STATIONS = [
  { callSign: 'CHFI', csvPath: 'data/chfi-songs.csv', accentVariable: '--chfi-accent' },
  { callSign: 'CKIS', csvPath: 'data/ckis-songs.csv', accentVariable: '--ckis-accent' },
];

// Same endpoint index.html uses. The Apps Script returns the last 7 days.
export const RECENTLY_PLAYED_API_URL = 'https://script.google.com/macros/s/AKfycbyO8InJxfS1k7wqyasNp8Sd4dZb71WP0HT07RvWrYpdVZ5qN7ZeQBSUqNN7xQgwiLs/exec';

const TEXT_COLUMNS = ['name', 'artist']; // stops Papa turning a title like "1999" into a number

export function isMissing(value) {
  return value === null || value === undefined || value === '';
}

export async function loadStationSongRows(station) {
  const response = await fetch(station.csvPath);
  if (!response.ok) throw new Error(`${station.csvPath} returned HTTP ${response.status}`);
  const parsed = Papa.parse(await response.text(), {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: (columnName) => !TEXT_COLUMNS.includes(columnName.trim()),
    transformHeader: (header) => header.trim(),
  });
  return parsed.data;
}

export async function fetchRecentTracks(station) {
  const response = await fetch(`${RECENTLY_PLAYED_API_URL}?station=${station.callSign}`);
  if (!response.ok) throw new Error(`${station.callSign} recently played: HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error);
  return payload.tracks; // newest first
}

/** Map of matcher key -> song stats. Every song counts toward stats. */
export function buildSongDatabase(songRows, station) {
  const stationDurationHeader = `${station.callSign.toLowerCase()} duration`;
  const songDb = new Map();

  songRows.forEach((row) => {
    const durationSeconds = isMissing(row[stationDurationHeader]) ? row['base duration'] : row[stationDurationHeader];
    const notes = row['note count (combo)'];
    if (isMissing(row.name) || isMissing(notes) || isMissing(durationSeconds)) return;

    const key = makeSongDbKey(row.name, row.artist ?? '');
    if (songDb.has(key)) return; // first occurrence wins

    songDb.set(key, {
      notes,
      durationSeconds,
      notesPerSecond: durationSeconds > 0 ? notes / durationSeconds : 0,
      bpm: row.bpm,
      energy: row.energy,
      danceability: row.danceability,
      happiness: row.happiness,
    });
  });
  return songDb;
}
