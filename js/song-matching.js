/**
 * Port of the radio matcher from song_matching.py.
 * Left out on purpose: decensoring, the iTunes catalog checker, and the Metaphone "sounds alike" check.
 */

const MATCH_THRESHOLD = 0.90;
const MARGIN_THRESHOLD = 0.85;
const MARGIN_LEAD_MIN = 0.15;
const TITLE_HURDLE_MIN = 0.85;
const ARTIST_HURDLE_MIN = 0.75;
const WORD_TYPO_SIMILARITY_MIN = 0.75;
const IGNORED_TITLE_WORDS = new Set(['the', 'a', 'an', 'on', 'from', 'in', 'of', 'to', 'by', 'with']);

// ---------- Text normalization ----------

const TRANSLITERATION_MAP = { 'ø': 'o', 'æ': 'ae', 'œ': 'oe', 'ß': 'ss', 'đ': 'd', 'ł': 'l', 'ı': 'i', 'þ': 'th' };
const normalizeCache = new Map();

export function normalizeText(text) {
  const cached = normalizeCache.get(text);
  if (cached !== undefined) return cached;

  const normalized = text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[øæœßđłıþ]/gi, (character) => TRANSLITERATION_MAP[character.toLowerCase()])
    .toLowerCase()
    .replace(/(?<=[a-z])\$|\$(?=[a-z])/g, 's') // Ke$ha -> kesha
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  normalizeCache.set(text, normalized);
  return normalized;
}

const NOISE_TERMS = String.raw`official\s*(?:video|audio|music\s*video|lyric\s*video|visualizer)?|radio\s*edit|remaster(?:ed)?(?:\s*\d{4})?|\d+\s*min(?:ute)?s?\s*(?:edit|version|mix|cut)|explicit|clean\s*version?|extended(?:\s*version?)?|(?:official\s*)?(?:live|acoustic|unplugged)(?:\s*version?)?|\w+(?:'s|s)?\s+version|karaoke(?:\s*version)?|instrumental(?:\s*version)?|sped\s*up|slowed(?:\s*(?:down|\+?\s*reverb))?|tiktok\s*edit|deluxe(?:\s*edition)?|single\s*version|album\s*version|bonus\s*track|anniversary(?:\s*edition)?|ots\s*(?:intro|extro|outro)|(?:original\s*)?(?:mix|version|edit)`;

const FEATURE_PAREN_RE = /\s*[\(\[](feat|ft|with|prod)[\.\s][^\)\]]*[\)\]]/gi;
const NOISE_PAREN_RE = new RegExp(
  String.raw`\s*[\(\[](?:${NOISE_TERMS}|from\s+[^)\]]*|\d{4}\s*(?:remaster|version|mix)?|(?:single|album|short|7\s*inch|7")\s*version?)[^\)\]]*[\)\]]`,
  'gi'
);
const ASTERISK_NOISE_RE = new RegExp(String.raw`\s*\*{1,2}\s*(?:${NOISE_TERMS})\s*\*{0,2}\s*$`, 'i');
const DASH_SUFFIX_RE = new RegExp(String.raw`\s+-\s+(?:${NOISE_TERMS})\s*$`, 'i');

export function stripNoise(title) {
  return title.replace(FEATURE_PAREN_RE, '').replace(NOISE_PAREN_RE, '').replace(DASH_SUFFIX_RE, '').trim();
}

const FEATURE_TAG_RE = /[\(\[]?\s*\b(?:feat(?:uring)?|ft|with|and)\b\.?\s+(?<names>[^\)\]]+?)\s*[\)\]]?$/i;
const FEATURE_NAME_SPLIT_RE = /\s*(?:,|&|\+)\s*|\s+(?:x|and)\s+/i;

function removeFeatureCredit(text) {
  const match = FEATURE_TAG_RE.exec(text);
  return match ? text.slice(0, match.index).trim() : text;
}

function splitWords(text) {
  return text.split(/\s+/).filter(Boolean);
}

