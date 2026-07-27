function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cleanString(value) {
  return String(value || "").trim();
}

function splitTitleList(value) {
  if (Array.isArray(value)) return value.flatMap((item) => splitTitleList(item));
  const text = cleanString(value);
  if (!text) return [];
  return text
    .split(/[,\n;|]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const cleaned = cleanString(value);
    const key = cleaned.toLowerCase();
    if (!cleaned || seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
  }
  return result;
}

function pickMetadataValues(metadata, keys) {
  if (!isPlainObject(metadata)) return [];
  const values = [];
  for (const key of keys) {
    if (metadata[key] !== undefined) values.push(metadata[key]);
  }

  for (const nestedKey of ["job", "lead", "target", "persona", "role"]) {
    const nested = metadata[nestedKey];
    if (!isPlainObject(nested)) continue;
    for (const key of keys) {
      if (nested[key] !== undefined) values.push(nested[key]);
    }
  }

  return values;
}

export function extractLeadTitles(metadata = {}, explicitTitles = []) {
  const titleKeys = [
    "jobTitle",
    "job_title",
    "title",
    "targetTitle",
    "target_title",
    "targetTitles",
    "target_titles",
    "leadTitle",
    "lead_title",
    "leadTitles",
    "lead_titles",
    "role",
    "targetRole",
    "target_role",
    "roles",
    "personTitle",
    "person_title",
    "personaTitle",
    "persona_title"
  ];

  return uniqueStrings([
    ...splitTitleList(explicitTitles),
    ...pickMetadataValues(metadata, titleKeys).flatMap((value) => splitTitleList(value))
  ]);
}

export function extractLeadLocation(metadata = {}) {
  const locationKeys = [
    "location",
    "locations",
    "city",
    "state",
    "country",
    "region",
    "market",
    "territory"
  ];
  return uniqueStrings(pickMetadataValues(metadata, locationKeys).flatMap((value) => splitTitleList(value))).join(", ");
}

function words(value) {
  return cleanString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 1);
}

export function titleRelevance(title, targetTitles = []) {
  const titleText = cleanString(title).toLowerCase();
  if (!titleText || !targetTitles.length) return 0;

  let best = 0;
  for (const targetTitle of targetTitles) {
    const targetText = cleanString(targetTitle).toLowerCase();
    if (!targetText) continue;
    if (titleText === targetText) best = Math.max(best, 1);
    if (titleText.includes(targetText) || targetText.includes(titleText)) best = Math.max(best, 0.85);

    const titleWords = new Set(words(titleText));
    const targetWords = words(targetText);
    if (!targetWords.length) continue;
    const overlap = targetWords.filter((word) => titleWords.has(word)).length / targetWords.length;
    best = Math.max(best, overlap);
  }

  return best;
}

export function buildLeadContext(metadata = {}, explicitTitles = []) {
  return {
    targetTitles: extractLeadTitles(metadata, explicitTitles),
    location: extractLeadLocation(metadata)
  };
}
