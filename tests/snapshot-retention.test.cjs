const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const worker = fs.readFileSync(path.join(root, 'cloudflare_pages', 'worker.js'), 'utf8');

function extractFunction(name) {
    const start = worker.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `${name} should exist`);
    const bodyStart = worker.indexOf('{', start);
    let depth = 0;
    for (let index = bodyStart; index < worker.length; index++) {
        if (worker[index] === '{') depth++;
        if (worker[index] === '}' && --depth === 0) return worker.slice(start, index + 1);
    }
    throw new Error(`Could not extract ${name}`);
}

const context = { DENSE_SNAPSHOT_INTERVAL_MS: 6 * 60 * 60 * 1000 };
vm.runInNewContext(`${extractFunction('selectSnapshotsForPruning')}; this.selectSnapshotsForPruning = selectSnapshotsForPruning;`, context);
const selectSnapshotsForPruning = context.selectSnapshotsForPruning;

function snapshot(id, timestamp, totalSongs = 10) {
    return { id, timestamp, total_songs: totalSongs };
}

test('retention thins dense interior snapshots before old sparse history', () => {
    const snapshots = [
        snapshot(1, '2026-06-01T00:00:00Z'),
        snapshot(2, '2026-06-15T00:00:00Z'),
        snapshot(3, '2026-07-01T00:00:00Z'),
        snapshot(4, '2026-07-01T00:15:00Z'),
        snapshot(5, '2026-07-01T00:30:00Z'),
        snapshot(6, '2026-07-01T00:45:00Z'),
        snapshot(7, '2026-08-01T00:00:00Z')
    ];

    const selected = Array.from(selectSnapshotsForPruning(snapshots, 2));
    assert.deepEqual(selected.sort((a, b) => a - b), [4, 5]);
    assert.ok(!selected.includes(1), 'the oldest historical anchor must survive dense pruning');
    assert.ok(!selected.includes(7), 'the latest snapshot must survive');
});

test('retention prefers redundant track-count points inside a dense cluster', () => {
    const snapshots = [
        snapshot(1, '2026-07-01T00:00:00Z', 10),
        snapshot(2, '2026-07-01T00:15:00Z', 11),
        snapshot(3, '2026-07-01T00:30:00Z', 10),
        snapshot(4, '2026-07-01T00:45:00Z', 10),
        snapshot(5, '2026-07-01T01:00:00Z', 10),
        snapshot(6, '2026-07-02T00:00:00Z', 10)
    ];

    assert.deepEqual(Array.from(selectSnapshotsForPruning(snapshots, 1)), [4]);
});

test('retention falls back to oldest only when there is no dense cluster', () => {
    const snapshots = [
        snapshot(1, '2026-06-01T00:00:00Z'),
        snapshot(2, '2026-06-10T00:00:00Z'),
        snapshot(3, '2026-06-20T00:00:00Z')
    ];

    assert.deepEqual(Array.from(selectSnapshotsForPruning(snapshots, 1)), [1]);
});

test('pruning carries delta rows into the successor before deletion', () => {
    assert.match(worker, /INSERT OR IGNORE INTO snapshot_songs[\s\S]*SELECT \?, old\.spotify_id/);
    assert.match(worker, /const results = await env\.DB\.batch\(statements\)/);
    assert.match(worker, /DELETE FROM snapshot_songs WHERE snapshot_id = \?/);
    assert.match(worker, /DELETE FROM snapshots WHERE id = \?/);
});
