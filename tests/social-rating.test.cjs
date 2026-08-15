const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const worker = fs.readFileSync(path.join(root, 'cloudflare_pages', 'worker.js'), 'utf8');
const dashboard = fs.readFileSync(path.join(root, 'dashboard.html'), 'utf8');
const profile = fs.readFileSync(path.join(root, 'user.html'), 'utf8');

function extractFunction(name) {
    const start = worker.indexOf(`function ${name}(`);
    assert.notEqual(start, -1);
    const bodyStart = worker.indexOf('{', start);
    let depth = 0;
    for (let index = bodyStart; index < worker.length; index++) {
        if (worker[index] === '{') depth++;
        if (worker[index] === '}' && --depth === 0) return worker.slice(start, index + 1);
    }
    throw new Error(`Could not extract ${name}`);
}

const context = { Date, Math, Number };
vm.runInNewContext(`${extractFunction('calculateSocialRating')}; this.calculateSocialRating = calculateSocialRating;`, context);
vm.runInNewContext(`${extractFunction('isSocialRatingEligible')}; this.isSocialRatingEligible = isSocialRatingEligible;`, context);

test('social rating rewards reach, momentum, efficiency and sustained activity', () => {
    const low = context.calculateSocialRating(1000, 5, 3, null);
    const high = context.calculateSocialRating(3000000, 50000, 200, '2026-01-01T00:00:00Z', {
        growth7d: 280000,
        tracksGrowth7d: 5,
        dailyGrowth: [42000, 39000, 41000, 38000, 40000, 39000, 41000]
    });
    assert.ok(high.score > low.score);
    assert.match(low.rank, /^[D-S]$/);
    assert.match(high.rank, /^[D-S]$/);
    assert.ok(high.score <= 1000);
    assert.deepEqual(Object.keys(high.components).sort(), ['catalog', 'consistency', 'efficiency', 'history', 'momentum', 'reach', 'releases', 'velocity', 'weekly_momentum']);
    assert.ok(high.components.consistency > 0);
    assert.ok(high.components.releases > 0);
});

test('relative velocity and views per track distinguish similarly sized catalogs', () => {
    const stagnant = context.calculateSocialRating(1000000, 100, 100, '2026-01-01T00:00:00Z', { growth7d: 700, dailyGrowth: [100, 100, 100, 100, 100, 100, 100] });
    const active = context.calculateSocialRating(1000000, 20000, 100, '2026-01-01T00:00:00Z', { growth7d: 120000, dailyGrowth: [18000, 17000, 17500, 16500, 18000, 17000, 16000] });
    assert.ok(active.score > stagnant.score);
    assert.ok(active.components.velocity > stagnant.components.velocity);
    assert.ok(active.components.weekly_momentum > stagnant.components.weekly_momentum);
});

test('social rating stays unavailable during the first 24 hours', () => {
    const now = Date.parse('2026-08-15T12:00:00Z');
    assert.equal(context.isSocialRatingEligible('2026-08-14T12:00:01Z', now), false);
    assert.equal(context.isSocialRatingEligible('2026-08-14T12:00:00Z', now), true);
    assert.equal(context.isSocialRatingEligible(null, now), false);
    assert.match(worker, /social_rating: socialRating\?\.score \?\? null/);
    assert.match(worker, /social_rating_details: socialRatingDetails/);
    assert.match(dashboard, /u\.social_rating === null \|\| u\.social_rating === undefined \? '—'/);
    assert.match(profile, /socialRatingWrapEl\.hidden = !hasSocialRating/);
});

test('dashboard and profile render the same server-provided rating', () => {
    assert.match(worker, /social_rating: socialRating\?\.score \?\? null/);
    assert.match(worker, /social_rank: socialRating\?\.rank \?\? null/);
    assert.match(dashboard, /toggleSort\('social_rating'\)/);
    assert.match(dashboard, /u\.social_rating/);
    assert.match(profile, /profileData\.social_rating/);
    assert.match(profile, /profileData\.social_rank/);
    assert.doesNotMatch(profile, /escapeHtml\(profileData\.social_rank/);
    assert.match(profile, /socialRatingEl\.replaceChildren\(socialRankEl, socialScoreEl\)/);
});

test('social rating is hidden by default and controlled by a shared opt-in setting', () => {
    for (const html of [dashboard, profile]) {
        assert.match(html, /spicy-show-social-rating/);
        assert.match(html, /id="setting-show-social-rating"/);
        assert.match(html, /dataset\.showSocialRating/);
    }
    assert.match(dashboard, /html:not\(\[data-show-social-rating="true"\]\) \.social-rating-column/);
    assert.match(profile, /html:not\(\[data-show-social-rating="true"\]\) \.profile-social-wrap/);
});

test('profile explains rating gains and losses by component', () => {
    assert.match(worker, /social_rating_details: socialRatingDetails/);
    assert.match(worker, /component_deltas: Object\.fromEntries/);
    assert.match(worker, /previousSocialRating \? socialRating\.score - previousSocialRating\.score : null/);
    assert.match(profile, /function toggleSocialRatingDetails\(\)/);
    assert.match(profile, /function renderSocialRatingDetails\(dict\)/);
    assert.match(profile, /social-detail-delta/);
    assert.match(profile, /aria-controls="profile-social-details"/);
});

test('profile shows the rating breakdown on hover and supports tap', () => {
    assert.match(profile, /\.profile-social-wrap:hover \.profile-social-details/);
    assert.match(profile, /\.profile-social-wrap:focus-within \.profile-social-details/);
    assert.match(profile, /wrapEl\.classList\.toggle\('is-open'\)/);
    assert.doesNotMatch(profile, /id="profile-social-details" hidden/);
});

test('profile avatar and refresh countdown avoid visual and text artifacts', () => {
    assert.match(profile, /transform:scale\(1\.04\)/);
    assert.match(profile, /String\(s\)\.padStart\(2, '0'\)/);
    assert.doesNotMatch(profile, /\$\{m\}\$\{dict\.m\} \$\{s\}\$\{dict\.s\}/);
});
