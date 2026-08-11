const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const worker = fs.readFileSync(path.join(root, 'cloudflare_pages', 'worker.js'), 'utf8');

assert.match(worker, /CREATE TABLE IF NOT EXISTS audit_logs/);
assert.match(worker, /logActivityEvent\(env, "user_add", `➕ Added new profile: @\$\{savedUser\.username\}`\)/);
assert.match(worker, /logActivityEvent\(env, "profile_merge", `🔀 Merged profile @\$\{sourceClean\} into @\$\{targetClean\}`\)/);
assert.match(worker, /if \(prevSnap && prevSong === undefined\) \{\s*newTracks\.push\(song\)/);
assert.match(worker, /logActivityEvent\(env, "new_track", `🎵 @\$\{username\} added a new track:/);
assert.match(worker, /logActivityEvent\(env, "milestone_reached", `🎉 @\$\{username\} reached \$\{formatMilestoneValue\(ms\)\} views!`\)/);
assert.match(worker, /latestSuccessfulUpdate = history && history\.length > 0 \? history\[0\]\.timestamp : user\.last_scraped_at/);
assert.match(worker, /next_update_is_earliest: true/);

console.log('activity feed event regression checks passed');