function tokenSort(text) {
  return splitWords(text).sort().join(' ');
}

// ---------- String similarity (ports of difflib.SequenceMatcher and Jaro-Winkler) ----------

function longestCommonBlock(textA, aStart, aEnd, textB, bStart, bEnd) {
  let bestAStart = aStart;
  let bestBStart = bStart;
  let bestSize = 0;
  let previousRow = new Array(bEnd - bStart + 1).fill(0);

  for (let i = aStart; i < aEnd; i++) {
    const currentRow = new Array(bEnd - bStart + 1).fill(0);
    for (let j = bStart; j < bEnd; j++) {
      if (textA[i] !== textB[j]) continue;
      const size = previousRow[j - bStart] + 1;
      currentRow[j - bStart + 1] = size;
      if (size > bestSize) {
        bestSize = size;
        bestAStart = i - size + 1;
        bestBStart = j - size + 1;
      }
    }
    previousRow = currentRow;
  }
  return { aStart: bestAStart, bStart: bestBStart, size: bestSize };
}

export function sequenceRatio(textA, textB) {
  const totalLength = textA.length + textB.length;
  if (totalLength === 0) return 1;

  let matchedCharCount = 0;
  const pendingRanges = [[0, textA.length, 0, textB.length]];
  while (pendingRanges.length > 0) {
    const [aStart, aEnd, bStart, bEnd] = pendingRanges.pop();
    const block = longestCommonBlock(textA, aStart, aEnd, textB, bStart, bEnd);
    if (block.size === 0) continue;
    matchedCharCount += block.size;
    if (aStart < block.aStart && bStart < block.bStart) {
      pendingRanges.push([aStart, block.aStart, bStart, block.bStart]);
    }
    if (block.aStart + block.size < aEnd && block.bStart + block.size < bEnd) {
      pendingRanges.push([block.aStart + block.size, aEnd, block.bStart + block.size, bEnd]);
    }
  }
  return (2 * matchedCharCount) / totalLength;
}

function quickRatio(textA, textB) {
  const totalLength = textA.length + textB.length;
  if (totalLength === 0) return 1;

  const availableCounts = new Map();
  for (const character of textB) availableCounts.set(character, (availableCounts.get(character) || 0) + 1);

  let matchedCharCount = 0;
  for (const character of textA) {
    const available = availableCounts.get(character) || 0;
    if (available > 0) {
      matchedCharCount++;
      availableCounts.set(character, available - 1);
    }
  }
  return (2 * matchedCharCount) / totalLength;
}

function jaroWinkler(textA, textB) {
  if (textA === textB) return 1;
  if (!textA.length || !textB.length) return 0;

  const matchWindow = Math.max(0, Math.floor(Math.max(textA.length, textB.length) / 2) - 1);
  const aMatched = new Array(textA.length).fill(false);
  const bMatched = new Array(textB.length).fill(false);
  let matchCount = 0;

  for (let i = 0; i < textA.length; i++) {
    const windowStart = Math.max(0, i - matchWindow);
    const windowEnd = Math.min(textB.length - 1, i + matchWindow);
    for (let j = windowStart; j <= windowEnd; j++) {
      if (bMatched[j] || textA[i] !== textB[j]) continue;
      aMatched[i] = true;
      bMatched[j] = true;
      matchCount++;
      break;
    }
  }
  if (matchCount === 0) return 0;

  let transpositionCount = 0;
  let bIndex = 0;
  for (let i = 0; i < textA.length; i++) {
    if (!aMatched[i]) continue;
    while (!bMatched[bIndex]) bIndex++;
    if (textA[i] !== textB[bIndex]) transpositionCount++;
    bIndex++;
  }

  const jaro = (matchCount / textA.length + matchCount / textB.length + (matchCount - transpositionCount / 2) / matchCount) / 3;
  if (jaro <= 0.7) return jaro;

  let commonPrefixLength = 0;
  while (commonPrefixLength < 4 && commonPrefixLength < Math.min(textA.length, textB.length)
         && textA[commonPrefixLength] === textB[commonPrefixLength]) {
    commonPrefixLength++;
  }
  return jaro + commonPrefixLength * 0.1 * (1 - jaro);
}

