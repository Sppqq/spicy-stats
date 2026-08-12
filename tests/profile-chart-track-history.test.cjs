const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const userHtml = fs.readFileSync(path.join(__dirname, '..', 'user.html'), 'utf8');

test('profile chart preserves historical track counts above the current total', () => {
    assert.match(
        userHtml,
        /tracks:\s*p\.tracks !== undefined \? p\.tracks : currentTotalSongs/,
        'chart points should use their stored historical track count'
    );
    assert.doesNotMatch(
        userHtml,
        /rawTracks\s*>\s*maxAllowedSongs/,
        'historical track counts must not be capped to the current profile total'
    );
});
