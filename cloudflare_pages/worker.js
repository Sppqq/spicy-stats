// Build trigger: v1.0.1 - Notifications Update
function verifyAdminSecret(secret, env) {
    const expectedSecret = env?.ADMIN_SECRET || env?.IMPORT_SECRET;
    if (!expectedSecret || !secret) return false;
    return secret === expectedSecret;
}

// ==========================================
// ГЛОБАЛЬНЫЙ КЭШ ДЛЯ CPU-ОПТИМИЗАЦИИ (МЕМОИЗАЦИЯ)
// ==========================================
const REGEX_TITLE_CLEAN = /\s*[-\(]\s*(?:20\d{2}\s+)?(?:remastered|remaster|deluxe|edit|radio edit|live|acoustic)[\)]?/gi;
const REGEX_ARTIST_CLEAN = /\s+(?:feat\.?|ft\.?|&|and)\s+/gi;
const REGEX_NON_ALPHANUM = /[^a-z0-9а-яё]/g;

const titleCache = new Map();
const artistCache = new Map();

function normalizeTitle(title) {
    if (!title) return "";
    let cached = titleCache.get(title);
    if (cached) return cached;
    let res = title.replace(REGEX_TITLE_CLEAN, '').toLowerCase().replace(REGEX_NON_ALPHANUM, '');
    if (titleCache.size > 2000) titleCache.clear();
    titleCache.set(title, res);
    return res;
}

function getPrimaryArtist(artistStr) {
    if (!artistStr) return "";
    let cached = artistCache.get(artistStr);
    if (cached) return cached;
    let res = artistStr.replace(REGEX_ARTIST_CLEAN, ', ').replace(/;/g, ',').split(',')[0].trim().toLowerCase().replace(REGEX_NON_ALPHANUM, '');
    if (artistCache.size > 2000) artistCache.clear();
    artistCache.set(artistStr, res);
    return res;
}

// In-memory rate limiting
const rateLimitMap = new Map();

function isRateLimited(ip, limit, windowMs) {
    const now = Date.now();
    if (rateLimitMap.size > 10000) rateLimitMap.clear();

    if (!rateLimitMap.has(ip)) {
        rateLimitMap.set(ip, [now]);
        return false;
    }

    const timestamps = rateLimitMap.get(ip);
    const activeTimestamps = timestamps.filter(ts => now - ts < windowMs);

    if (activeTimestamps.length >= limit) {
        rateLimitMap.set(ip, activeTimestamps);
        return true;
    }

    activeTimestamps.push(now);
    rateLimitMap.set(ip, activeTimestamps);
    return false;
}

let schemaChecked = false;

