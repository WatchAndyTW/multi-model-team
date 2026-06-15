/**
 * score.mjs — size + keyword-type scoring (replaces score.sh).
 * Parity: charCount matches `wc -m`; classify matches mmt_classify.
 */
import { readFileSync } from 'fs';

/**
 * Count Unicode code points in a string (parity with `wc -m`).
 * @param {string} task
 * @returns {number}
 */
export function charCount(task) {
  // Spread to count code points (not UTF-16 code units), matching wc -m behaviour.
  return [...task].length;
}

/**
 * Classify a task string against tags.txt, returning de-duplicated type labels.
 * @param {string} task
 * @param {string} tagsPath  absolute path to config/tags.txt
 * @returns {string[]}
 */
export function classify(task, tagsPath) {
  let raw;
  try {
    raw = readFileSync(tagsPath, 'utf8');
  } catch {
    return [];
  }

  const seen = new Set();
  const result = [];

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    // Skip blanks and comments.
    if (!trimmed || trimmed.startsWith('#')) continue;

    // First token = label, remainder = ERE pattern.
    const spaceIdx = trimmed.search(/\s/);
    if (spaceIdx === -1) continue;
    const label = trimmed.slice(0, spaceIdx);
    const pat = trimmed.slice(spaceIdx).trim();
    if (!pat) continue;

    // Case-insensitive ERE match against the full task text.
    let re;
    try {
      re = new RegExp(pat, 'i');
    } catch {
      continue; // skip malformed patterns
    }

    if (re.test(task)) {
      if (!seen.has(label)) {
        seen.add(label);
        result.push(label);
      }
    }
  }

  return result;
}
