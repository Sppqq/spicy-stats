const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const pages = ['dashboard.html', 'user.html'];

test('public pages show the current release in the footer and changelog', () => {
    for (const page of pages) {
        const html = fs.readFileSync(path.join(root, page), 'utf8');
        assert.match(html, />v1\.4\.24 <span[^>]*>\(Changelog\)<\/span>/, `${page} footer version`);
        assert.match(html, />v1\.4\.24 \(2026-08-12\)<\/strong>/, `${page} changelog version`);
    }
});
