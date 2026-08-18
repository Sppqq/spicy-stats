const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const worker = fs.readFileSync(path.join(root, 'cloudflare_pages', 'worker.js'), 'utf8');
const admin = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');

test('persistent emergency switch is exposed through the authenticated admin API', () => {
    assert.match(worker, /CREATE TABLE IF NOT EXISTS scraper_settings/);
    assert.match(worker, /\/api\/admin\/scraping-settings/);
    assert.match(worker, /verifyAdminSecret\(secret, env\)/);
    assert.match(worker, /scraping_enabled: await isScrapingEnabled\(env\)/);
});

test('all parsing entry points honor the emergency switch', () => {
    const guards = worker.match(/if \(!await isScrapingEnabled\(env\)\)/g) || [];
    assert.ok(guards.length >= 7, 'expected guards for add, manual, global, metadata, queue and worker paths');
    assert.match(worker, /for \(const msg of batch\.messages\) msg\.ack\(\)/);
    assert.match(worker, /async function scrapeAndSave[\s\S]*?if \(!await isScrapingEnabled\(env\)\) return;/);
    assert.match(worker, /async function populateMetadataCache[\s\S]*?if \(!await isScrapingEnabled\(env\)\) return;/);
});

test('admin panel renders the red lever and disables parsing controls', () => {
    assert.match(admin, /id="scraper-switch-button"[^>]*role="switch"/);
    assert.match(admin, /EMERGENCY STOP — parsing disabled/);
    assert.match(admin, /document\.querySelectorAll\('\[data-scraping-action\]'\)/);
    assert.match(admin, /\/admin\/scraping-settings/);
});