async function checkSchema(env) {
    if (schemaChecked) return;
    try {
        // Create base tables if they do not exist (useful for clean dev database setup)
        await env.DB.prepare(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE,
                discord_id TEXT,
                discord_avatar TEXT,
                last_scraped_at TEXT
            )
        `).run().catch(() => {});

        await env.DB.prepare(`
            CREATE TABLE IF NOT EXISTS snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                total_views INTEGER,
                total_songs INTEGER,
                timestamp TEXT
            )
        `).run().catch(() => {});

        await env.DB.prepare(`
            CREATE TABLE IF NOT EXISTS snapshot_songs (
                snapshot_id INTEGER,
                spotify_id TEXT,
                title TEXT,
                artist TEXT,
                views INTEGER,
                PRIMARY KEY (snapshot_id, spotify_id)
            )
        `).run().catch(() => {});

        await env.DB.prepare("ALTER TABLE users ADD COLUMN discord_id TEXT").run().catch(() => {});
        await env.DB.prepare("ALTER TABLE users ADD COLUMN discord_avatar TEXT").run().catch(() => {});
        await env.DB.prepare("ALTER TABLE users ADD COLUMN last_scraped_at TEXT").run().catch(() => {});
        await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_users_last_scraped ON users(last_scraped_at)").run().catch(() => {});
        await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_snapshot_songs_snapshot_id ON snapshot_songs(snapshot_id)").run().catch(() => {});
        await env.DB.prepare(`
            CREATE TABLE IF NOT EXISTS track_metadata (
                spotify_id TEXT PRIMARY KEY,
                isrc TEXT,
                title TEXT,
                artist TEXT,
                created_at TEXT DEFAULT (datetime('now'))
            )
        `).run().catch(() => {});
        await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_track_metadata_isrc ON track_metadata(isrc)").run().catch(() => {});
        await env.DB.prepare("ALTER TABLE snapshots ADD COLUMN total_songs INTEGER").run().catch(() => {});


        await env.DB.prepare(`
            CREATE TABLE IF NOT EXISTS notification_settings (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                enabled INTEGER DEFAULT 0,
                type TEXT DEFAULT 'banner',
                title TEXT DEFAULT '',
                message TEXT DEFAULT '',
                style_template TEXT DEFAULT 'warning',
                updated_at TEXT DEFAULT (datetime('now'))
            )
        `).run().catch(() => {});

        await env.DB.prepare(`
            INSERT OR IGNORE INTO notification_settings (id, enabled, type, title, message, style_template)
            VALUES (1, 0, 'banner', 'Технические работы', 'На сайте проводятся технические работы. Пожалуйста, зайдите позже.', 'warning')
        `).run().catch(() => {});

        schemaChecked = true;
    } catch (e) {}
}

const allowedOrigins = [
    "https://spicy-stats.glyph-labs.site",
    "https://stats.pidoras.dev",
    "http://localhost:3000",
    "http://localhost:5173",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:5173"
];
// We will dynamically check APIURL inside getCorsHeaders

function getCorsHeaders(request, env) {
    const origin = request.headers.get("Origin") || "";
    let isAllowed = allowedOrigins.includes(origin) || origin.endsWith(".vercel.app") || origin.endsWith(".glyph-labs.site");
    if (env && env.APIURL && env.APIURL === origin) isAllowed = true;
    return {
        "Access-Control-Allow-Origin": isAllowed ? origin : "https://spicy-stats.glyph-labs.site",
        "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
        "Access-Control-Max-Age": "86400",
        "Access-Control-Allow-Headers": "Content-Type, X-Spicy-Signature, X-Spicy-Timestamp",
    };
}



function verifySignature(request, path) {
    const timestampStr = request.headers.get("X-Spicy-Timestamp");
    const signature = request.headers.get("X-Spicy-Signature");

    if (!timestampStr || !signature) return false;

    const timestamp = parseInt(timestampStr, 10);
    if (isNaN(timestamp)) return false;

    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestamp) > 90) return false;

    const salt = "SpicyLyrics_API_Secured_2026_GlyphLabs";
    const str = `${timestampStr}:${path}:${salt}`;
    let hash = 5381;
    for (let i = 0; i < str.length; i++) hash = ((hash << 5) + hash) + str.charCodeAt(i);
    return signature === (hash >>> 0).toString(16);
}

// ==========================================
// ОСНОВНОЙ РОУТЕР WORKER'А
// ==========================================
export default {
    async fetch(request, env, ctx) {
        await checkSchema(env);
        const url = new URL(request.url);

        if (request.method === "OPTIONS") {
            return new Response(null, { headers: { ...getCorsHeaders(request, env), "Access-Control-Allow-Headers": request.headers.get("Access-Control-Request-Headers") || "Content-Type, X-Spicy-Signature, X-Spicy-Timestamp" } });
        }

        const path = url.pathname;
        const isPublicAPI = path.startsWith("/api/") && !path.startsWith("/api/export/") && !path.startsWith("/api/import");
        if (isPublicAPI && !verifySignature(request, path)) {
            return new Response(JSON.stringify({ error: "Forbidden: API request signature verification failed." }), { status: 403, headers: { "Content-Type": "application/json", ...getCorsHeaders(request, env) } });
        }

        const ip = request.headers.get("CF-Connecting-IP") || "anonymous";
        const lang = request.headers.get("X-Spicy-Lang") || "en";
        const rateLimitMsgs = { en: "Too many requests.", ru: "Слишком много запросов." };
        const rateLimitMsg = rateLimitMsgs[lang] || rateLimitMsgs.en;

        if (url.pathname === "/api/add-user" && request.method === "POST") {
            if (isRateLimited(ip, 5, 60000)) return new Response(JSON.stringify({ error: rateLimitMsg }), { status: 429, headers: { "Content-Type": "application/json", ...getCorsHeaders(request, env) } });
        } else if (url.pathname.startsWith("/api/") && !url.pathname.startsWith("/api/admin/")) {
            if (isRateLimited(ip, 60, 60000)) return new Response(JSON.stringify({ error: rateLimitMsg }), { status: 429, headers: { "Content-Type": "application/json", ...getCorsHeaders(request, env) } });
        }

        let response;
        try {
            if (url.pathname === "/api/import" && request.method === "POST") response = await handleImport(request, env);
            else if (url.pathname.startsWith("/api/export/")) response = await handleExport(url.pathname.split("/")[3], env);
            else if (url.pathname === "/api/add-user" && request.method === "POST") response = await handleAddUser(request, env, ctx);
            else if (url.pathname === "/api/dashboard" && request.method === "GET") response = await handleDashboardAPI(request, env);
            else if (url.pathname === "/api/track-history" && request.method === "GET") response = await handleTrackHistoryAPI(request, env);
            else if (url.pathname.startsWith("/api/user/") && request.method === "GET") response = await handleUserDetailAPI(url.pathname.split("/")[3], request, env);
            else if (url.pathname === "/api/activity-feed" && request.method === "GET") response = await handleActivityFeedAPI(request, env);
            else if (url.pathname === "/api/admin/stats" && request.method === "POST") response = await handleAdminStats(request, env);
            else if (url.pathname === "/api/admin/search-metadata" && request.method === "POST") response = await handleAdminSearchMetadata(request, env);
            else if (url.pathname === "/api/admin/update-metadata" && request.method === "POST") response = await handleAdminUpdateMetadata(request, env);
            else if (url.pathname === "/api/admin/scrape-user" && request.method === "POST") response = await handleAdminScrapeUser(request, env);
            else if (url.pathname === "/api/admin/scrape-all" && request.method === "POST") response = await handleAdminScrapeAll(request, env, ctx);
            else if (url.pathname === "/api/admin/populate-metadata" && request.method === "POST") response = await handleAdminPopulateMetadata(request, env, ctx);

            else if (url.pathname === "/api/admin/merge-users" && request.method === "POST") response = await handleAdminMergeUsers(request, env);
            else if (url.pathname === "/api/admin/delete-user" && request.method === "POST") response = await handleAdminDeleteUser(request, env);
            else if (url.pathname === "/api/admin/export-user" && request.method === "POST") response = await handleAdminExportUser(request, env);
            else if (url.pathname === "/api/admin/sync-prod-db" && request.method === "POST") response = await handleAdminSyncProdDb(request, env);
            else if (url.pathname === "/api/admin/prune-snapshots" && request.method === "POST") response = await handleAdminPruneSnapshots(request, env);
            else if (url.pathname === "/api/notification-settings" && request.method === "GET") response = await handleGetNotificationSettings(request, env);
            else if (url.pathname === "/api/admin/notification-settings" && request.method === "POST") response = await handleSaveNotificationSettings(request, env);
            else response = new Response(JSON.stringify({ error: "API Endpoint Not Found" }), { status: 404, headers: { "Content-Type": "application/json" } });
        } catch (err) {
            response = new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Content-Type": "application/json" } });
        }

        const finalHeaders = new Headers(response.headers);
        for (const [key, val] of Object.entries(getCorsHeaders(request, env))) finalHeaders.set(key, val);
        return new Response(response.body, { status: response.status, headers: finalHeaders });
    },

    // КРОН (PRODUCER)
    async scheduled(event, env, ctx) {
        await triggerGlobalScrape(env);

    },

    // ОБРАБОТЧИК ОЧЕРЕДИ (CONSUMER)
    async queue(batch, env) {
        for (const msg of batch.messages) {
            try {
                const user = msg.body;
                await scrapeAndSave(user.id, user.username, user.discord_id, env);
                msg.ack(); // Подтверждаем успешную обработку
            } catch (err) {
                console.error(`Queue scrape error for ${msg.body.username}:`, err.message);
                msg.retry();
            }
        }
    }
};

// ==========================================
// CORE API METHODS (JSON) - Твои оригинальные!
// ==========================================

async function handleAddUser(request, env, ctx) {
    const { username, lang: userLang } = await request.json();
    const lang = userLang || "en";

    const localMsgs = {
        en: { invalid_username: "Invalid username format.", valid_username: "Please enter a valid username.", already_added: "This user has already been added.", fetch_error: "Could not fetch user profile.", not_found: "User not found.", not_creator: "User is not a creator.", failed_retrieve: "Failed to retrieve user data.", min_tracks: (c) => `At least 2 tracks required (has ${c}).` },
        ru: { invalid_username: "Неверный формат.", valid_username: "Введите корректное имя.", already_added: "Уже добавлен.", fetch_error: "Ошибка получения профиля.", not_found: "Не найден.", not_creator: "Не автор.", failed_retrieve: "Ошибка загрузки данных.", min_tracks: (c) => `Минимум 2 трека (найдено ${c}).` }
    };
    const getMsg = (key, count) => {
        const set = localMsgs[lang] || localMsgs.en;
        const val = set[key] || localMsgs.en[key];
        return typeof val === "function" ? val(count) : val;
    };

    if (!username || typeof username !== "string") return new Response(JSON.stringify({ error: getMsg("valid_username") }), { status: 400, headers: { "Content-Type": "application/json", ...getCorsHeaders(request, env) } });

    const cleanName = username.trim().replace(/^@/, "");
    if (cleanName.length === 0 || cleanName.length > 50 || !/^[a-zA-Z0-9_\.\-]+$/.test(cleanName)) return new Response(JSON.stringify({ error: getMsg("invalid_username") }), { status: 400, headers: { "Content-Type": "application/json", ...getCorsHeaders(request, env) } });

    const existingUser = await env.DB.prepare("SELECT id FROM users WHERE LOWER(username) = LOWER(?)").bind(cleanName).first();
    if (existingUser) return new Response(JSON.stringify({ error: getMsg("already_added") }), { status: 400, headers: { "Content-Type": "application/json", ...getCorsHeaders(request, env) } });

    let data;
    try {
        data = await fetchUserDataFromAPI(cleanName);
    } catch (err) {
        let msg = getMsg("fetch_error");
        if (err.message === "USER_NOT_FOUND") msg = getMsg("not_found");
        if (err.message === "USER_NOT_CREATOR") msg = getMsg("not_creator");
        return new Response(JSON.stringify({ error: msg }), { status: 400, headers: { "Content-Type": "application/json", ...getCorsHeaders(request, env) } });
    }

    if (!data) return new Response(JSON.stringify({ error: getMsg("failed_retrieve") }), { status: 400, headers: { "Content-Type": "application/json", ...getCorsHeaders(request, env) } });

    const tracksCount = data.songs ? data.songs.length : 0;
    if (tracksCount < 2) return new Response(JSON.stringify({ error: getMsg("min_tracks", tracksCount) }), { status: 400, headers: { "Content-Type": "application/json", ...getCorsHeaders(request, env) } });

    await env.DB.prepare("INSERT INTO users (username, discord_id, discord_avatar, last_scraped_at) VALUES (?, ?, ?, datetime('now')) ON CONFLICT(username) DO NOTHING")
        .bind(cleanName, data.discord_id || null, data.discord_avatar || null)
        .run();



    const savedUser = await env.DB.prepare("SELECT id, username, discord_id FROM users WHERE LOWER(username) = LOWER(?)").bind(cleanName).first();

    // Если есть очередь, кидаем первичное обновление в нее, иначе делаем руками в фоне
    if (savedUser) {
        if (env.SCRAPE_QUEUE) ctx.waitUntil(env.SCRAPE_QUEUE.send({ id: savedUser.id, username: savedUser.username, discord_id: savedUser.discord_id }));
        else ctx.waitUntil(scrapeAndSave(savedUser.id, savedUser.username, savedUser.discord_id, env));
    }

    return new Response(JSON.stringify({ success: true, cleanName }), { headers: { "Content-Type": "application/json", ...getCorsHeaders(request, env) } });
}

async function handleDashboardAPI(request, env) {
    const globalQuery = await env.DB.prepare("SELECT COUNT(id) as total_users FROM users").first();


    const totalViewsQuery = await env.DB.prepare(`
    SELECT SUM(total_views) as global_views FROM (
      SELECT total_views FROM snapshots s1
      WHERE id = (SELECT id FROM snapshots s2 WHERE s2.user_id = s1.user_id ORDER BY id DESC LIMIT 1)
    )`).first();

    const { results: users } = await env.DB.prepare(`
    WITH latest_snapshots AS (
        SELECT user_id, id AS latest_id, timestamp AS latest_timestamp, total_views AS latest_views, total_songs AS latest_total_songs
        FROM snapshots s1
        WHERE id = (SELECT id FROM snapshots s2 WHERE s2.user_id = s1.user_id ORDER BY id DESC LIMIT 1)
    )
    SELECT
        u.username, ls.latest_views AS current_views, u.last_scraped_at AS last_updated, s_past.total_views AS past_views,
        (SELECT timestamp FROM snapshots WHERE user_id = u.id ORDER BY id ASC LIMIT 1) AS first_snapshot,
        s_past_7d.id AS past_7d_id,
        COALESCE(ls.latest_total_songs, (SELECT COUNT(DISTINCT LOWER(COALESCE(NULLIF(TRIM(title), ''), 'Hidden')) || '|||' || LOWER(COALESCE(NULLIF(TRIM(artist), ''), 'SpicyLyrics'))) FROM snapshot_songs WHERE snapshot_id = ls.latest_id), 0) AS total_songs,
        COALESCE(s_past_7d.total_songs, (SELECT COUNT(DISTINCT LOWER(COALESCE(NULLIF(TRIM(title), ''), 'Hidden')) || '|||' || LOWER(COALESCE(NULLIF(TRIM(artist), ''), 'SpicyLyrics'))) FROM snapshot_songs WHERE snapshot_id = s_past_7d.id), 0) AS total_songs_7d
    FROM users u
    LEFT JOIN latest_snapshots ls ON ls.user_id = u.id
    LEFT JOIN snapshots s_past ON s_past.id = (
        SELECT id FROM snapshots s_past_in
        WHERE s_past_in.user_id = u.id 
          AND substr(s_past_in.timestamp, 1, 19) <= datetime('now', '-12 hours')
        ORDER BY ABS(strftime('%s', substr(s_past_in.timestamp, 1, 19)) - strftime('%s', datetime('now', '-24 hours'))) ASC LIMIT 1
    )
    LEFT JOIN snapshots s_past_7d ON s_past_7d.id = (
        SELECT id FROM snapshots s_7d_in
        WHERE s_7d_in.user_id = u.id 
          AND substr(s_7d_in.timestamp, 1, 19) <= datetime('now', '-3 days')
        ORDER BY ABS(strftime('%s', substr(s_7d_in.timestamp, 1, 19)) - strftime('%s', datetime('now', '-7 days'))) ASC LIMIT 1
    )
    ORDER BY current_views DESC
  `).all();

    const globalSongs = users.reduce((sum, u) => sum + (u.total_songs || 0), 0);

    const data = {
        total_users: globalQuery.total_users || 0,
        global_views: totalViewsQuery.global_views || 0,
        global_tracks: globalSongs,
        users: users.map(u => ({
            username: u.username,
            views: u.current_views || 0,
            growth: u.past_views !== null ? (u.current_views || 0) - u.past_views : null,
            first_snapshot: u.first_snapshot || null,
            total_songs: u.total_songs || 0,
            tracks_growth_7d: u.past_7d_id !== null ? Math.max(0, (u.total_songs || 0) - (u.total_songs_7d || 0)) : 0,
            last_updated: u.last_updated || null
        }))
    };

    return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json", ...getCorsHeaders(request, env) } });
}

async function handleUserDetailAPI(username, request, env) {
    const user = await env.DB.prepare("SELECT * FROM users WHERE LOWER(username) = LOWER(?)").bind(username).first();
    if (!user) return new Response(JSON.stringify({ error: "User not found" }), { status: 404, headers: { "Content-Type": "application/json", ...getCorsHeaders(request, env) } });



    const firstSnapshot = await env.DB.prepare("SELECT timestamp FROM snapshots WHERE user_id = ? ORDER BY id ASC LIMIT 1").bind(user.id).first();
    const { results: history } = await env.DB.prepare("SELECT id, total_views, timestamp FROM snapshots WHERE user_id = ? ORDER BY id DESC LIMIT 10000").bind(user.id).all();

    // ИСПРАВЛЕНИЕ 1: Ищем снапшот, ближайший к 24 часам назад
    const pastSnapshot = await env.DB.prepare(`
        SELECT id, total_views, timestamp
        FROM snapshots
        WHERE user_id = ? AND substr(timestamp, 1, 19) <= datetime('now', '-12 hours')
        ORDER BY ABS(strftime('%s', substr(timestamp, 1, 19)) - strftime('%s', datetime('now', '-24 hours'))) ASC LIMIT 1
    `).bind(user.id).first();

    let totalViews = 0, growth24h = null, totalSongs = 0;
    let topTracks = [], chartDataRaw = [], finalSongs = [];

    if (history && history.length > 0) {
        const latestSnapshot = history[0];
        const { results: dbLatestSongs } = await env.DB.prepare(`
            SELECT spotify_id, views, title, artist, isrc, meta_title, meta_artist
            FROM (
                SELECT ss.spotify_id, ss.views, ss.title, ss.artist, tm.isrc, tm.title as meta_title, tm.artist as meta_artist,
                       ROW_NUMBER() OVER(
                           PARTITION BY COALESCE(NULLIF(ss.spotify_id, ''), LOWER(TRIM(ss.title)) || '|||' || LOWER(TRIM(ss.artist)))
                           ORDER BY s.id DESC
                       ) as rn
                FROM snapshot_songs ss
                JOIN snapshots s ON ss.snapshot_id = s.id
                LEFT JOIN track_metadata tm ON ss.spotify_id = tm.spotify_id
                WHERE s.user_id = ? AND s.id <= ?
            ) ss WHERE rn = 1
        `).bind(user.id, latestSnapshot.id).all();
        let latestRaw = dbLatestSongs || [];

        totalViews = latestSnapshot.total_views;

        let has24h = pastSnapshot !== undefined && pastSnapshot !== null;

        let pastRaw = [];
        if (has24h) {
            const { results: pSongs } = await env.DB.prepare(`
                SELECT spotify_id, views, title, artist, isrc, meta_title, meta_artist
                FROM (
                    SELECT ss.spotify_id, ss.views, ss.title, ss.artist, tm.isrc, tm.title as meta_title, tm.artist as meta_artist,
                           ROW_NUMBER() OVER(
                               PARTITION BY COALESCE(NULLIF(ss.spotify_id, ''), LOWER(TRIM(ss.title)) || '|||' || LOWER(TRIM(ss.artist)))
                               ORDER BY s.id DESC
                           ) as rn
                    FROM snapshot_songs ss
                    JOIN snapshots s ON ss.snapshot_id = s.id
                    LEFT JOIN track_metadata tm ON ss.spotify_id = tm.spotify_id
                    WHERE s.user_id = ? AND s.id <= ?
                ) ss WHERE rn = 1
            `).bind(user.id, pastSnapshot.id).all();
            if (pSongs) pastRaw = pSongs;
        }

        const pastMapBySpotifyId = new Map();
        const pastMapByTextKey = new Map();

        for (const ps of pastRaw) {
            if (ps.spotify_id) {
                pastMapBySpotifyId.set(ps.spotify_id, ps.views || 0);
            }
            const normT = normalizeTitle(ps.meta_title || ps.title || "");
            const primA = getPrimaryArtist(ps.meta_artist || ps.artist || "");
            const textKey = `${normT}|||${primA}`;
            if (!pastMapByTextKey.has(textKey)) {
                pastMapByTextKey.set(textKey, ps.views || 0);
            }
        }

        const latestWithPrev = latestRaw.map(s => {
            const normT = normalizeTitle(s.meta_title || s.title || "");
            const primA = getPrimaryArtist(s.meta_artist || s.artist || "");
            const textKey = `${normT}|||${primA}`;

            let prevViews = null;
            if (s.spotify_id && pastMapBySpotifyId.has(s.spotify_id)) {
                prevViews = pastMapBySpotifyId.get(s.spotify_id);
            } else if (pastMapByTextKey.has(textKey)) {
                prevViews = pastMapByTextKey.get(textKey);
            } else {
                prevViews = s.views || 0;
            }

            return { ...s, prevViews };
        });

        finalSongs = aggregateSongs(latestWithPrev).sort((a, b) => b.growth - a.growth);
        totalSongs = finalSongs.length;
        growth24h = has24h ? finalSongs.reduce((sum, s) => sum + (s.growth || 0), 0) : null;

        topTracks = finalSongs.slice(0, 3).filter(x => x.growth > 0 || totalViews > 0);
        chartDataRaw = [...history].reverse().map(h => ({ x: h.timestamp, y: h.total_views }));
    }

    // ИСПРАВЛЕНИЕ 2: Возвращаем таймер "Обновление через..." (10 минут с момента last_scraped_at)
    let nextUpdateTimestamp = null;
    if (user.last_scraped_at) {
        const parsedLastScraped = parseDate(user.last_scraped_at);
        if (parsedLastScraped) {
            nextUpdateTimestamp = new Date(parsedLastScraped.getTime() + 10 * 60000).toISOString();
        }
    }

    const data = {
        username: user.username, discord_id: user.discord_id || null, discord_avatar: user.discord_avatar || null,
        total_views: totalViews, growth24h, first_snapshot: firstSnapshot ? firstSnapshot.timestamp : null,
        total_songs: totalSongs, highlights: topTracks, chart_data: chartDataRaw, songs: finalSongs,
        next_update: nextUpdateTimestamp,
        server_time: new Date().toISOString()
    };
    return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json", ...getCorsHeaders(request, env) } });
}

async function handleTrackHistoryAPI(request, env) {
    const url = new URL(request.url);
    const username = url.searchParams.get("username"), title = url.searchParams.get("title"), artist = url.searchParams.get("artist");
    if (!username || !title || !artist) return new Response(JSON.stringify({ error: "Missing parameters" }), { status: 400, headers: { "Content-Type": "application/json", ...getCorsHeaders(request, env) } });

    const user = await env.DB.prepare("SELECT id FROM users WHERE LOWER(username) = LOWER(?)").bind(username).first();
    if (!user) return new Response(JSON.stringify({ error: "User not found" }), { status: 404, headers: { "Content-Type": "application/json", ...getCorsHeaders(request, env) } });

    const queryNormTitle = normalizeTitle(title);
    const queryCleanArtist = getPrimaryArtist(artist);

    const allMeta = await env.DB.prepare("SELECT spotify_id, isrc, title, artist FROM track_metadata").all();
    const targetIsrcs = new Set(
        (allMeta.results || [])
            .filter(r => normalizeTitle(r.title) === queryNormTitle && getPrimaryArtist(r.artist) === queryCleanArtist)
            .map(r => r.isrc)
            .filter(Boolean)
    );

    const { results: allSnaps } = await env.DB.prepare("SELECT id, timestamp FROM snapshots WHERE user_id = ? ORDER BY id ASC").bind(user.id).all();
    
    const { results: allUserSongs } = await env.DB.prepare(`
        SELECT ss.title, ss.artist, ss.spotify_id, ss.views, s.id as snapshot_id, tm.isrc, tm.title as meta_title, tm.artist as meta_artist
        FROM snapshot_songs ss
        JOIN snapshots s ON ss.snapshot_id = s.id
        LEFT JOIN track_metadata tm ON ss.spotify_id = tm.spotify_id
        WHERE s.user_id = ?
        ORDER BY s.id ASC
    `).bind(user.id).all();

    const matchingChanges = (allUserSongs || []).filter(s => {
        if (s.isrc && targetIsrcs.has(s.isrc)) return true;
        const normT = normalizeTitle(s.meta_title || s.title);
        const primA = getPrimaryArtist(s.meta_artist || s.artist);
        return normT === queryNormTitle && primA === queryCleanArtist;
    });

    const historyData = [];
    let trackState = new Map();
    let historyIndex = 0;

    for (const snap of (allSnaps || [])) {
        while (historyIndex < matchingChanges.length && matchingChanges[historyIndex].snapshot_id <= snap.id) {
            const m = matchingChanges[historyIndex];
            const key = m.spotify_id || `${normalizeTitle(m.meta_title || m.title)}||${getPrimaryArtist(m.meta_artist || m.artist)}`;
            trackState.set(key, m.views);
            historyIndex++;
        }

        let sumViews = 0;
        for (const v of trackState.values()) sumViews += v;

        if (sumViews > 0) {
            historyData.push({ views: sumViews, timestamp: snap.timestamp });
        }
    }

    return new Response(JSON.stringify({ history: historyData || [] }), { headers: { "Content-Type": "application/json", ...getCorsHeaders(request, env) } });
}

async function handleActivityFeedAPI(request, env) {
    try {
        const { results } = await env.DB.prepare(`
            SELECT id, action_type, details, created_at
            FROM audit_logs
            WHERE action_type IN ('milestone_reached', 'new_track', 'user_add', 'profile_merge')
            ORDER BY id DESC
            LIMIT 30
        `).all();
        return new Response(JSON.stringify({ events: results || [] }), { headers: { "Content-Type": "application/json", ...getCorsHeaders(request, env) } });
    } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Content-Type": "application/json", ...getCorsHeaders(request, env) } });
    }
}

async function handleAdminStats(request, env) {
    const { secret } = await request.json().catch(() => ({}));
    if (!verifyAdminSecret(secret, env)) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json", ...getCorsHeaders(request, env) } });

    const userCount = await env.DB.prepare("SELECT COUNT(*) as cnt FROM users").first();
    const snapshotCount = await env.DB.prepare("SELECT COUNT(*) as cnt FROM snapshots").first();
    const songCount = await env.DB.prepare("SELECT COUNT(DISTINCT (LOWER(TRIM(title)) || ' - ' || LOWER(TRIM(artist)))) as cnt FROM snapshot_songs").first();
    const metadataCount = await env.DB.prepare("SELECT COUNT(*) as cnt FROM track_metadata").first();

    let dbSize = 0;
    try {
        const pcRes = await env.DB.prepare("PRAGMA page_count").first();
        const psRes = await env.DB.prepare("PRAGMA page_size").first();
        if (pcRes && psRes) dbSize = (pcRes.page_count || 0) * (psRes.page_size || 0);
    } catch (e) {}

    const scraperRunRes = await env.DB.prepare("SELECT MAX(last_scraped_at) as last_run FROM users").first();
    const scraped24h = await env.DB.prepare("SELECT COUNT(*) as cnt FROM users WHERE last_scraped_at >= datetime('now', '-24 hours')").first();

    const { results: usersList } = await env.DB.prepare(`
        SELECT u.id, u.username, u.last_scraped_at,
               (SELECT COUNT(*) FROM snapshots WHERE user_id = u.id) as snap_count,
               (SELECT MAX(timestamp) FROM snapshots WHERE user_id = u.id) as last_updated,
               (SELECT total_views FROM snapshots WHERE user_id = u.id ORDER BY id DESC LIMIT 1) as current_views
        FROM users u ORDER BY current_views DESC
    `).all();

    const { results: songCounts } = await env.DB.prepare(`
        SELECT id as snapshot_id, COALESCE(total_songs, (SELECT COUNT(DISTINCT (LOWER(TRIM(title)) || ' - ' || LOWER(TRIM(artist)))) FROM snapshot_songs WHERE snapshot_id = s.id)) as cnt
        FROM snapshots s WHERE id IN (SELECT MAX(id) FROM snapshots GROUP BY user_id)
    `).all();

    const songCountMap = new Map();
    (songCounts || []).forEach(r => songCountMap.set(r.snapshot_id, r.cnt));

    const { results: latestSnaps } = await env.DB.prepare("SELECT user_id, MAX(id) as latest_snap_id FROM snapshots GROUP BY user_id").all();
    const userLatestSnapMap = new Map();
    (latestSnaps || []).forEach(r => userLatestSnapMap.set(r.user_id, r.latest_snap_id));

    const data = {
        total_users: userCount.cnt || 0, total_snapshots: snapshotCount.cnt || 0, total_songs: songCount.cnt || 0,
        total_metadata: metadataCount.cnt || 0, db_size_bytes: dbSize,
        last_scraper_run: scraperRunRes ? scraperRunRes.last_run : null, scraped_24h: scraped24h ? scraped24h.cnt : 0,
        users: usersList.map(u => ({
            id: u.id, username: u.username, last_scraped_at: u.last_scraped_at || null, snap_count: u.snap_count || 0, last_updated: u.last_updated || null,
            views: u.current_views || 0, song_count: userLatestSnapMap.has(u.id) ? (songCountMap.get(userLatestSnapMap.get(u.id)) || 0) : 0
        }))
    };
    return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json", ...getCorsHeaders(request, env) } });
}

async function handleAdminExportUser(request, env) {
    const { secret, username } = await request.json().catch(() => ({}));
    if (!verifyAdminSecret(secret, env)) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...getCorsHeaders(request, env) } });
    if (!username) return new Response(JSON.stringify({ error: "Username required" }), { status: 400, headers: { ...getCorsHeaders(request, env) } });

    const cleanName = username.trim().replace(/^@/, "");
    const user = await env.DB.prepare("SELECT id FROM users WHERE LOWER(username) = LOWER(?)").bind(cleanName).first();
    if (!user) return new Response(JSON.stringify({ error: "User not found" }), { status: 404, headers: { ...getCorsHeaders(request, env) } });

    // Order ASC so we can rebuild state forwards
    const snapshots = await env.DB.prepare("SELECT id, total_views, timestamp FROM snapshots WHERE user_id = ? ORDER BY id ASC").bind(user.id).all();
    const songs = await env.DB.prepare("SELECT ss.title, ss.artist, ss.views, ss.spotify_id, ss.snapshot_id FROM snapshot_songs ss JOIN snapshots s ON ss.snapshot_id = s.id WHERE s.user_id = ? ORDER BY s.id ASC").bind(user.id).all();

    const historyData = [];
    const state = new Map();
    let songIdx = 0;
    const songsList = songs.results || [];
    
    for (const snap of (snapshots.results || [])) {
        while (songIdx < songsList.length && songsList[songIdx].snapshot_id === snap.id) {
            const s = songsList[songIdx];
            const key = `${s.title}||${s.artist}||${s.spotify_id}`;
            state.set(key, s);
            songIdx++;
        }
        
        historyData.push({
            timestamp: snap.timestamp,
            total_views: snap.total_views,
            songs: Array.from(state.values()).map(s => ({ title: s.title, artist: s.artist, views: s.views, spotify_id: s.spotify_id }))
        });
    }

    const exportData = {
        username: cleanName, exported_at: new Date().toISOString(),
        history: historyData.reverse()
    };
    return new Response(JSON.stringify(exportData, null, 2), { headers: { "Content-Type": "application/json;charset=UTF-8", ...getCorsHeaders(request, env) } });
}

async function handleAdminSyncProdDb(request, env) {
    const { secret, table, lastRowid } = await request.json().catch(() => ({}));
    if (!verifyAdminSecret(secret, env)) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: getCorsHeaders(request, env) });
    if (!env.DB_PROD) return new Response(JSON.stringify({ error: "DB_PROD binding is not configured in Cloudflare settings." }), { status: 400, headers: getCorsHeaders(request, env) });
    if (!table) return new Response(JSON.stringify({ error: "Table parameter required." }), { status: 400, headers: getCorsHeaders(request, env) });

    const pageSize = 2000;
    const startRowid = Number(lastRowid) || 0;

    try {
        if (startRowid === 0) {
            await env.DB.prepare(`DELETE FROM ${table}`).run();
        }

        let query = "";
        let insertStmt = "";
        let mapFn = null;
        let keyField = "id";

        if (table === "users") {
            query = "SELECT id, username, discord_id, discord_avatar, last_scraped_at FROM users WHERE id > ? ORDER BY id LIMIT ?";
            insertStmt = "INSERT INTO users (id, username, discord_id, discord_avatar, last_scraped_at) VALUES (?, ?, ?, ?, ?)";
            mapFn = u => [u.id, u.username, u.discord_id, u.discord_avatar, u.last_scraped_at];
            keyField = "id";
        } else if (table === "snapshots") {
            query = "SELECT id, user_id, total_views, total_songs, timestamp FROM snapshots WHERE id > ? ORDER BY id LIMIT ?";
            insertStmt = "INSERT INTO snapshots (id, user_id, total_views, total_songs, timestamp) VALUES (?, ?, ?, ?, ?)";
            mapFn = s => [s.id, s.user_id, s.total_views, s.total_songs, s.timestamp];
            keyField = "id";
        } else if (table === "snapshot_songs") {
            query = "SELECT rowid AS row_id, snapshot_id, spotify_id, title, artist, views FROM snapshot_songs WHERE rowid > ? ORDER BY rowid LIMIT ?";
            insertStmt = "INSERT INTO snapshot_songs (snapshot_id, spotify_id, title, artist, views) VALUES (?, ?, ?, ?, ?)";
            mapFn = s => [s.snapshot_id, s.spotify_id, s.title, s.artist, s.views];
            keyField = "row_id";
        } else if (table === "track_metadata") {
            query = "SELECT rowid AS row_id, spotify_id, isrc, title, artist, created_at FROM track_metadata WHERE rowid > ? ORDER BY rowid LIMIT ?";
            insertStmt = "INSERT INTO track_metadata (spotify_id, isrc, title, artist, created_at) VALUES (?, ?, ?, ?, ?)";
            mapFn = m => [m.spotify_id, m.isrc, m.title, m.artist, m.created_at];
            keyField = "row_id";
        } else if (table === "audit_logs") {
            query = "SELECT id, action_type, details, ip_address, created_at FROM audit_logs WHERE id > ? ORDER BY id LIMIT ?";
            insertStmt = "INSERT INTO audit_logs (id, action_type, details, ip_address, created_at) VALUES (?, ?, ?, ?, ?)";
            mapFn = l => [l.id, l.action_type, l.details, l.ip_address, l.created_at];
            keyField = "id";
        } else {
            return new Response(JSON.stringify({ error: "Invalid table." }), { status: 400, headers: getCorsHeaders(request, env) });
        }

        const { results: chunk } = await env.DB_PROD.prepare(query).bind(startRowid, pageSize).all();
        
        if (!chunk || chunk.length === 0) {
            return new Response(JSON.stringify({ success: true, done: true, copied: 0 }), { headers: { "Content-Type": "application/json", ...getCorsHeaders(request, env) } });
        }

        const stmt = env.DB.prepare(insertStmt);
        await env.DB.batch(chunk.map(row => stmt.bind(...mapFn(row))));

        const nextRowid = chunk[chunk.length - 1][keyField];
        const done = chunk.length < pageSize;

        return new Response(JSON.stringify({ success: true, nextRowid, done, copied: chunk.length }), { headers: { "Content-Type": "application/json", ...getCorsHeaders(request, env) } });
    } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Content-Type": "application/json", ...getCorsHeaders(request, env) } });
    }
}

async function handleAdminScrapeUser(request, env) {
    const { secret, username } = await request.json().catch(() => ({}));
    if (!verifyAdminSecret(secret, env)) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: getCorsHeaders(request, env) });

    const cleanName = username.trim().replace(/^@/, "");
    const user = await env.DB.prepare("SELECT id, discord_id FROM users WHERE LOWER(username) = LOWER(?)").bind(cleanName).first();
    if (!user) return new Response(JSON.stringify({ error: "User not found" }), { status: 404, headers: getCorsHeaders(request, env) });

    try {
        if (env.SCRAPE_QUEUE) await env.SCRAPE_QUEUE.send({ id: user.id, username: cleanName, discord_id: user.discord_id });
        else await scrapeAndSave(user.id, cleanName, user.discord_id, env);

        return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json", ...getCorsHeaders(request, env) } });
    } catch (err) { return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: getCorsHeaders(request, env) }); }
}

async function handleAdminScrapeAll(request, env, ctx) {
    const { secret } = await request.json().catch(() => ({}));
    if (!verifyAdminSecret(secret, env)) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: getCorsHeaders(request, env) });

    ctx.waitUntil(triggerGlobalScrape(env));

    return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json", ...getCorsHeaders(request, env) } });
}

async function triggerGlobalScrape(env) {
    try {
        // Берем по 10 человек, у которых прошло 10 минут
        const { results: users } = await env.DB.prepare(`
            SELECT id, username, discord_id
            FROM users
            WHERE last_scraped_at IS NULL OR last_scraped_at <= datetime('now', '-10 minutes')
            ORDER BY last_scraped_at ASC
            LIMIT 10
        `).all();

        if (!users || users.length === 0) return;

        let queueSuccess = false;

        if (env.SCRAPE_QUEUE) {
            try {
                const messages = users.map(u => ({ body: { id: u.id, username: u.username, discord_id: u.discord_id } }));
                await env.SCRAPE_QUEUE.sendBatch(messages);
                queueSuccess = true; // Ура, бесплатная очередь сработала
            } catch (queueErr) {
                // Лимит очередей исчерпан! Ошибка перехвачена, скрипт не падает.
                console.warn("Очереди закончились! Переходим на прямой парсинг...");
            }
        }

        // Обновляем таймер в БД, чтобы в следующую минуту взять СЛЕДУЮЩИХ 10 человек
        const userIds = users.map(u => u.id);
        await env.DB.prepare(`UPDATE users SET last_scraped_at = datetime('now') WHERE id IN (${userIds.map(()=>'?').join(',')})`).bind(...userIds).run();

        // МАГИЯ ЗДЕСЬ: Если очередь кончилась (или отключена) - парсим руками прямо тут!
        // Благодаря нашей оптимизации, 10 человек легко проскочат лимит в 10мс CPU.
        if (!queueSuccess) {
            for (const user of users) {
                try {
                    await scrapeAndSave(user.id, user.username, user.discord_id, env);
                } catch (err) {
                    console.error(`Ошибка при прямом парсинге @${user.username}:`, err.message);
                }
            }
        }
    } catch (e) {
        console.error("Cron execution error:", e);
    }
}



async function handleAdminPopulateMetadata(request, env, ctx) {
    const { secret, username } = await request.json().catch(() => ({}));
    if (!verifyAdminSecret(secret, env)) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: getCorsHeaders(request, env) });
    try {
        if (username) {
            await populateMetadataCache(env, username);
            return new Response(JSON.stringify({ success: true }), { headers: getCorsHeaders(request, env) });
        } else {
            ctx.waitUntil(populateMetadataCache(env));
            return new Response(JSON.stringify({ success: true }), { headers: getCorsHeaders(request, env) });
        }
    } catch (err) { return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: getCorsHeaders(request, env) }); }
}

async function populateMetadataCache(env, targetUsername = null) {
    let query = "SELECT id, username, discord_id FROM users";
    let bindParams = [];
    if (targetUsername) { query += " WHERE LOWER(username) = LOWER(?)"; bindParams.push(targetUsername); }
    const { results: users } = await env.DB.prepare(query).bind(...bindParams).all();
    const headers = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36" };

    for (const user of users) {
        try {
            let userId = user.discord_id;
            if (!userId) {
                const response = await fetch(`https://spicylyrics.org/${user.username}`, { headers });
                if (!response.ok) continue;
                const html = await response.text();
                // Легкий поиск
                const match = html.match(/avatars\/(\d{17,21})\//) || html.match(/"userId"\s*:\s*"?(\d{17,21})"?/);
                if (match) userId = match[1];
            }
            if (!userId) continue;

            const tracksRes = await fetch(`https://spicylyrics.org/api/trpc/ttml.getTTMLProfileTracks?input=${encodeURIComponent(JSON.stringify({ json: { id: userId } }))}`, { headers });
            if (!tracksRes.ok) continue;
            const tracksDetails = (await tracksRes.json()).result?.data?.json?.data || [];

            if (tracksDetails.length > 0) {
                const stmt = env.DB.prepare("INSERT OR REPLACE INTO track_metadata (spotify_id, isrc, title, artist) VALUES (?, ?, ?, ?)");
                const batch = tracksDetails.map(track => {
                    if (!track) return null;
                    const artistNames = (track.artists || []).map(a => a ? a.name : "SpicyLyrics").join(", ");
                    return stmt.bind(track.id, track.isrc || null, track.name || "Hidden", artistNames);
                }).filter(Boolean);
                if (batch.length > 0) await env.DB.batch(batch);
            }

            const latestSnap = await env.DB.prepare("SELECT id FROM snapshots WHERE user_id = ? ORDER BY id DESC LIMIT 1").bind(user.id).first();
            if (latestSnap) {
                const { results: snapSongs } = await env.DB.prepare(`
                    SELECT ss.spotify_id, ss.views, ss.title, ss.artist, tm.isrc, tm.title as meta_title, tm.artist as meta_artist
                    FROM (
                        SELECT ss.spotify_id, ss.views, ss.title, ss.artist, tm.isrc, tm.title as meta_title, tm.artist as meta_artist,
                               ROW_NUMBER() OVER(PARTITION BY LOWER(TRIM(ss.title)), LOWER(TRIM(ss.artist)) ORDER BY s.id DESC) as rn
                        FROM snapshot_songs ss
                        JOIN snapshots s ON ss.snapshot_id = s.id
                        LEFT JOIN track_metadata tm ON ss.spotify_id = tm.spotify_id
                        WHERE s.user_id = ?
                    ) ss WHERE rn = 1
                `).bind(user.id).all();
                const uniqueSongs = aggregateSongs(snapSongs);
                await env.DB.prepare("UPDATE snapshots SET total_songs = ? WHERE id = ?").bind(uniqueSongs.length, latestSnap.id).run();
            }
        } catch (err) {}
    }
}