// ---------- Title word helpers ----------

function buildWordCompounds(words) {
  const compounds = new Set(words);
  for (let i = 0; i < words.length - 1; i++) compounds.add(words[i] + words[i + 1]);
  return compounds;
}

function setsShareAnyItem(setA, setB) {
  for (const item of setA) if (setB.has(item)) return true;
  return false;
}

function countSharedItems(setA, setB) {
  let sharedCount = 0;
  for (const item of setA) if (setB.has(item)) sharedCount++;
  return sharedCount;
}

function hasConflictingTitleWord(queryWordSet, dbWordSet, queryFlatTitle, dbFlatTitle) {
  if (queryFlatTitle === dbFlatTitle) return false;

  const queryOnlyWords = [...queryWordSet].filter((word) => !dbWordSet.has(word) && !IGNORED_TITLE_WORDS.has(word));
  const dbOnlyWords = [...dbWordSet].filter((word) => !queryWordSet.has(word) && !IGNORED_TITLE_WORDS.has(word));
  if (queryOnlyWords.length === 0 || dbOnlyWords.length === 0) return false;

  const isTypoClose = (word, otherWord) => sequenceRatio(word, otherWord) >= WORD_TYPO_SIMILARITY_MIN;
  const everyWordHasPartner = (words, otherWords) =>
    words.every((word) => otherWords.some((otherWord) => isTypoClose(word, otherWord)));

  return !(everyWordHasPartner(queryOnlyWords, dbOnlyWords) && everyWordHasPartner(dbOnlyWords, queryOnlyWords));
}

// ---------- Song database ----------

export function makeSongDbKey(title, artist) {
  return `${normalizeText(stripNoise(String(title)))}|||${normalizeText(String(artist))}`;
}

function buildMatcherEntries(songDb) {
  return [...songDb.keys()].map((key) => {
    const separatorIndex = key.indexOf('|||');
    const title = key.slice(0, separatorIndex);
    const artist = key.slice(separatorIndex + 3);
    const strippedTitle = stripNoise(title);
    const strippedWords = splitWords(strippedTitle);
    const primaryArtist = removeFeatureCredit(artist).trim();
    return {
      key,
      title,
      artist,
      strippedTitle,
      flatTitle: strippedTitle.replace(/ /g, ''),
      chars: new Set(strippedTitle.replace(/ /g, '')),
      words: strippedWords,
      wordSet: new Set(strippedWords),
      wordCompounds: buildWordCompounds(strippedWords),
      tokenSortedTitle: tokenSort(title),
      tokenSortedStrippedTitle: tokenSort(strippedTitle),
      primaryArtist,
      tokenSortedPrimaryArtist: tokenSort(primaryArtist),
      flatPrimaryArtist: primaryArtist.replace(/ /g, ''),
    };
  });
}

// ---------- Scoring ----------

