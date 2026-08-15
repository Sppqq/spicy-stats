const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

function extractFunction(source, functionName) {
    const functionStart = source.indexOf(`function ${functionName}`);
    assert.notEqual(functionStart, -1, `${functionName} should exist`);

    const bodyStart = source.indexOf('{', functionStart);
    let depth = 0;
    for (let index = bodyStart; index < source.length; index += 1) {
        if (source[index] === '{') depth += 1;
        if (source[index] === '}') depth -= 1;
        if (depth === 0) return source.slice(functionStart, index + 1);
    }
    throw new Error(`Could not extract ${functionName}`);
}

const dashboardSource = fs.readFileSync(path.join(root, 'dashboard.html'), 'utf8');
const prepaintSource = Array.from(dashboardSource.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi))
    .map(match => match[1])
    .find(script => script.includes("let dashboardDesign = 'modern'"));
assert.ok(prepaintSource, 'dashboard prepaint script should exist');

function getPrepaintDesign(storedDesign, storageThrows = false) {
    const documentElement = { dataset: {} };
    vm.runInNewContext(prepaintSource, {
        document: { documentElement },
        localStorage: {
            getItem(key) {
                if (storageThrows) throw new Error('storage unavailable');
                return key === 'spicy-dashboard-design' ? storedDesign : null;
            }
        },
        window: { matchMedia: () => ({ matches: false }) }
    });
    return documentElement.dataset.dashboardDesign;
}

assert.equal(getPrepaintDesign(null), 'modern', 'new visitors should start with the modern dashboard');
assert.equal(getPrepaintDesign('classic'), 'classic', 'an explicit switch back to classic should persist');
assert.equal(getPrepaintDesign('modern'), 'modern');
assert.equal(getPrepaintDesign('unexpected'), 'modern', 'invalid stored values should use the modern default');
assert.equal(getPrepaintDesign(null, true), 'modern', 'storage failures should keep the modern default');

const filterSource = extractFunction(dashboardSource, 'filterWeeklyGrowthAnomalies');
const alignSource = extractFunction(dashboardSource, 'alignWeeklyGrowthWithPulse');
const normalizeSource = extractFunction(dashboardSource, 'normalizeWeeklyGrowth');
const summarySource = extractFunction(dashboardSource, 'getWeeklyGrowthSummary');
const dashboardContext = vm.createContext({});
vm.runInContext(`${filterSource}\n${alignSource}\n${normalizeSource}\n${summarySource}`, dashboardContext);

assert.deepEqual(
    Array.from(dashboardContext.filterWeeklyGrowthAnomalies([180000, 190000, 2300000, 210000, 220000], true)),
    [180000, 190000, 200000, 210000, 220000],
    'isolated weekly growth spikes should be replaced with the neighboring pace'
);
assert.deepEqual(
    Array.from(dashboardContext.filterWeeklyGrowthAnomalies([180000, 190000, 2300000, 210000], false)),
    [180000, 190000, 2300000, 210000],
    'weekly growth spikes should remain when anomaly filtering is disabled'
);
assert.deepEqual(
    Array.from(dashboardContext.alignWeeklyGrowthWithPulse(
        [200000, 210000, 220000, 230000, 240000, 250000, 428200],
        [{ growth: 100000 }, { growth: 70600 }, { growth: -5000 }]
    )),
    [200000, 210000, 220000, 230000, 240000, 250000, 170600],
    'today weekly bar must equal the same positive 24-hour growth shown in the pulse card'
);
assert.deepEqual(
    Array.from(dashboardContext.filterWeeklyGrowthAnomalies([931900, 190000, 210000, 220000, 230000, 240000, 250000], true)),
    [200000, 190000, 210000, 220000, 230000, 240000, 250000],
    'an isolated spike at the oldest edge should not remain the weekly peak'
);
assert.deepEqual(
    Array.from(dashboardContext.filterWeeklyGrowthAnomalies([180000, 190000, 200000, 210000, 220000, 230000, 931900], true)),
    [180000, 190000, 200000, 210000, 220000, 230000, 225000],
    'an intraday spike at the newest edge should not be announced as a record'
);

