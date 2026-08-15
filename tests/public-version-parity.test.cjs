const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const release = '1.4.41';
const releaseDate = '2026-08-15';
const pages = ['dashboard.html', 'user.html', 'admin.html'];

test('all pages show the current release in the footer and changelog', () => {
    for (const page of pages) {
        const html = fs.readFileSync(path.join(root, page), 'utf8');
        assert.match(html, new RegExp(`>v${release.replaceAll('.', '\\.')} <span[^>]*>\\(Changelog\\)<\\/span>`), `${page} footer version`);
        assert.match(html, new RegExp(`>v${release.replaceAll('.', '\\.')} \\(${releaseDate}\\)<\\/strong>`), `${page} changelog version`);
    }
});

test('service worker and backend package use the same release', () => {
    const serviceWorker = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'cloudflare_pages', 'package.json'), 'utf8'));
    assert.match(serviceWorker, new RegExp(`spicy-monitor-cache-v${release.replaceAll('.', '\\.')}`));
    assert.equal(packageJson.version, release);
});