async function handleAdminDeleteUser(request, env) {
    const { secret, username } = await request.json().catch(() => ({}));
    if (!verifyAdminSecret(secret, env)) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: getCorsHeaders(request, env) });
    const cleanName = username.trim().replace(/^@/, "");
    const user = await env.DB.prepare("SELECT id FROM users WHERE LOWER(username) = LOWER(?)").bind(cleanName).first();
    if (!user) return new Response(JSON.stringify({ error: "User not found" }), { status: 404, headers: getCorsHeaders(request, env) });

    try {
        await deleteUserFromDB(user.id, env);

        return new Response(JSON.stringify({ success: true }), { headers: getCorsHeaders(request, env) });
    } catch (err) { return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: getCorsHeaders(request, env) }); }
}

async function handleAdminMergeUsers(request, env) {
    const { secret, sourceUsername, targetUsername } = await request.json().catch(() => ({}));
    if (!verifyAdminSecret(secret, env)) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: getCorsHeaders(request, env) });

    const sourceClean = sourceUsername.trim().replace(/^@/, "");
    const targetClean = targetUsername.trim().replace(/^@/, "");
    if (sourceClean.toLowerCase() === targetClean.toLowerCase()) return new Response(JSON.stringify({ error: "Same profile" }), { status: 400, headers: getCorsHeaders(request, env) });

    const sourceUser = await env.DB.prepare("SELECT id FROM users WHERE LOWER(username) = LOWER(?)").bind(sourceClean).first();
    const targetUser = await env.DB.prepare("SELECT id FROM users WHERE LOWER(username) = LOWER(?)").bind(targetClean).first();

    if (!sourceUser || !targetUser) return new Response(JSON.stringify({ error: "User not found" }), { status: 404, headers: getCorsHeaders(request, env) });

    try {
        await env.DB.prepare("UPDATE snapshots SET user_id = ? WHERE user_id = ?").bind(targetUser.id, sourceUser.id).run();
        await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(sourceUser.id).run();

        return new Response(JSON.stringify({ success: true }), { headers: getCorsHeaders(request, env) });
    } catch (err) { return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: getCorsHeaders(request, env) }); }
}

