const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const profile = fs.readFileSync(path.join(__dirname, '..', 'user.html'), 'utf8');

test('share-card artwork has localized copy for every supported language', () => {
    for (const lang of ['en', 'ru', 'uk', 'de', 'it', 'pl']) {
        assert.match(profile, new RegExp(`${lang}: \\{ liveData:`));
    }
    for (const key of ['totalAudience', 'audienceGrowth', 'catalogTracks', 'viewVelocity', 'catalogLeader', 'tagline']) {
        assert.match(profile, new RegExp(`copy\\.${key}`));
    }
});

test('share-card canvas no longer draws English metric labels directly', () => {
    for (const label of ['LIVE CREATOR DATA', 'TOTAL AUDIENCE', 'AUDIENCE GROWTH', 'CATALOG TRACKS', 'VIEW VELOCITY', 'CATALOG LEADER', 'ONE PROFILE. ONE SIGNAL. UPDATED LIVE.']) {
        assert.equal(profile.includes(`fillText('${label}'`), false, `${label} should come from localized copy`);
    }
});

test('social-rating popover is positioned inside the viewport', () => {
    assert.match(profile, /function positionSocialRatingDetails\(\)/);
    assert.match(profile, /window\.innerWidth - panelWidth - 8/);
    assert.match(profile, /spaceBelow >= panelHeight/);
    assert.match(profile, /position: fixed; z-index: 1000/);
});
