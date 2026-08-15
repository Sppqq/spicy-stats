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

test('social rating rewards reach, momentum and catalog strength', () => {
    const low = context.calculateSocialRating(1000, 5, 3, null);
    const high = context.calculateSocialRating(3000000, 50000, 200, '2026-01-01T00:00:00Z');
    assert.ok(high.score > low.score);
    assert.match(low.rank, /^[D-S]$/);
    assert.match(high.rank, /^[D-S]$/);
    assert.ok(high.score <= 1000);
});

test('dashboard and profile render the same server-provided rating', () => {
    assert.match(worker, /social_rating: socialRating\.score/);
    assert.match(worker, /social_rank: socialRating\.rank/);
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
    assert.match(profile, /html:not\(\[data-show-social-rating="true"\]\) \.profile-social-rating/);
});
