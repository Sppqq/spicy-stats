const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const worker = fs.readFileSync(path.join(__dirname, '..', 'cloudflare_pages', 'worker.js'), 'utf8');

test('global refresh cadence follows current 24-hour growth bands', () => {
    assert.match(worker, /WHEN past\.id IS NULL THEN 30/);
    assert.match(worker, />= 10000 THEN 30/);
    assert.match(worker, />= 5000 THEN 60/);
    assert.match(worker, />= 1000 THEN 120/);
    assert.match(worker, />= 250 THEN 240/);
    assert.match(worker, /ELSE 360/);
});

test('eligible profiles are ranked by overdue ratio to prevent starvation', () => {
    assert.match(worker, /waiting_minutes >= interval_minutes/);
    assert.match(worker, /ORDER BY \(waiting_minutes \/ interval_minutes\) DESC, growth_24h DESC/);
    assert.match(worker, /LIMIT 10/);
});
