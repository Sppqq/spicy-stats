const isDevEnv = (window.location.hostname.includes('localhost') || window.location.hostname.includes('127.0.0.1') || window.location.hostname.startsWith('dev.') || window.location.hostname.includes('spicy-stats-dev') || window.location.hostname.includes('dev-api'));
const API_BASE = isDevEnv
    ? 'https://dev-api.glyph-labs.site/api'
    : 'https://spicy-api.glyph-labs.site/api';

function generateSignature(path, timestamp) {
    const salt = "SpicyLyrics_API_Secured_2026_GlyphLabs";
    const str = `${timestamp}:${path}:${salt}`;
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash) + str.charCodeAt(i);
    }
    return (hash >>> 0).toString(16);
}

async function spicyFetch(urlStr, options = {}) {
    let path = '';
    if (urlStr.startsWith('http')) {
        path = new URL(urlStr).pathname;
    } else {
        path = urlStr.split('?')[0];
    }
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = generateSignature(path, timestamp);
    const currentLang = localStorage.getItem('spicy-lang') || 'en';
    options.headers = {
        ...(options.headers || {}),
        "X-Spicy-Timestamp": timestamp,
        "X-Spicy-Signature": signature,
        "X-Spicy-Lang": currentLang
    };
    return fetch(urlStr, options);
}
