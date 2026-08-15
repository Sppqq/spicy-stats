const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const pages = ['dashboard.html', 'user.html'];
const themes = [
    { value: 'mono', key: 'theme_mono' },
    { value: 'dusk', key: 'theme_dusk' },
    { value: 'blueprint', key: 'theme_blueprint' }
];

for (const page of pages) {
    const html = fs.readFileSync(path.join(root, page), 'utf8');
    const optionCount = (html.match(/<button class="theme-option(?: theme-option-auto)?"/g) || []).length;

    assert.equal(optionCount, 14, `${page} should expose Auto plus 13 palettes`);
    assert.match(html, /theme_palettes: "13 palettes \+ Auto"/);
    assert.match(html, /const validThemes = new Set\(\[[^\]]*'mono'[^\]]*'dusk'[^\]]*'blueprint'[^\]]*\]\)/,
        `${page} should allow every added palette during prepaint`);

    for (const theme of themes) {
        assert.match(html, new RegExp(`\\[data-theme="${theme.value}"\\]\\s*\\{`));
        assert.match(html, new RegExp(`data-theme-value="${theme.value}"`));
        assert.match(html, new RegExp(`\\b${theme.value}:\\s*\\{ label:`));

        const nameKeyCount = (html.match(new RegExp(`${theme.key}:`, 'g')) || []).length;
        const descriptionKeyCount = (html.match(new RegExp(`${theme.key}_desc:`, 'g')) || []).length;
        assert.equal(nameKeyCount, 6, `${page} should localize ${theme.key} in all six languages`);
        assert.equal(descriptionKeyCount, 6, `${page} should localize ${theme.key}_desc in all six languages`);
    }

    const monoBlock = html.match(/\[data-theme="mono"\]\s*\{([\s\S]*?)\n\s*\}/)?.[1] || '';
    assert.match(monoBlock, /--green: #c9c9c5;/, `${page} Mono positive accent should be grayscale`);
    assert.match(monoBlock, /--coral: #7c7c79;/, `${page} Mono negative accent should be grayscale`);
    assert.doesNotMatch(monoBlock, /#ef8177/i, `${page} Mono should not retain the salmon negative accent`);

    if (page === 'user.html') {
        assert.match(html, /\[data-theme="mono"\] \.share-card-trigger \{ color: var\(--paper\); \}/);
    }
    if (page === 'dashboard.html') {
        assert.match(html, /\[data-theme="mono"\] \.ticker-live-badge \{ background: var\(--ink\) !important; color: var\(--paper\) !important; \}/);
        assert.match(html, /class="ticker-live-badge"/);
    }
}

const serviceWorker = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
assert.match(serviceWorker, /spicy-monitor-cache-v1\.4\.32/);

console.log('theme palette regression checks passed');