async function handleAdminSearchMetadata(request, env) {
    const { secret, query } = await request.json().catch(() => ({}));
    if (!verifyAdminSecret(secret, env)) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: getCorsHeaders(request, env) });
    try {
        const searchQuery = `%${(query || "").trim()}%`;
        const { results } = await env.DB.prepare(`SELECT spotify_id, title, artist, isrc, created_at FROM track_metadata WHERE title LIKE ? OR artist LIKE ? OR isrc LIKE ? OR spotify_id LIKE ? LIMIT 50`).bind(searchQuery, searchQuery, searchQuery, searchQuery).all();
        return new Response(JSON.stringify({ results: results || [] }), { headers: { "Content-Type": "application/json", ...getCorsHeaders(request, env) } });
    } catch (err) { return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: getCorsHeaders(request, env) }); }
}

async function handleAdminUpdateMetadata(request, env) {
    const { secret, spotify_id, title, artist, isrc } = await request.json().catch(() => ({}));
    if (!verifyAdminSecret(secret, env)) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: getCorsHeaders(request, env) });
    if (!spotify_id) return new Response(JSON.stringify({ error: "Spotify ID required" }), { status: 400, headers: getCorsHeaders(request, env) });
    try {
        const cleanTitle = (title || "").trim();
        const cleanArtist = (artist || "").trim();
        const cleanIsrc = isrc ? isrc.trim() : null;
        await env.DB.prepare("UPDATE track_metadata SET title = ?, artist = ?, isrc = ? WHERE spotify_id = ?").bind(cleanTitle, cleanArtist, cleanIsrc, spotify_id).run();

        return new Response(JSON.stringify({ success: true }), { headers: getCorsHeaders(request, env) });
    } catch (err) { return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: getCorsHeaders(request, env) }); }
}

