const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const dashboard = fs.readFileSync(path.join(root, 'dashboard.html'), 'utf8');
const profile = fs.readFileSync(path.join(root, 'user.html'), 'utf8');
const admin = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');

assert.match(dashboard, /id="add-author-modal" role="dialog" aria-modal="true"[^>]+z-index: 1600/);
assert.match(dashboard, /document\.body\.classList\.add\('modal-open'\)/);
assert.match(dashboard, /if \(e\.target !== row\) return;/);
assert.match(dashboard, /const DASHBOARD_PAGE_SIZE = 40;/);
assert.match(dashboard, /filteredUsers\.slice\(0, dashboardVisibleCount\)/);

assert.match(profile, /id="profile-error-state" role="alert" hidden/);
assert.match(profile, /document\.body\.classList\.add\('profile-error'\)/);
assert.match(profile, /id="track-modal" role="dialog" aria-modal="true" aria-labelledby="track-modal-title"/);
assert.match(profile, /function closeTrackStatsModal\(\)/);
assert.match(profile, /const TRACK_PAGE_SIZE = 50;/);
assert.match(profile, /sortedSongs\.slice\(0, visibleTrackCount\)/);
assert.match(profile, /function trapFocusWithinModal\(event, modal\)/);

assert.match(admin, /id="secret-key" required autofocus autocomplete="current-password"/);
assert.match(admin, /input,\s*button,\s*select \{ min-height: 44px; \}/);

console.log('responsive UX regression checks passed');