assert.deepEqual(
    Array.from(dashboardContext.normalizeWeeklyGrowth([120, -30, null, '240'])),
    [0, 0, 0, 120, 0, 0, 240],
    'weekly values should be padded, numeric and correction-safe'
);
assert.deepEqual(
    Array.from(dashboardContext.normalizeWeeklyGrowth([1, 2, 3, 4, 5, 6, 7, 8])),
    [2, 3, 4, 5, 6, 7, 8],
    'only the most recent seven days should be shown'
);

const summary = dashboardContext.getWeeklyGrowthSummary([100, 200, 300, 400, 500, 600, 900]);
assert.equal(summary.average, 350);
assert.equal(summary.today, 900);
assert.equal(summary.comparisonPercent, 157);
assert.equal(summary.peakIndex, 6);
assert.equal(summary.peakValue, 900);
assert.equal(summary.hasData, true);

const filteredSummary = dashboardContext.getWeeklyGrowthSummary([180000, 190000, 2300000, 210000, 220000, 230000, 240000], true);
assert.equal(filteredSummary.values[2], 200000);
assert.equal(filteredSummary.peakIndex, 6);
assert.equal(filteredSummary.peakValue, 240000);
assert.equal(filteredSummary.average, 205000);

const edgeFilteredSummary = dashboardContext.getWeeklyGrowthSummary([931900, 190000, 210000, 220000, 230000, 240000, 250000], true);
assert.equal(edgeFilteredSummary.values[0], 200000);
assert.equal(edgeFilteredSummary.peakIndex, 6);
assert.equal(edgeFilteredSummary.peakValue, 250000);

const workerSource = fs.readFileSync(path.join(root, 'cloudflare_pages', 'worker.js'), 'utf8');
const buildSource = extractFunction(workerSource, 'buildWeeklyGrowth');
const buildWeeklyGrowth = vm.runInNewContext(`(${buildSource})`);
const samples = [
    ...[200, 150, 100, 80, 90, 70, 50, 20].map((total_views, day_offset) => ({ user_id: 1, day_offset, total_views })),
    ...[90, 100, 80].map((total_views, day_offset) => ({ user_id: 2, day_offset, total_views }))
];
assert.deepEqual(
    Array.from(buildWeeklyGrowth(samples)),
    [30, 20, 20, 0, 20, 70, 50],
    'daily totals should run oldest to newest and clamp per-profile corrections'
);
assert.deepEqual(
    Array.from(buildWeeklyGrowth([
        { user_id: 3, day_offset: 0, total_views: 140 },
        { user_id: 3, day_offset: 1, total_views: 100 }
    ])),
    [null, null, null, null, null, null, 40],
    'missing history should stay distinct from genuine zero growth'
);

assert.match(workerSource, /weekly_growth:\s*buildWeeklyGrowth\(weeklyGrowthSamples\)/);
assert.match(
    dashboardSource,
    /alignWeeklyGrowthWithPulse\(dashboardData\.weekly_growth, dashboardData\.users\)/,
    'weekly rendering should align today with the dashboard pulse source'
);
assert.match(
    workerSource,
    /ROW_NUMBER\(\) OVER[\s\S]*?PARTITION BY u\.id, d\.day_offset[\s\S]*?day_offset \* 24 \+ 12[\s\S]*?day_offset \* 24 - 12[\s\S]*?sample_rank = 1/,
    'weekly boundaries should use the closest snapshot within a 12-hour window'
);
assert.doesNotMatch(
    workerSource,
    /s_history\.timestamp[\s\S]*?<= datetime\('now', printf\('-%d hours', d\.day_offset \* 24\)\)[\s\S]*?ORDER BY s_history\.id DESC/,
    'weekly boundaries must not use an arbitrarily old snapshot as a 24-hour sample'
);
assert.doesNotMatch(dashboardSource, /visit-summary|initVisitSummary|since_last_visit/);
assert.match(dashboardSource, /let dashboardDesign = 'modern';/);
assert.match(dashboardSource, /storedDashboardDesign === 'modern' \|\| storedDashboardDesign === 'classic'/);
assert.match(dashboardSource, /dataset\.dashboardDesign \|\| 'modern'/);
assert.match(dashboardSource, /backButton\?\.addEventListener\('click',[\s\S]*?applyDashboardDesign\('classic'\)/);

console.log('dashboard weekly trend tests passed');
