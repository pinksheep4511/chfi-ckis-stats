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

export async function fetchRecentTracks(station, dayCount = RECENT_DAY_COUNT) {
  const response = await fetch(`${RECENTLY_PLAYED_API_URL}?station=${station.callSign}&days=${dayCount}`);
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
  const allNotes = [...songDb.values()].map((song) => song.notes);
  songDb.forEach((song) => {
    const lowerCount = allNotes.filter((notes) => notes < song.notes).length;
    const tiedCount = allNotes.filter((notes) => notes === song.notes).length;
    song.notePercentile = Math.round(((lowerCount + 0.5 * tiedCount) / allNotes.length) * 100);
  });
  return songDb;
}

export const TIME_ZONE = 'America/Toronto';
export const RECENT_DAY_COUNT = 7; // the Apps Script returns today plus the 6 days before it

const dateLabelFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }); // gives yyyy-MM-dd

/** yyyy-MM-dd labels, today first. Calendar arithmetic, so daylight saving can't skip or repeat a day. */
export function buildRecentDateLabels(dayCount = RECENT_DAY_COUNT) {
  const [year, month, day] = dateLabelFormatter.format(new Date()).split('-').map(Number);
  return Array.from({ length: dayCount }, (_, daysAgo) =>
    new Date(Date.UTC(year, month - 1, day - daysAgo)).toISOString().slice(0, 10)
  );
}
