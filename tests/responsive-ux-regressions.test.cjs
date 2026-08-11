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
assert.match(dashboard, /id="setting-show-full-lists"/);
assert.match(dashboard, /localStorage\.getItem\('spicy-show-full-lists'\) !== 'false'/);
assert.match(dashboard, /shouldShowFullLists\(\)\s*\? filteredUsers/);
assert.match(dashboard, /\.modern-beta-corner \{\s*position: fixed;\s*bottom: 18px;\s*right: 18px;/);
assert.match(dashboard, /<button class="modern-beta-corner" type="button" aria-describedby="modern-beta-tooltip">/);
assert.match(dashboard, /setLanguageOpen\(false\);\s*toggle\.focus\(\);/);
assert.equal((dashboard.match(/footer_github:/g) || []).length, 6);
assert.match(dashboard, /Есть идея или нашли ошибку\? Telegram @lellyn · Discord @sppq/);
assert.equal((dashboard.match(/data-i18n="ticker_speed_(?:very_slow|slow|normal|fast|very_fast|turbo)"/g) || []).length, 6);
assert.equal((dashboard.match(/ticker_speed_very_slow:/g) || []).length, 6);
assert.equal((dashboard.match(/ticker_speed_very_fast:/g) || []).length, 6);
assert.equal((dashboard.match(/ticker_speed_turbo:/g) || []).length, 6);
assert.match(dashboard, /turbo: 180/);

assert.match(profile, /id="profile-error-state" role="alert" hidden/);
assert.match(profile, /document\.body\.classList\.add\('profile-error'\)/);
assert.match(profile, /id="track-modal" role="dialog" aria-modal="true" aria-labelledby="track-modal-title"/);
assert.match(profile, /function closeTrackStatsModal\(\)/);
assert.match(profile, /const TRACK_PAGE_SIZE = 50;/);
assert.match(profile, /sortedSongs\.slice\(0, visibleTrackCount\)/);
assert.match(profile, /id="setting-show-full-lists"/);
assert.match(profile, /localStorage\.getItem\('spicy-show-full-lists'\) !== 'false'/);
assert.match(profile, /shouldShowFullLists\(\)\s*\? sortedSongs/);
assert.match(profile, /function trapFocusWithinModal\(event, modal\)/);
assert.match(profile, /setLanguageOpen\(false\);\s*toggle\.focus\(\);/);
assert.equal((profile.match(/footer_github:/g) || []).length, 6);
assert.match(profile, /Есть идея или нашли ошибку\? Telegram @lellyn · Discord @sppq/);
assert.equal((profile.match(/next_check_in:/g) || []).length, 6);
assert.equal((profile.match(/update_queued:/g) || []).length, 6);
assert.equal((profile.match(/update_schedule_pending:/g) || []).length, 6);
assert.match(profile, /countdownEl\.textContent = `• \$\{dict\.update_schedule_pending\}`/);
assert.match(profile, /countdownEl\.textContent = `• \$\{dict\.update_queued\}`/);
assert.match(profile, /}, 60000\);/);

assert.match(admin, /id="secret-key" required autofocus autocomplete="current-password"/);
assert.match(admin, /input,\s*button,\s*select \{ min-height: 44px; \}/);

console.log('responsive UX regression checks passed');