async function handleAdminPruneSnapshots(request, env) {
    const { secret, count, userId } = await request.json().catch(() => ({}));
    if (!verifyAdminSecret(secret, env)) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: getCorsHeaders(request, env) });
    try {
        const pruneCount = count || 3;
        let totalPruned = 0;

        if (userId) {
            totalPruned = await deleteOldestSnapshotsForUser(userId, pruneCount, env);
        } else {
            const { results: users } = await env.DB.prepare("SELECT id FROM users").all();
            for (const u of (users || [])) {
                totalPruned += await deleteOldestSnapshotsForUser(u.id, pruneCount, env);
            }
        }


        return new Response(JSON.stringify({ success: true, prunedCount: totalPruned }), { headers: { "Content-Type": "application/json", ...getCorsHeaders(request, env) } });
    } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: getCorsHeaders(request, env) });
    }
}

async function handleImport(request, env) {
    try {
        const { secret, username, history } = await request.json();
        if (!verifyAdminSecret(secret, env)) return new Response(JSON.stringify({ error: "Access Denied" }), { status: 401, headers: getCorsHeaders(request, env) });

        const cleanName = username.trim().replace(/^@/, "");
        let user = await env.DB.prepare("SELECT id FROM users WHERE LOWER(username) = LOWER(?)").bind(cleanName).first();
        if (!user) {
            const info = await env.DB.prepare("INSERT INTO users (username) VALUES (?)").bind(cleanName).run();
            user = { id: info.meta.last_row_id || info.meta.lastInsertedRowId };
        }

        let snapshotCount = 0;
        for (const record of history) {
            const timestamp = record.timestamp.replace("T", " ");
            const totalViews = record.data.total_views;
            const songs = record.data.songs;

            let totalSongsCount = 0;
            if (songs && Object.keys(songs).length > 0) {
                const rawList = Object.entries(songs).map(([songKey, sData]) => ({ spotify_id: songKey.length < 30 ? songKey : "", title: sData.title, artist: sData.artist, views: sData.views || 0, isrc: null }));
                totalSongsCount = aggregateSongs(rawList).length;
            }

            const songEntries = (songs && Object.keys(songs).length > 0)
                ? Object.entries(songs).map(([songKey, sData]) => ({
                    spotify_id: songKey.length < 30 ? songKey : "",
                    title: sData.title,
                    artist: sData.artist,
                    views: sData.views || 0
                }))
                : [];
            await saveSnapshotWithRetry(user.id, totalViews, totalSongsCount, songEntries, env, timestamp);
            snapshotCount++;
        }
        return new Response(JSON.stringify({ success: true, imported: snapshotCount }), { headers: { "Content-Type": "application/json", ...getCorsHeaders(request, env) } });
    } catch (err) { return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: getCorsHeaders(request, env) }); }
}

