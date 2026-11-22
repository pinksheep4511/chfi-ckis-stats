import { isAuthorized } from './auth.js';
import { STATIONS, loadStationSongRows, fetchRecentTracks, buildSongDatabase, isMissing } from './stations.js';
import { createSongFinder } from './song-matching.js';

const RECENT_ENTRIES_DISPLAY_LIMIT = 50;
const EMPTY_CELL_TEXT = '\u2014';
const BETTER_MARK = '\u25B2';
const WORSE_MARK = '\u25BC';
const MATCH_YIELD_INTERVAL = 25; // let the browser repaint the status text while matching

// ---------- Metric definitions (add a stat by adding one object) ----------

const SUMMARY_ROWS = [
  { label: 'Avg', statKey: 'average', comparable: true },
  { label: 'Std dev', statKey: 'standardDeviation', comparable: false },
  { label: 'Min', statKey: 'minimum', comparable: false },
  { label: 'Median', statKey: 'median', comparable: true },
  { label: 'Max', statKey: 'maximum', comparable: true },
];

const formatNumber = (value, decimals) => value.toFixed(decimals);

function formatDuration(totalSeconds, decimals = 1) {
  const rounded = Number(totalSeconds.toFixed(decimals));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor(rounded / 60) % 60;
  const seconds = (rounded % 60).toFixed(decimals);
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

// population: 'matchedSongs' = songs found in the song list, 'playLengths' = length_seconds of every play
const SECTIONS = [
  { title: 'Notes', population: 'matchedSongs', getValue: (song) => song.notes, format: formatNumber, decimals: 1 },
  { title: 'Duration', population: 'matchedSongs', getValue: (song) => song.durationSeconds, format: formatDuration, decimals: 1 },
  { title: 'Effective duration (all plays)', population: 'playLengths', getValue: (seconds) => seconds, format: formatDuration, decimals: 1 },
  { title: 'Notes / sec', population: 'matchedSongs', getValue: (song) => song.notesPerSecond, format: formatNumber, decimals: 3 },
  { title: 'BPM', population: 'matchedSongs', getValue: (song) => song.bpm, format: formatNumber, decimals: 1 },
  { title: 'Energy', population: 'matchedSongs', getValue: (song) => song.energy, format: formatNumber, decimals: 1 },
  { title: 'Danceability', population: 'matchedSongs', getValue: (song) => song.danceability, format: formatNumber, decimals: 1 },
  { title: 'Happiness', population: 'matchedSongs', getValue: (song) => song.happiness, format: formatNumber, decimals: 1 },
];

// ---------- Stats ----------

function summarize(values) {
  const count = values.length;
  if (count === 0) return null;

  const sorted = [...values].sort((valueA, valueB) => valueA - valueB);
  const average = sorted.reduce((sum, value) => sum + value, 0) / count;
  const sumOfSquares = sorted.reduce((sum, value) => sum + (value - average) ** 2, 0);
  const middleIndex = Math.floor(count / 2);

  return {
    count,
    average,
    standardDeviation: count > 1 ? Math.sqrt(sumOfSquares / (count - 1)) : null, // sample std dev, like stddev() in Python
    minimum: sorted[0],
    median: count % 2 ? sorted[middleIndex] : (sorted[middleIndex - 1] + sorted[middleIndex]) / 2,
    maximum: sorted[count - 1],
  };
}

function buildStationResult(station, playEntries) {
  const populations = {
    matchedSongs: playEntries.filter((entry) => entry.song).map((entry) => entry.song),
    playLengths: playEntries.map((entry) => Number(entry.track.length_seconds)).filter((seconds) => seconds > 0),
  };

  const summaries = {};
  SECTIONS.forEach((section) => {
    const values = populations[section.population].map(section.getValue).filter((value) => !isMissing(value) && Number.isFinite(value));
    summaries[section.title] = summarize(values);
  });

  return {
    station,
    playEntries,
    totalPlays: playEntries.length,
    matchedCount: populations.matchedSongs.length,
    summaries,
  };
}

// ---------- Data loading ----------

const yieldToBrowser = () => new Promise((resolve) => setTimeout(resolve));

async function loadStationResult(station, setStatus) {
  const [songRows, tracks] = await Promise.all([loadStationSongRows(station), fetchRecentTracks(station)]);
  const songDb = buildSongDatabase(songRows, station);
  const findSong = createSongFinder(songDb);

  const playEntries = [];
  for (let trackIndex = 0; trackIndex < tracks.length; trackIndex++) {
    const track = tracks[trackIndex];
    const match = findSong(track.title, track.artist);
    playEntries.push({ track, song: match.key ? songDb.get(match.key) : null });

    if (trackIndex % MATCH_YIELD_INTERVAL === 0) {
      setStatus(`Matching ${station.callSign} songs... (${trackIndex}/${tracks.length})`);
      await yieldToBrowser();
    }
  }
  return buildStationResult(station, playEntries);
}

// ---------- Rendering ----------

function createElement(tagName, text, className) {
  const element = document.createElement(tagName);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function makeRow(label, comparable, stationResults, getCell) {
  return { label, comparable, cells: stationResults.map(getCell) };
}

function buildComparisonRows(stationResults) {
  const rows = [{ header: 'Coverage' }];
  rows.push(makeRow('Total plays', true, stationResults, (result) => ({ text: String(result.totalPlays), compareValue: result.totalPlays })));
  rows.push(makeRow('Matched', true, stationResults, (result) => ({ text: String(result.matchedCount), compareValue: result.matchedCount })));
  rows.push(makeRow('Match rate', true, stationResults, (result) => {
    if (!result.totalPlays) return { text: EMPTY_CELL_TEXT, compareValue: null };
    const matchRate = (100 * result.matchedCount) / result.totalPlays;
    return { text: `${matchRate.toFixed(1)}%`, compareValue: Number(matchRate.toFixed(1)) };
  }));

  SECTIONS.forEach((section) => {
    rows.push({ header: section.title });
    SUMMARY_ROWS.forEach((summaryRow) => {
      rows.push(makeRow(summaryRow.label, summaryRow.comparable, stationResults, (result) => {
        const summary = result.summaries[section.title];
        const value = summary?.[summaryRow.statKey];
        if (value === null || value === undefined) {
          const isSingleSampleStdDev = summaryRow.statKey === 'standardDeviation' && summary?.count === 1;
          return { text: isSingleSampleStdDev ? 'N/A' : EMPTY_CELL_TEXT, compareValue: null };
        }
        return { text: section.format(value, section.decimals), compareValue: Number(value.toFixed(section.decimals)) };
      }));
    });
  });
  return rows;
}

// Marks the higher cell green and the lower red, only when comparing exactly two stations.
function getComparisonClasses(row, stationCount) {
  const noClasses = row.cells.map(() => ({ className: '', mark: '' }));
  if (!row.comparable || stationCount !== 2) return noClasses;

  const [firstValue, secondValue] = row.cells.map((cell) => cell.compareValue);
  if (firstValue === null || secondValue === null || firstValue === secondValue) return noClasses;

  const firstIsHigher = firstValue > secondValue;
  return [
    { className: firstIsHigher ? 'better' : 'worse', mark: firstIsHigher ? BETTER_MARK : WORSE_MARK },
    { className: firstIsHigher ? 'worse' : 'better', mark: firstIsHigher ? WORSE_MARK : BETTER_MARK },
  ];
}

function renderComparisonTable(stationResults) {
  const table = document.getElementById('comparison-table');
  table.replaceChildren();

  const headerRow = createElement('tr');
  headerRow.appendChild(createElement('th', 'Stat'));
  stationResults.forEach((result) => {
    const headerCell = createElement('th', result.station.callSign);
    headerCell.style.color = `var(${result.station.accentVariable})`;
    headerRow.appendChild(headerCell);
  });
  table.appendChild(createElement('thead')).appendChild(headerRow);

  const body = table.appendChild(createElement('tbody'));
  buildComparisonRows(stationResults).forEach((row) => {
    const tableRow = createElement('tr');
    if (row.header) {
      const headerCell = createElement('th', row.header, 'section-header');
      headerCell.colSpan = stationResults.length + 1;
      tableRow.appendChild(headerCell);
    } else {
      tableRow.appendChild(createElement('td', row.label));
      const classes = getComparisonClasses(row, stationResults.length);
      row.cells.forEach((cell, cellIndex) => {
        const text = classes[cellIndex].mark ? `${classes[cellIndex].mark} ${cell.text}` : cell.text;
        tableRow.appendChild(createElement('td', text, classes[cellIndex].className));
      });
    }
    body.appendChild(tableRow);
  });
}

function formatSongStatsLine(song) {
  return `\u266A ${song.notes} \u00B7 \u231A ${formatDuration(song.durationSeconds, 0)} \u00B7 \u26A1 ${song.notesPerSecond.toFixed(2)} \u00B7 ${song.bpm} BPM`;
}

let lastStationResults = [];

function renderRecentlyPlayed() {
  const container = document.getElementById('recent-lists');
  container.replaceChildren();
  const showSongStats = document.getElementById('show-song-stats').checked;

  lastStationResults.forEach((result) => {
    const stationColumn = createElement('div', undefined, 'recent-column');
    const heading = createElement('h3', `${result.station.callSign} recently played`);
    heading.style.color = `var(${result.station.accentVariable})`;
    stationColumn.appendChild(heading);

    result.playEntries.slice(0, RECENT_ENTRIES_DISPLAY_LIMIT).forEach(({ track, song }) => {
      const card = createElement('div', undefined, 'track-card');
      card.append(
        createElement('div', `${track.title} - ${track.artist}`, 'track-title'),
        createElement('div', `${track.play_date} \u00B7 ${track.start_time}`, 'track-time')
      );
      if (showSongStats) {
        card.appendChild(
          song
            ? createElement('div', formatSongStatsLine(song), 'track-stats')
            : createElement('div', 'Not in list yet', 'track-unmatched')
        );
      }
      stationColumn.appendChild(card);
    });
    container.appendChild(stationColumn);
  });
}

// ---------- Page wiring ----------

function getSelectedStations() {
  const selectedValue = document.getElementById('station-select').value;
  return selectedValue === 'BOTH' ? STATIONS : STATIONS.filter((station) => station.callSign === selectedValue);
}

async function runComparison() {
  const runButton = document.getElementById('run-button');
  const statusElement = document.getElementById('status-message');
  const setStatus = (message) => { statusElement.textContent = message; };

  runButton.disabled = true;
  setStatus('Loading song lists and recent plays...');
  try {
    lastStationResults = await Promise.all(getSelectedStations().map((station) => loadStationResult(station, setStatus)));
    renderComparisonTable(lastStationResults);
    renderRecentlyPlayed();
    setStatus('');
  } catch (error) {
    setStatus(`Comparison failed: ${error.message}`);
  } finally {
    runButton.disabled = false;
  }
}

if (isAuthorized()) {
  document.getElementById('run-button').addEventListener('click', runComparison);
  document.getElementById('show-song-stats').addEventListener('change', renderRecentlyPlayed);
} else {
  document.body.innerHTML = 'Not authorized. <a href="index.html#edit" style="color:#00e5ff">Unlock editing first</a>.';
}
