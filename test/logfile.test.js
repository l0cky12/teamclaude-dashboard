import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadLog, appendLog } from '../lib/logfile.js';

const rows = [{ at: 10, a: 1 }, { at: 50, a: 2 }, { at: 90, a: 3 }];
const text = rows.map(r => JSON.stringify(r)).join('\n') + '\nnot json\n';
const fakeFs = (over = {}) => {
  const writes = [], appends = [];
  return {
    writes, appends,
    mkdir: async () => {},
    readFile: async () => text,
    writeFile: async (f, body) => { writes.push(body); },
    appendFile: async (f, body) => { appends.push(body); },
    ...over,
  };
};

test('loadLog keeps rows inside the window, drops bad lines, and compacts the file', async () => {
  const fs = fakeFs();
  const out = await loadLog('/x/log.jsonl', { retainMs: 60, now: 100, fs });
  assert.deepEqual(out.map(r => r.a), [2, 3]);
  assert.equal(fs.writes.length, 1);
  assert.equal(fs.writes[0], '{"at":50,"a":2}\n{"at":90,"a":3}\n');
});

test('loadLog still returns the rows when compaction fails', async () => {
  const logged = [];
  const fs = fakeFs({ writeFile: async () => { throw new Error('read-only'); } });
  const out = await loadLog('/x/log.jsonl', { retainMs: 1000, now: 100, fs, log: m => logged.push(m) });
  assert.equal(out.length, 3);
  assert.match(logged[0], /could not compact/);
});

test('loadLog treats a missing file as empty without logging', async () => {
  const logged = [];
  const fs = fakeFs({ readFile: async () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); } });
  assert.deepEqual(await loadLog('/x/log.jsonl', { retainMs: 1000, fs, log: m => logged.push(m) }), []);
  assert.deepEqual(logged, []);
});

test('appendLog writes the rows and trims the in-memory list to the window', async () => {
  const fs = fakeFs();
  const list = [{ at: 10 }, { at: 50 }];
  const out = await appendLog('/x/log.jsonl', list, [{ at: 95 }], { retainMs: 60, now: 100, fs });
  assert.equal(fs.appends[0], '{"at":95}\n');
  assert.deepEqual(out.map(r => r.at), [50, 95]);
  assert.equal(await appendLog('/x/log.jsonl', list, [], { retainMs: 60, now: 100, fs }), list, 'nothing to append returns the list as is');
});