function handleExport() {
    return new Response(JSON.stringify({ error: "Exports restricted. Contact admin." }), { status: 403, headers: getCorsHeaders(request, env) });
}

// ==========================================
// UTILITY И SCRAPER ФУНКЦИИ (ОПТИМИЗИРОВАННЫЕ)
// ==========================================

function parseDate(rawStr) {
    if (!rawStr) return null;
    let s = rawStr.trim();
    if (!s.endsWith('Z') && !s.includes('+') && !s.match(/-\d{2}:\d{2}$/)) s = s.replace(' ', 'T') + 'Z';
    else s = s.replace(' ', 'T');
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
}

function aggregateSongs(rawList) {
    const groupsMap = new Map();
    const groups = [];

    for (const s of rawList || []) {
        const title = (s.meta_title || s.title || "Hidden").trim();
        const artist = (s.meta_artist || s.artist || "SpicyLyrics").trim();
        const normTitle = normalizeTitle(title);
        const primaryArtist = getPrimaryArtist(artist);
        const isrc = s.isrc ? s.isrc.trim() : null;

        const textKey = `text:${normTitle}|||${primaryArtist}`;
        const isrcKey = isrc ? `isrc:${isrc}` : null;

        let foundGroup = null;
        if (isrcKey && groupsMap.has(isrcKey)) foundGroup = groupsMap.get(isrcKey);
        else if (groupsMap.has(textKey)) foundGroup = groupsMap.get(textKey);

        const views = s.views || 0;
        const prevViews = s.prevViews !== undefined && s.prevViews !== null ? s.prevViews : views;

        const songInfo = { spotify_id: s.spotify_id, title, artist, normTitle, primaryArtist, cleanArtist: artist.toLowerCase(), isrc, views, prevViews };

        if (foundGroup) {
            foundGroup.songs.push(songInfo);
            foundGroup.views += songInfo.views;
            foundGroup.prevViews += songInfo.prevViews;
            if (title.length < foundGroup.title.length) foundGroup.title = title;
            if (artist.length < foundGroup.artist.length) foundGroup.artist = artist;
            if (isrcKey && !groupsMap.has(isrcKey)) groupsMap.set(isrcKey, foundGroup);
            if (!groupsMap.has(textKey)) groupsMap.set(textKey, foundGroup);
        } else {
            const newGroup = { songs: [songInfo], views: songInfo.views, prevViews: songInfo.prevViews, title, artist };
            groups.push(newGroup);
            if (isrcKey) groupsMap.set(isrcKey, newGroup);
            groupsMap.set(textKey, newGroup);
        }
    }

    return groups.map(g => {
        const growth = g.views - g.prevViews;
        const pct = g.prevViews > 0 ? (growth / g.prevViews) * 100 : 0;
        return {
            title: g.title,
            artist: g.artist,
            views: g.views,
            growth: growth,
            pct: pct,
            spotify_id: g.songs[0].spotify_id,
            isrc: g.songs.find(x => x.isrc)?.isrc || null,
            normTitle: g.songs[0].normTitle,
            primaryArtist: g.songs[0].primaryArtist
        };
    });
}

