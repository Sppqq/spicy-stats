const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(new URL('../dashboard.html', `file:///${__dirname.replace(/\\/g, '/')}/`), 'utf8');
const functionStart = source.indexOf('function normalizeDashboardVisitChanges');
assert.notEqual(functionStart, -1, 'dashboard visit change normalizer should exist');

const bodyStart = source.indexOf('{', functionStart);
let depth = 0;
let bodyEnd = -1;
for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) {
        bodyEnd = index + 1;
        break;
    }
}

const functionSource = source.slice(functionStart, bodyEnd);
const normalizeDashboardVisitChanges = vm.runInNewContext(`(${functionSource})`);

const correctedCatalog = normalizeDashboardVisitChanges(
    { globalViews: 1_000_000, globalTracks: 4_000 },
    { globalViews: 978_700, globalTracks: 3_827 }
);
assert.equal(correctedCatalog.viewsGained, 0, 'catalog corrections should not appear as lost views');
assert.equal(correctedCatalog.tracksChanged, 173, 'removed tracks should still count as catalog changes');

const growingCatalog = normalizeDashboardVisitChanges(
    { globalViews: 1_000_000, globalTracks: 4_000 },
    { globalViews: 1_021_300, globalTracks: 4_173 }
);
assert.equal(growingCatalog.viewsGained, 21_300, 'positive audience growth should be preserved');
assert.equal(growingCatalog.tracksChanged, 173, 'added tracks should count as catalog changes');

console.log('dashboard visit summary tests passed');
