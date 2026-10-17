// Append-only JSONL logs with a retention window: the request log and the
// account event log. Rows carry an `at` timestamp; anything older than the
// window is dropped on load (and the file rewritten) and after each append.
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const defaultFs = { readFile, writeFile, appendFile, mkdir };

/**
 * Rows newer than the retention cutoff, compacted back to disk. A missing
 * file is empty. A file that reads but cannot be rewritten still yields its
 * rows: history is worth more than a tidy file.
 */
export async function loadLog(file, { retainMs, now = Date.now(), fs = defaultFs, log = console.error } = {}) {
  await fs.mkdir(dirname(file), { recursive: true });
  let rows;
  try {
    const cutoff = now - retainMs;
    rows = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(t => t && t.at >= cutoff);
  } catch (err) {
    if (err.code !== 'ENOENT') log(`[dashboard] could not read ${file}: ${err.message}`);
    return [];
  }
  try { await fs.writeFile(file, rows.map(t => JSON.stringify(t)).join('\n') + (rows.length ? '\n' : '')); }
  catch (err) { log(`[dashboard] could not compact ${file}: ${err.message}`); }
  return rows;
}

/** Append rows to the file and the in-memory list; returns the list trimmed to the retention window. */
export async function appendLog(file, list, rows, { retainMs, now = Date.now(), fs = defaultFs, log = console.error } = {}) {
  if (!rows.length) return list;
  list.push(...rows);
  // ponytail: the file only grows between restarts; loadLog() compacts it on start.
  await fs.appendFile(file, rows.map(r => JSON.stringify(r) + '\n').join('')).catch(err => log(`[dashboard] could not write ${file}: ${err.message}`));
  const cutoff = now - retainMs;
  return list.length && list[0].at < cutoff ? list.filter(x => x.at >= cutoff) : list;
}
