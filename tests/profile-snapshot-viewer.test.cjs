const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const userHtml = fs.readFileSync(path.join(root, 'user.html'), 'utf8');
const worker = fs.readFileSync(path.join(root, 'cloudflare_pages', 'worker.js'), 'utf8');

test('profile chart points can load their catalog snapshot', () => {
    assert.match(userHtml, /snapshotTimestamp:\s*p\.snapshotTimestamp \|\| p\.x/);
    assert.match(userHtml, /svgElement\.onclick = \(\) => \{[\s\S]*loadSnapshotAtPoint\(activeSnapshotPoint\)/);
    assert.match(userHtml, /user-snapshot\?username=.*timestamp=/);
    assert.match(userHtml, /function returnToCurrentSnapshot\(\)/);
    assert.match(userHtml, /id="return-current-snapshot"/);
    assert.match(userHtml, /function getProfileSongKey\(song\)/);
    assert.match(userHtml, /const isDeletedNow = Boolean\(selectedSnapshotData\)/);
    assert.match(userHtml, /track-removed-badge/);
    assert.match(userHtml, /const historicalKeys = new Set\(historicalSongs\.map\(getProfileSongKey\)\)/);
    assert.match(userHtml, /const currentKeys = new Set\(currentSongs\.map\(getProfileSongKey\)\)/);
    assert.match(userHtml, /copy\.addedSince/);
    assert.match(userHtml, /copy\.removedSince/);
});

test('snapshot API rebuilds catalog state and calculates historical 24h growth', () => {
    assert.match(worker, /url\.pathname === "\/api\/user-snapshot"/);
    assert.match(worker, /async function loadSongsAtSnapshot\(/);
    assert.match(worker, /WHERE rn = 1 AND views >= 0/);
    assert.match(worker, /growthBaseline[\s\S]*'-24 hours'/);
    assert.match(worker, /const baselineMap = new Map/);
    assert.match(worker, /growth_baseline_timestamp/);
    assert.doesNotMatch(worker, /previous_timestamp/);
});