function scoreAllEntries(normalizedTitle, normalizedArtist, entries) {
  const queryStrippedTitle = stripNoise(normalizedTitle);
  const queryFlatTitle = queryStrippedTitle.replace(/ /g, '');
  const queryTokenSortedTitle = tokenSort(normalizedTitle);
  const queryTokenSortedStrippedTitle = tokenSort(queryStrippedTitle);
  const queryChars = new Set(queryFlatTitle);
  const queryCharCount = queryChars.size || 1;
  const queryWords = splitWords(queryStrippedTitle);
  const queryWordSet = new Set(queryWords);
  const queryWordCompounds = buildWordCompounds(queryWords);
  const queryPureWords = queryWords.filter((word) => !IGNORED_TITLE_WORDS.has(word));
  const queryPrimaryArtist = removeFeatureCredit(normalizedArtist).trim();
  const queryTokenSortedArtist = tokenSort(queryPrimaryArtist);
  const queryFlatArtist = queryPrimaryArtist.replace(/ /g, '');

  const scored = [];

  for (const entry of entries) {
    // ----- Cheap pre-filters -----
    const lengthGap = Math.abs(queryStrippedTitle.length - entry.strippedTitle.length);
    if (lengthGap > Math.max(queryStrippedTitle.length, entry.strippedTitle.length) * 0.60) continue;
    if (countSharedItems(queryChars, entry.chars) / queryCharCount <= 0.35) continue;

    const typoSimilarity = quickRatio(queryFlatTitle, entry.flatTitle);

    if (queryStrippedTitle.length > 4 && entry.strippedTitle.length > 4 && queryWordSet.size && entry.wordSet.size) {
      const sharesWordOrCompound = setsShareAnyItem(queryWordCompounds, entry.wordCompounds);
      const isFlatSubstring = queryFlatTitle.includes(entry.flatTitle) || entry.flatTitle.includes(queryFlatTitle);
      if (!sharesWordOrCompound && !isFlatSubstring && typoSimilarity < 0.75) continue;
    }

    // ----- Title signal -----
    const titleSignal = Math.max(
      sequenceRatio(normalizedTitle, entry.title),
      sequenceRatio(queryTokenSortedTitle, entry.tokenSortedTitle),
      sequenceRatio(queryStrippedTitle, entry.strippedTitle),
      sequenceRatio(queryTokenSortedStrippedTitle, entry.tokenSortedStrippedTitle),
      jaroWinkler(queryStrippedTitle, entry.strippedTitle)
    );

    const [shorterTitle, longerTitle] = queryStrippedTitle.length <= entry.strippedTitle.length
      ? [queryStrippedTitle, entry.strippedTitle]
      : [entry.strippedTitle, queryStrippedTitle];
    const isTitleSubstring = longerTitle.length > 0
      && longerTitle.includes(shorterTitle)
      && shorterTitle.length / longerTitle.length >= 0.60;

    // ----- Artist signal (primary artist only, no Jaro-Winkler on purpose) -----
    const artistRatio = sequenceRatio(queryPrimaryArtist, entry.primaryArtist);
    const artistTokenRatio = sequenceRatio(queryTokenSortedArtist, entry.tokenSortedPrimaryArtist);
    let artistSignal = Math.max(artistRatio, artistTokenRatio);

    const isArtistFlatSubstring = queryFlatArtist.length >= 3
      && (entry.flatPrimaryArtist.includes(queryFlatArtist) || queryFlatArtist.includes(entry.flatPrimaryArtist));
    if (isArtistFlatSubstring) artistSignal = Math.max(artistSignal, 0.75);

    const isArtistSubstring = isArtistFlatSubstring || (
      queryPrimaryArtist.length >= 3
      && (entry.primaryArtist.includes(queryPrimaryArtist) || queryPrimaryArtist.includes(entry.primaryArtist))
    );
    const isArtistMismatch = artistRatio <= 0.45 && artistTokenRatio <= 0.45 && !isArtistSubstring;

    // ----- Confidence -----
    const dbPureWords = entry.words.filter((word) => !IGNORED_TITLE_WORDS.has(word));
    const queryPureFlat = queryPureWords.join('');
    const dbPureFlat = dbPureWords.join('');
    const isCompoundMatch = Boolean(queryPureFlat && dbPureFlat)
      && (dbPureFlat.includes(queryPureFlat) || queryPureFlat.includes(dbPureFlat));

    const sharedPureWordCount = countSharedItems(new Set(queryPureWords), new Set(dbPureWords));
    const isTokenHallucination = sharedPureWordCount === 0 && !isCompoundMatch
      && queryPureWords.length > 0 && dbPureWords.length > 0 && typoSimilarity < 0.75;

    const hasConflictingWord = !isTitleSubstring && !isCompoundMatch
      && hasConflictingTitleWord(queryWordSet, entry.wordSet, queryFlatTitle, entry.flatTitle);

    let confidence;
    if (titleSignal < 0.40 || isTokenHallucination) {
      confidence = titleSignal * 0.05;
    } else if (hasConflictingWord) {
      confidence = titleSignal * 0.20;
    } else if (titleSignal < 0.55 && artistSignal > 0.85) {
      confidence = titleSignal * 0.10;
    } else if (isArtistMismatch && titleSignal >= 0.40) {
      confidence = titleSignal * 0.20;
    } else {
      confidence = titleSignal * 0.65;
      if (isTitleSubstring) confidence = Math.max(confidence, 0.50);
      confidence += artistSignal * 0.35;
    }

    scored.push({ key: entry.key, confidence, titleSimilarity: titleSignal, artistSimilarity: artistSignal, isArtistMismatch });
  }

  scored.sort((candidateA, candidateB) => candidateB.confidence - candidateA.confidence);
  return scored;
}

