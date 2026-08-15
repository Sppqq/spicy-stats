const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const worker = fs.readFileSync(path.join(__dirname, '..', 'cloudflare_pages', 'worker.js'), 'utf8');

function loadFunction(name) {
    const start = worker.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `${name} should exist`);

    const bodyStart = worker.indexOf('{', start);
    let depth = 0;
    let end = bodyStart;
    for (; end < worker.length; end += 1) {
        if (worker[end] === '{') depth += 1;
        if (worker[end] === '}') depth -= 1;
        if (depth === 0) break;
    }

    return vm.runInNewContext(`(${worker.slice(start, end + 1)})`);
}

const encodeSpicyLyricsInput = loadFunction('encodeSpicyLyricsInput');
const decodeSpicyLyricsData = loadFunction('decodeSpicyLyricsData');

test('encodes tRPC input using the current SpicyLyrics devalue wire format', () => {
    assert.equal(
        encodeSpicyLyricsInput({ id: '856263869718069278', includeTracks: true }),
        '[{"id":1,"includeTracks":2},"856263869718069278",true]'
    );
});

test('decodes flattened SpicyLyrics profile and track payloads', () => {
    const decoded = decodeSpicyLyricsData([
        { profile: 1, perUser: 4 },
        { data: 2 },
        { avatar: 3 },
        'https://cdn.example/avatar.webp',
        { makes: 5, uploads: 8 },
        [6],
        { id: 7, view_count: 9 },
        'spotify-track-id',
        [],
        42
    ]);

    assert.deepEqual(JSON.parse(JSON.stringify(decoded)), {
        profile: { data: { avatar: 'https://cdn.example/avatar.webp' } },
        perUser: { makes: [{ id: 'spotify-track-id', view_count: 42 }], uploads: [] }
    });
});