async function deleteUserFromDB(userId, env) {
    await env.DB.batch([
        env.DB.prepare("DELETE FROM snapshot_songs WHERE snapshot_id IN (SELECT id FROM snapshots WHERE user_id = ?)").bind(userId),
        env.DB.prepare("DELETE FROM snapshots WHERE user_id = ?").bind(userId),
        env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId)
    ]);
}

async function deleteOldestSnapshotsForUser(userId, count, env) {
    try {
        await env.DB.prepare(
            "DELETE FROM snapshot_songs WHERE snapshot_id IN (SELECT id FROM snapshots WHERE user_id = ? ORDER BY id ASC LIMIT ?)"
        ).bind(userId, count).run().catch(() => {});

        const res = await env.DB.prepare(
            "DELETE FROM snapshots WHERE id IN (SELECT id FROM snapshots WHERE user_id = ? ORDER BY id ASC LIMIT ?)"
        ).bind(userId, count).run().catch(() => {});

        return res?.meta?.changes || count;
    } catch (err) {
        console.error(`Failed to prune old snapshots for user ${userId}:`, err);
        return 0;
    }
}

async function saveSnapshotWithRetry(userId, totalViews, totalSongsCount, songEntries, env, customTimestamp = null, maxAttempts = 3) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        let createdSnapshotId = null;
        try {
            const query = customTimestamp
                ? "INSERT INTO snapshots (user_id, total_views, total_songs, timestamp) VALUES (?, ?, ?, ?)"
                : "INSERT INTO snapshots (user_id, total_views, total_songs, timestamp) VALUES (?, ?, ?, datetime('now'))";

            const bindArgs = customTimestamp
                ? [userId, totalViews, totalSongsCount, customTimestamp]
                : [userId, totalViews, totalSongsCount];

            const info = await env.DB.prepare(query).bind(...bindArgs).run();
            createdSnapshotId = info.meta?.last_row_id || info.meta?.lastInsertedRowId;

            if (songEntries && songEntries.length > 0 && createdSnapshotId) {
                const stmt = env.DB.prepare("INSERT INTO snapshot_songs (snapshot_id, spotify_id, title, artist, views) VALUES (?, ?, ?, ?, ?)");
                const batch = songEntries.map(song => stmt.bind(
                    createdSnapshotId,
                    song.spotify_id || "",
                    song.title || "Hidden",
                    song.artist || "SpicyLyrics",
                    song.views || 0
                ));
                await env.DB.batch(batch);
            }

            return createdSnapshotId;
        } catch (err) {
            console.error(`DB Write attempt ${attempt}/${maxAttempts} failed for user ${userId}:`, err.message);

            if (createdSnapshotId) {
                await env.DB.prepare("DELETE FROM snapshot_songs WHERE snapshot_id = ?").bind(createdSnapshotId).run().catch(() => {});
                await env.DB.prepare("DELETE FROM snapshots WHERE id = ?").bind(createdSnapshotId).run().catch(() => {});
            }

            if (attempt < maxAttempts) {
                // Delete 5 oldest snapshots of THIS user to free up plenty of space
                const deletedCount = await deleteOldestSnapshotsForUser(userId, 5, env);
                if (deletedCount === 0) {
                    throw err;
                }
            } else {
                throw err;
            }
        }
    }
}