function decideMatch(scored) {
  if (scored.length === 0) return { key: null, confidence: 0, reason: 'No candidates' };

  const best = scored[0];
  if (best.titleSimilarity < TITLE_HURDLE_MIN || best.artistSimilarity < ARTIST_HURDLE_MIN) {
    return { key: null, confidence: best.confidence, reason: 'Title/artist hurdle failed' };
  }
  if (best.confidence >= MATCH_THRESHOLD) {
    return { key: best.key, confidence: best.confidence, reason: 'Strict match' };
  }
  if (best.confidence >= MARGIN_THRESHOLD && scored.length > 1) {
    if (best.isArtistMismatch) return { key: null, confidence: best.confidence, reason: 'Artist mismatch' };
    const margin = best.confidence - scored[1].confidence;
    if (margin >= MARGIN_LEAD_MIN) return { key: best.key, confidence: best.confidence, reason: 'Margin lead' };
    return { key: null, confidence: best.confidence, reason: 'Low margin lead' };
  }
  return { key: null, confidence: best.confidence, reason: 'Score below threshold' };
}

// ---------- Public finder ----------

/** Returns findSong(title, artist) -> { key | null, confidence, reason }. Results are cached per unique query. */
export function createSongFinder(songDb) {
  const entries = buildMatcherEntries(songDb);
  const queryResultCache = new Map();

  function prepareQuery(title, artist) {
    return [normalizeText(stripNoise(title.replace(ASTERISK_NOISE_RE, ''))), normalizeText(artist)];
  }

  function findInGivenOrder(title, artist) {
    const [normalizedTitle, normalizedArtist] = prepareQuery(title, artist);
    if (!normalizedTitle.trim() || !normalizedArtist.trim()) {
      return { key: null, confidence: 0, reason: 'Missing title/artist' };
    }

    const exactKeyCandidates = [
      `${normalizedTitle}|||${normalizedArtist}`,
      `${stripNoise(normalizedTitle)}|||${stripNoise(normalizedArtist)}`,
    ];
    const exactKey = exactKeyCandidates.find((candidateKey) => songDb.has(candidateKey));
    if (exactKey) return { key: exactKey, confidence: 1, reason: 'Exact match' };

    const cacheKey = `${normalizedTitle}|||${normalizedArtist}`;
    if (!queryResultCache.has(cacheKey)) {
      queryResultCache.set(cacheKey, decideMatch(scoreAllEntries(normalizedTitle, normalizedArtist, entries)));
    }
    return queryResultCache.get(cacheKey);
  }

  // Radio feeds sometimes swap artist/title, so retry swapped when nothing matched.
  return function findSong(title, artist = '') {
    const givenOrderResult = findInGivenOrder(title, artist);
    if (givenOrderResult.key !== null || !title.trim() || !artist.trim()) return givenOrderResult;

    const swappedResult = findInGivenOrder(artist, title);
    return swappedResult.key !== null
      ? { ...swappedResult, reason: `${swappedResult.reason} (artist/title swapped)` }
      : givenOrderResult;
  };
}
