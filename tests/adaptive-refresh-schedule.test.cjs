const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const worker = fs.readFileSync(path.join(__dirname, '..', 'cloudflare_pages', 'worker.js'), 'utf8');

test('global refresh cadence is fixed at two hours for every profile', () => {
    assert.match(worker, /last_scraped_at <= datetime\('now', '-120 minutes'\)/);
    assert.doesNotMatch(worker, /WHEN past\.id IS NULL THEN 30/);
    assert.doesNotMatch(worker, />= 10000 THEN 30/);
});

test('eligible profiles are processed from the oldest dispatch first', () => {
    assert.match(worker, /ORDER BY CASE WHEN last_scraped_at IS NULL THEN 0 ELSE 1 END, last_scraped_at ASC, id ASC/);
    assert.match(worker, /LIMIT 10/);
});