async function fetchUserDataFromAPI(username, discordId = null) {
    const headers = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36" };
    let userId = discordId, discord_avatar = null;

    // СУПЕР БЫСТРЫЙ ПАРСИНГ (Без тяжелых регулярок HTML)
    if (!userId) {
        const response = await fetch(`https://spicylyrics.org/${username}`, { headers });
        if (response.status === 404) throw new Error("USER_NOT_FOUND");
        if (!response.ok) return null;

        const html = await response.text();
        // Ищем только цифры ID
        let match = html.match(/avatars\/(\d{17,21})\//) || html.match(/"userId"\s*:\s*"?(\d{17,21})"?/i);

        if (match) userId = match[1];
        else throw new Error("USER_NOT_CREATOR");
    }

    const profileRes = await fetch(`https://spicylyrics.org/api/trpc/ttml.getTTMLProfile?input=${encodeURIComponent(JSON.stringify({ json: { id: userId, includeTracks: true } }))}`, { headers });
    if (!profileRes.ok) return null;
    const profileJson = await profileRes.json();

    const perUser = profileJson.result?.data?.json?.perUser;
    const profile = profileJson.result?.data?.json?.profile;
    if (!perUser && !profile) throw new Error("USER_NOT_FOUND");

    // Аватарка напрямую из API JSON
    discord_avatar = profile?.data?.avatar || perUser?.avatar || null;

    const tracksRes = await fetch(`https://spicylyrics.org/api/trpc/ttml.getTTMLProfileTracks?input=${encodeURIComponent(JSON.stringify({ json: { id: userId } }))}`, { headers });
    if (!tracksRes.ok) return null;
    const tracksDetails = (await tracksRes.json()).result?.data?.json?.data || [];

    const tracksMap = new Map();
    for (const track of tracksDetails) {
        if (!track) continue;
        tracksMap.set(track.id, { title: track.name || "Hidden", artist: (track.artists || []).map(a => a ? a.name : "SpicyLyrics").join(", "), isrc: track.isrc || null });
    }

    let total_views = 0, songs = [];
    for (const item of (perUser?.makes || [])) {
        const views = item.view_count || 0;
        total_views += views;
        const detail = tracksMap.get(item.id);
        const title = detail?.title || item.title || item.name || item.track_name || "Hidden";
        const artist = detail?.artist || item.artist || item.artist_name || "SpicyLyrics";
        songs.push({
            spotify_id: item.id || "",
            title,
            artist,
            isrc: detail?.isrc || null,
            views
        });
    }

    return { total_views, songs, tracksDetails, discord_id: userId, discord_avatar };
}

async function scrapeAndSave(userId, username, discordId, env) {
    let data = null;
    try {
        data = await fetchUserDataFromAPI(username, discordId);
    } catch (err) {
        if (err.message === "USER_NOT_FOUND" || err.message === "USER_NOT_CREATOR") {
            const hasSnapshots = await env.DB.prepare("SELECT 1 FROM snapshots WHERE user_id = ? LIMIT 1").bind(userId).first();
            if (!hasSnapshots) await deleteUserFromDB(userId, env);

            return;
        }
        throw err;
    }

    if (!data) return;

    const prevSnap = await env.DB.prepare("SELECT id, total_views FROM snapshots WHERE user_id = ? ORDER BY id DESC LIMIT 1").bind(userId).first();
    const oldViews = prevSnap ? prevSnap.total_views : 0;

    // EARLY EXIT: Если просмотры не поменялись, просто выходим
    if (prevSnap && oldViews === data.total_views) {
        return;
    }

    if (!data.songs || data.songs.length === 0) return;

    if (data.tracksDetails && data.tracksDetails.length > 0) {
        const stmt = env.DB.prepare("INSERT OR IGNORE INTO track_metadata (spotify_id, isrc, title, artist) VALUES (?, ?, ?, ?)");
        const batch = [];
        for (const track of data.tracksDetails) {
            if (!track) continue;
            batch.push(stmt.bind(track.id, track.isrc || null, track.name || "Hidden", (track.artists || []).map(a => a ? a.name : "SpicyLyrics").join(", ")));
        }
        if (batch.length > 0) await env.DB.batch(batch);
    }

    const totalSongsCount = aggregateSongs(data.songs).length;

    // Fetch latest known views for all songs for delta compression
    let latestSongsMap = new Map();
    if (prevSnap) {
        const { results: latestSongs } = await env.DB.prepare(`
            SELECT title, artist, views
            FROM (
                SELECT ss.title, ss.artist, ss.views,
                       ROW_NUMBER() OVER(PARTITION BY LOWER(TRIM(ss.title)), LOWER(TRIM(ss.artist)) ORDER BY s.id DESC) as rn
                FROM snapshot_songs ss
                JOIN snapshots s ON ss.snapshot_id = s.id
                WHERE s.user_id = ?
            )
            WHERE rn = 1
        `).bind(userId).all();
        
        for (const ls of (latestSongs || [])) {
            const key = `${(ls.title || "").trim().toLowerCase()}|||${(ls.artist || "").trim().toLowerCase()}`;
            latestSongsMap.set(key, ls.views);
        }
    }

    const changedSongs = [];
    for (const song of data.songs) {
        const key = `${(song.title || "").trim().toLowerCase()}|||${(song.artist || "").trim().toLowerCase()}`;
        const prevViews = latestSongsMap.get(key);
        if (prevViews === undefined || prevViews !== song.views) {
            changedSongs.push(song);
        }
    }

    try {
        await saveSnapshotWithRetry(userId, data.total_views, totalSongsCount, changedSongs, env);
    } catch (saveErr) {
        console.error(`Failed to save snapshot for user ${userId} (@${username}):`, saveErr.message);

        return;
    }

    // Уведомление о майлстоунах
    if (oldViews > 0 && Math.floor(data.total_views / 50000) > Math.floor(oldViews / 50000)) {
        const ms = Math.floor(data.total_views / 50000) * 50000;

    }

    if (data.discord_id) {
        await env.DB.prepare("UPDATE users SET discord_id = ?, discord_avatar = ? WHERE id = ?").bind(data.discord_id, data.discord_avatar || null, userId).run().catch(() => {});
    }
}

async function handleGetNotificationSettings(request, env) {
    try {
        const settings = await env.DB.prepare("SELECT enabled, type, title, message, style_template, updated_at FROM notification_settings WHERE id = 1").first();
        return new Response(JSON.stringify(settings || { enabled: 0 }), {
            headers: { "Content-Type": "application/json", ...getCorsHeaders(request, env) }
        });
    } catch (err) {
        if (err.message.includes("no such table")) {
            try {
                await env.DB.prepare(`
                    CREATE TABLE IF NOT EXISTS notification_settings (
                        id INTEGER PRIMARY KEY,
                        enabled INTEGER DEFAULT 0,
                        type TEXT DEFAULT 'banner',
                        title TEXT DEFAULT '',
                        message TEXT DEFAULT '',
                        style_template TEXT DEFAULT 'warning',
                        updated_at TEXT DEFAULT (datetime('now'))
                    )
                `).run();
                await env.DB.prepare(`
                    INSERT OR IGNORE INTO notification_settings (id, enabled, type, title, message, style_template)
                    VALUES (1, 0, 'banner', 'Технические работы', 'На сайте проводятся технические работы. Пожалуйста, зайдите позже.', 'warning')
                `).run();
                
                const settings = await env.DB.prepare("SELECT enabled, type, title, message, style_template, updated_at FROM notification_settings WHERE id = 1").first();
                return new Response(JSON.stringify(settings || { enabled: 0 }), {
                    headers: { "Content-Type": "application/json", ...getCorsHeaders(request, env) }
                });
            } catch (createErr) {
                return new Response(JSON.stringify({ error: createErr.message }), { status: 500, headers: { "Content-Type": "application/json", ...getCorsHeaders(request, env) } });
            }
        }
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Content-Type": "application/json", ...getCorsHeaders(request, env) } });
    }
}

async function handleSaveNotificationSettings(request, env) {
    try {
        const { secret, enabled, type, title, message, style_template } = await request.json().catch(() => ({}));
        if (!verifyAdminSecret(secret, env)) {
            return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json", ...getCorsHeaders(request, env) } });
        }

        const runUpdate = async () => {
            return await env.DB.prepare(`
                UPDATE notification_settings
                SET enabled = ?, type = ?, title = ?, message = ?, style_template = ?, updated_at = datetime('now')
                WHERE id = 1
            `).bind(
                enabled ? 1 : 0,
                type || 'banner',
                title || '',
                message || '',
                style_template || 'warning'
            ).run();
        };

        try {
            const info = await runUpdate();
            if (!info.meta.changes || info.meta.changes === 0) {
                await env.DB.prepare(`
                    INSERT OR IGNORE INTO notification_settings (id, enabled, type, title, message, style_template)
                    VALUES (1, 0, 'banner', 'Технические работы', 'На сайте проводятся технические работы. Пожалуйста, зайдите позже.', 'warning')
                `).run();
                await runUpdate();
            }
        } catch (err) {
            if (err.message.includes("no such table")) {
                await env.DB.prepare(`
                    CREATE TABLE IF NOT EXISTS notification_settings (
                        id INTEGER PRIMARY KEY,
                        enabled INTEGER DEFAULT 0,
                        type TEXT DEFAULT 'banner',
                        title TEXT DEFAULT '',
                        message TEXT DEFAULT '',
                        style_template TEXT DEFAULT 'warning',
                        updated_at TEXT DEFAULT (datetime('now'))
                    )
                `).run();
                await env.DB.prepare(`
                    INSERT OR IGNORE INTO notification_settings (id, enabled, type, title, message, style_template)
                    VALUES (1, 0, 'banner', 'Технические работы', 'На сайте проводятся технические работы. Пожалуйста, зайдите позже.', 'warning')
                `).run();
                await runUpdate();
            } else {
                throw err;
            }
        }



        return new Response(JSON.stringify({ success: true }), {
            headers: { "Content-Type": "application/json", ...getCorsHeaders(request, env) }
        });
    } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Content-Type": "application/json", ...getCorsHeaders(request, env) } });
    }
}
