const IMPORT_SECRET = "Spicy_Admin_#7f8c9b2d4e1a0673f8b9d07c01a2f3e4";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Access-Control-Allow-Headers": "Content-Type",
};

// ==========================================
// GLOBALLY COMPILED REGEXES (CPU OPTIMIZATION)
// ==========================================
const REGEX_TITLE_CLEAN = /\s*[-\(]\s*(?:20\d{2}\s+)?(?:remastered|remaster|deluxe|edit|radio edit|live|acoustic)[\)]?/gi;
const REGEX_ARTIST_CLEAN = /\s+(?:feat\.?|ft\.?|&|and)\s+/gi;
const REGEX_NON_ALPHANUM = /[^a-z0-9а-яё]/g;

// In-memory rate limiting
const rateLimitMap = new Map();

function isRateLimited(ip, limit, windowMs) {
    const now = Date.now();
    if (rateLimitMap.size > 10000) {
        for (const [key, timestamps] of rateLimitMap.entries()) {
            const active = timestamps.filter(ts => now - ts < windowMs);
            if (active.length === 0) rateLimitMap.delete(key);
            else rateLimitMap.set(key, active);
        }
    }

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
        await env.DB.prepare("ALTER TABLE users ADD COLUMN discord_id TEXT").run().catch(() => {});
        await env.DB.prepare("ALTER TABLE users ADD COLUMN discord_avatar TEXT").run().catch(() => {});
        // POISON PILL FIX: Tracking scrape queue independently of successful snapshot inserts
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
            CREATE TABLE IF NOT EXISTS audit_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                action_type TEXT NOT NULL,
                details TEXT NOT NULL,
                ip_address TEXT,
                created_at TEXT DEFAULT (datetime('now'))
            )
        `).run().catch(() => {});
        await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC)").run().catch(() => {});

        schemaChecked = true;
    } catch (e) {
        // Ignore schema alter errors if they already exist
    }
}

const allowedOrigins = [
    "https://spicy-stats.glyph-labs.site",
    "https://stats.pidoras.dev",
    "http://localhost:3000",
    "http://localhost:5173",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:5173"
];

function getCorsHeaders(request) {
    const origin = request.headers.get("Origin") || "";
    const isAllowed = allowedOrigins.includes(origin) || origin.endsWith(".vercel.app");
    return {
        "Access-Control-Allow-Origin": isAllowed ? origin : "https://spicy-stats.glyph-labs.site",
        "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
        "Access-Control-Max-Age": "86400",
        "Access-Control-Allow-Headers": "Content-Type, X-Spicy-Signature, X-Spicy-Timestamp",
    };
}

async function logAction(env, actionType, details, request) {
    let ipAddress = null;
    if (request) ipAddress = request.headers.get("CF-Connecting-IP") || request.headers.get("x-real-ip") || "Unknown IP";
    try {
        await env.DB.prepare("INSERT INTO audit_logs (action_type, details, ip_address) VALUES (?, ?, ?)").bind(actionType, details, ipAddress).run();
    } catch (err) {}
}

function verifySignature(request, path) {
    const timestampStr = request.headers.get("X-Spicy-Timestamp");
    const signature = request.headers.get("X-Spicy-Signature");

    if (!timestampStr || !signature) return false;

    const timestamp = parseInt(timestampStr, 10);
    if (isNaN(timestamp)) return false;

    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestamp) > 90) return false;

    const expected = generateSignature(path, timestampStr);
    return signature === expected;
}

function generateSignature(path, timestamp) {
    const salt = "SpicyLyrics_API_Secured_2026_GlyphLabs";
    const str = `${timestamp}:${path}:${salt}`;
    let hash = 5381;
    for (let i = 0; i < str.length; i++) hash = ((hash << 5) + hash) + str.charCodeAt(i);
    return (hash >>> 0).toString(16);
}

export default {
    async fetch(request, env, ctx) {
        ctx.waitUntil(checkSchema(env));
        const url = new URL(request.url);

        if (request.method === "OPTIONS") {
            return new Response(null, {
                headers: {
                    ...getCorsHeaders(request),
                    "Access-Control-Allow-Headers": request.headers.get("Access-Control-Request-Headers") || "Content-Type, X-Spicy-Signature, X-Spicy-Timestamp"
                }
            });
        }

        const path = url.pathname;
        const isPublicAPI = path.startsWith("/api/") && !path.startsWith("/api/export/") && !path.startsWith("/api/import");
        if (isPublicAPI) {
            if (!verifySignature(request, path)) {
                return new Response(JSON.stringify({ error: "Forbidden: API request signature verification failed." }), {
                    status: 403,
                    headers: { "Content-Type": "application/json", ...getCorsHeaders(request) }
                });
            }
        }

        const ip = request.headers.get("CF-Connecting-IP") || "anonymous";
        const lang = request.headers.get("X-Spicy-Lang") || "en";
        const rateLimitMsgs = {
            en: "Too many requests.", ru: "Слишком много запросов.", uk: "Занадто багато запитів.",
            pl: "Zbyt wiele zapytań.", de: "Zu viele Anfragen.", it: "Troppe richieste."
        };
        const rateLimitMsg = rateLimitMsgs[lang] || rateLimitMsgs.en;

        if (url.pathname === "/api/add-user" && request.method === "POST") {
            if (isRateLimited(ip, 5, 60000)) return new Response(JSON.stringify({ error: rateLimitMsg }), { status: 429, headers: { "Content-Type": "application/json", ...getCorsHeaders(request) } });
        } else if (url.pathname.startsWith("/api/")) {
            if (isRateLimited(ip, 60, 60000)) return new Response(JSON.stringify({ error: rateLimitMsg }), { status: 429, headers: { "Content-Type": "application/json", ...getCorsHeaders(request) } });
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
            else if (url.pathname === "/api/admin/logs" && request.method === "POST") response = await handleAdminLogs(request, env);
            else if (url.pathname === "/api/admin/merge-users" && request.method === "POST") response = await handleAdminMergeUsers(request, env);
            else if (url.pathname === "/api/admin/delete-user" && request.method === "POST") response = await handleAdminDeleteUser(request, env);
            else if (url.pathname === "/api/admin/export-user" && request.method === "POST") response = await handleAdminExportUser(request, env);
            else response = new Response(JSON.stringify({ error: "API Endpoint Not Found" }), { status: 404, headers: { "Content-Type": "application/json" } });
        } catch (err) {
            response = new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Content-Type": "application/json" } });
        }

        const finalHeaders = new Headers(response.headers);
        for (const [key, val] of Object.entries(getCorsHeaders(request))) finalHeaders.set(key, val);

        return new Response(response.body, { status: response.status, statusText: response.statusText, headers: finalHeaders });
    },

    async scheduled(event, env, ctx) {
        const run = async () => {
            try {
                await checkSchema(env);
                await runScraper(env);
            } catch (err) {
                console.error("Cron scraper error:", err.message);
            }
        };

        if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(run());
        else if (event && typeof event.waitUntil === "function") event.waitUntil(run());
        else await run();
    }
};

// ==========================================
// CORE API METHODS (JSON)
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

    if (!username || typeof username !== "string") return new Response(JSON.stringify({ error: getMsg("valid_username") }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } });

    const cleanName = username.trim().replace(/^@/, "");
    if (cleanName.length === 0 || cleanName.length > 50 || !/^[a-zA-Z0-9_\.\-]+$/.test(cleanName)) return new Response(JSON.stringify({ error: getMsg("invalid_username") }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } });

    const existingUser = await env.DB.prepare("SELECT id FROM users WHERE LOWER(username) = LOWER(?)").bind(cleanName).first();
    if (existingUser) return new Response(JSON.stringify({ error: getMsg("already_added") }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } });

    let data;
    try {
        data = await fetchUserDataFromAPI(cleanName);
    } catch (err) {
        let msg = getMsg("fetch_error");
        if (err.message === "USER_NOT_FOUND") msg = getMsg("not_found");
        if (err.message === "USER_NOT_CREATOR") msg = getMsg("not_creator");
        return new Response(JSON.stringify({ error: msg }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    if (!data) return new Response(JSON.stringify({ error: getMsg("failed_retrieve") }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } });

    const tracksCount = data.songs ? data.songs.length : 0;
    if (tracksCount < 2) return new Response(JSON.stringify({ error: getMsg("min_tracks", tracksCount) }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } });

    await env.DB.prepare("INSERT INTO users (username, discord_id, discord_avatar, last_scraped_at) VALUES (?, ?, ?, datetime('now')) ON CONFLICT(username) DO NOTHING")
        .bind(cleanName, data.discord_id || null, data.discord_avatar || null)
        .run();

    await logAction(env, "user_add", `Added new creator: @${cleanName}`, request);

    const savedUser = await env.DB.prepare("SELECT id, username, discord_id FROM users WHERE LOWER(username) = LOWER(?)").bind(cleanName).first();
    if (savedUser) ctx.waitUntil(scrapeAndSave(savedUser.id, savedUser.username, savedUser.discord_id, env));

    return new Response(JSON.stringify({ success: true, cleanName }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
}

async function handleDashboardAPI(request, env) {
    const globalQuery = await env.DB.prepare("SELECT COUNT(id) as total_users FROM users").first();
    await logAction(env, "visit_dashboard", "Loaded main dashboard", request);

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
        u.username, ls.latest_views AS current_views, ls.latest_timestamp AS last_updated, s_past.total_views AS past_views,
        (SELECT timestamp FROM snapshots WHERE user_id = u.id ORDER BY id ASC LIMIT 1) AS first_snapshot,
        s_past_7d.id AS past_7d_id,
        COALESCE(ls.latest_total_songs, (SELECT COUNT(DISTINCT LOWER(COALESCE(NULLIF(TRIM(title), ''), 'Hidden')) || '|||' || LOWER(COALESCE(NULLIF(TRIM(artist), ''), 'SpicyLyrics'))) FROM snapshot_songs WHERE snapshot_id = ls.latest_id), 0) AS total_songs,
        COALESCE(s_past_7d.total_songs, (SELECT COUNT(DISTINCT LOWER(COALESCE(NULLIF(TRIM(title), ''), 'Hidden')) || '|||' || LOWER(COALESCE(NULLIF(TRIM(artist), ''), 'SpicyLyrics'))) FROM snapshot_songs WHERE snapshot_id = s_past_7d.id), 0) AS total_songs_7d
    FROM users u
    LEFT JOIN latest_snapshots ls ON ls.user_id = u.id
    LEFT JOIN snapshots s_past ON s_past.id = (
        SELECT id FROM snapshots s_past_in
        WHERE s_past_in.user_id = u.id AND s_past_in.timestamp >= datetime((SELECT timestamp FROM snapshots WHERE user_id = s_past_in.user_id ORDER BY id DESC LIMIT 1), '-30 hours') AND s_past_in.timestamp <= datetime((SELECT timestamp FROM snapshots WHERE user_id = s_past_in.user_id ORDER BY id DESC LIMIT 1), '-18 hours')
        ORDER BY ABS(strftime('%s', s_past_in.timestamp) - strftime('%s', datetime((SELECT timestamp FROM snapshots WHERE user_id = s_past_in.user_id ORDER BY id DESC LIMIT 1), '-24 hours'))) ASC LIMIT 1
    )
    LEFT JOIN snapshots s_past_7d ON s_past_7d.id = (
        SELECT id FROM snapshots s_7d_in
        WHERE s_7d_in.user_id = u.id AND s_7d_in.timestamp >= datetime((SELECT timestamp FROM snapshots WHERE user_id = s_7d_in.user_id ORDER BY id DESC LIMIT 1), '-8.5 days') AND s_7d_in.timestamp <= datetime((SELECT timestamp FROM snapshots WHERE user_id = s_7d_in.user_id ORDER BY id DESC LIMIT 1), '-5.5 days')
        ORDER BY ABS(strftime('%s', s_7d_in.timestamp) - strftime('%s', datetime((SELECT timestamp FROM snapshots WHERE user_id = s_7d_in.user_id ORDER BY id DESC LIMIT 1), '-7 days'))) ASC LIMIT 1
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

    return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json", ...corsHeaders } });
}

async function handleUserDetailAPI(username, request, env) {
    const user = await env.DB.prepare("SELECT * FROM users WHERE LOWER(username) = LOWER(?)").bind(username).first();
    if (!user) return new Response(JSON.stringify({ error: "User not found" }), { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } });

    await logAction(env, "visit_profile", `Viewed profile for @${user.username}`, request);

    const firstSnapshot = await env.DB.prepare("SELECT timestamp FROM snapshots WHERE user_id = ? ORDER BY id ASC LIMIT 1").bind(user.id).first();
    const { results: history } = await env.DB.prepare("SELECT id, total_views, timestamp FROM snapshots WHERE user_id = ? ORDER BY id DESC LIMIT 100").bind(user.id).all();

    let totalViews = 0, growth24h = null, totalSongs = 0;
    let topTracks = [], chartDataRaw = [], finalSongs = [];

    if (history && history.length > 0) {
        let latestSnapshot = null, latestRaw = [];
        for (const snap of history) {
            const { results: songs } = await env.DB.prepare(`
                SELECT ss.spotify_id, ss.views, ss.title, ss.artist, tm.isrc, tm.title as meta_title, tm.artist as meta_artist
                FROM snapshot_songs ss LEFT JOIN track_metadata tm ON ss.spotify_id = tm.spotify_id WHERE ss.snapshot_id = ?
            `).bind(snap.id).all();
            if (songs && songs.length > 0) {
                latestSnapshot = snap; latestRaw = songs; break;
            }
        }

        if (!latestSnapshot) latestSnapshot = history[0];
        totalViews = history[0].total_views;

        const latestDate = parseDate(latestSnapshot.timestamp);
        const latestTimeMs = latestDate ? latestDate.getTime() : Date.now();
        const pastSnapshot = history.find(h => {
            const d = parseDate(h.timestamp);
            return d && d.getTime() <= latestTimeMs - 24 * 60 * 60 * 1000;
        });

        let has24h = pastSnapshot !== undefined;
        growth24h = has24h ? totalViews - pastSnapshot.total_views : null;

        let pastRaw = [];
        if (has24h) {
            const { results } = await env.DB.prepare(`
                SELECT ss.spotify_id, ss.views, ss.title, ss.artist, tm.isrc, tm.title as meta_title, tm.artist as meta_artist
                FROM snapshot_songs ss LEFT JOIN track_metadata tm ON ss.spotify_id = tm.spotify_id WHERE ss.snapshot_id = ?
            `).bind(pastSnapshot.id).all();
            if (results) pastRaw = results;
        }

        const latestSongs = aggregateSongs(latestRaw);
        const pastSongs = aggregateSongs(pastRaw);
        totalSongs = latestSongs.length;

        const findPastViews = (ls, pastSongsList) => {
            for (const ps of pastSongsList) {
                if (ls.isrc && ps.isrc && ls.isrc === ps.isrc) return ps.views;
                if (ls.normTitle === ps.normTitle && ls.primaryArtist === ps.primaryArtist) return ps.views;
            }
            return null;
        };

        finalSongs = latestSongs.map(s => {
            const prev = findPastViews(s, pastSongs) ?? s.views;
            const g = s.views - prev;
            return { ...s, growth: g, pct: prev > 0 ? (g / prev) * 100 : 0 };
        }).sort((a, b) => b.growth - a.growth);

        topTracks = finalSongs.slice(0, 3).filter(x => x.growth > 0 || totalViews > 0);
        chartDataRaw = [...history].reverse().map(h => ({ x: h.timestamp, y: h.total_views }));
    }

    let nextUpdateTimestamp = null;
    try {
        const { results: queue } = await env.DB.prepare(`SELECT id FROM users ORDER BY last_scraped_at ASC NULLS FIRST`).all();
        const userIndex = (queue || []).findIndex(q => q.id === user.id);
        if (userIndex !== -1) {
            const now = new Date();
            const nextCron = new Date(now.getTime() + 60000);
            nextCron.setSeconds(0); nextCron.setMilliseconds(0);
            // batch index mapped to new scraper batch size = 3
            const batchIndex = Math.floor(userIndex / 3);
            nextUpdateTimestamp = new Date(nextCron.getTime() + batchIndex * 60000).toISOString();
        }
    } catch (e) {}

    const data = {
        username: user.username, discord_id: user.discord_id || null, discord_avatar: user.discord_avatar || null,
        total_views: totalViews, growth24h, first_snapshot: firstSnapshot ? firstSnapshot.timestamp : null,
        total_songs: totalSongs, highlights: topTracks, chart_data: chartDataRaw, songs: finalSongs,
        next_update: nextUpdateTimestamp, server_time: new Date().toISOString()
    };
    return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json", ...corsHeaders } });
}

async function handleTrackHistoryAPI(request, env) {
    const url = new URL(request.url);
    const username = url.searchParams.get("username"), title = url.searchParams.get("title"), artist = url.searchParams.get("artist");
    if (!username || !title || !artist) return new Response(JSON.stringify({ error: "Missing parameters" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } });

    const user = await env.DB.prepare("SELECT id FROM users WHERE LOWER(username) = LOWER(?)").bind(username).first();
    if (!user) return new Response(JSON.stringify({ error: "User not found" }), { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } });

    await logAction(env, "visit_history", `Viewed track history for @${username}: "${title}" by "${artist}"`, request);

    const allMeta = await env.DB.prepare("SELECT isrc, title, artist FROM track_metadata").all();
    const queryNormTitle = normalizeTitle(title);
    const queryCleanArtist = getPrimaryArtist(artist);

    const isrcs = (allMeta.results || [])
        .filter(r => normalizeTitle(r.title) === queryNormTitle && getPrimaryArtist(r.artist) === queryCleanArtist)
        .map(r => r.isrc).filter(Boolean);

    let sql = `
        SELECT SUM(ss.views) as views, s.timestamp
        FROM snapshot_songs ss JOIN snapshots s ON ss.snapshot_id = s.id LEFT JOIN track_metadata tm ON ss.spotify_id = tm.spotify_id
        WHERE s.user_id = ? AND (
            (LOWER(ss.title) = LOWER(?) AND LOWER(ss.artist) = LOWER(?))
            ${isrcs.length > 0 ? `OR (tm.isrc IN (${isrcs.map(() => '?').join(', ')}))` : ''}
        ) GROUP BY s.id, s.timestamp ORDER BY s.id ASC
    `;

    const { results } = await env.DB.prepare(sql).bind(user.id, title.trim(), artist.trim(), ...isrcs).all();
    return new Response(JSON.stringify({ history: results || [] }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
}

// ==========================================
// ADMIN CONTROL METHODS
// ==========================================

async function handleAdminStats(request, env) {
    const { secret } = await request.json().catch(() => ({}));
    if (secret !== IMPORT_SECRET) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } });

    const userCount = await env.DB.prepare("SELECT COUNT(*) as cnt FROM users").first();
    const snapshotCount = await env.DB.prepare("SELECT COUNT(*) as cnt FROM snapshots").first();
    const songCount = await env.DB.prepare("SELECT COUNT(DISTINCT (LOWER(TRIM(title)) || ' - ' || LOWER(TRIM(artist)))) as cnt FROM snapshot_songs").first();
    const metadataCount = await env.DB.prepare("SELECT COUNT(*) as cnt FROM track_metadata").first();
    const logCount = await env.DB.prepare("SELECT COUNT(*) as cnt FROM audit_logs").first();

    // DB size
    let dbSize = 0;
    try {
        const pcRes = await env.DB.prepare("PRAGMA page_count").first();
        const psRes = await env.DB.prepare("PRAGMA page_size").first();
        if (pcRes && psRes) {
            dbSize = (pcRes.page_count || 0) * (psRes.page_size || 0);
        }
    } catch (e) {
        console.error("Failed to query db size", e);
    }

    // Scraper health metrics
    const scraperRunRes = await env.DB.prepare("SELECT MAX(last_scraped_at) as last_run FROM users").first();
    const scraped24h = await env.DB.prepare("SELECT COUNT(*) as cnt FROM users WHERE last_scraped_at >= datetime('now', '-24 hours')").first();
    const errors24h = await env.DB.prepare("SELECT COUNT(*) as cnt FROM audit_logs WHERE action_type = 'scrape_error' AND created_at >= datetime('now', '-24 hours')").first();

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
        total_users: userCount.cnt || 0, 
        total_snapshots: snapshotCount.cnt || 0, 
        total_songs: songCount.cnt || 0,
        total_metadata: metadataCount.cnt || 0,
        total_logs: logCount.cnt || 0,
        db_size_bytes: dbSize,
        last_scraper_run: scraperRunRes ? scraperRunRes.last_run : null,
        scraped_24h: scraped24h ? scraped24h.cnt : 0,
        errors_24h: errors24h ? errors24h.cnt : 0,
        users: usersList.map(u => ({
            id: u.id, username: u.username, last_scraped_at: u.last_scraped_at || null, snap_count: u.snap_count || 0, last_updated: u.last_updated || null,
            views: u.current_views || 0, song_count: userLatestSnapMap.has(u.id) ? (songCountMap.get(userLatestSnapMap.get(u.id)) || 0) : 0
        }))
    };
    return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json", ...corsHeaders } });
}

async function handleAdminExportUser(request, env) {
    const { secret, username } = await request.json().catch(() => ({}));
    if (secret !== IMPORT_SECRET) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } });
    if (!username) return new Response(JSON.stringify({ error: "Username required" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } });

    const cleanName = username.trim().replace(/^@/, "");
    const user = await env.DB.prepare("SELECT id FROM users WHERE LOWER(username) = LOWER(?)").bind(cleanName).first();
    if (!user) return new Response(JSON.stringify({ error: "User not found" }), { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } });

    const snapshots = await env.DB.prepare("SELECT id, total_views, timestamp FROM snapshots WHERE user_id = ? ORDER BY timestamp DESC").bind(user.id).all();
    const songs = await env.DB.prepare("SELECT ss.title, ss.artist, ss.views, ss.spotify_id, ss.snapshot_id FROM snapshot_songs ss JOIN snapshots s ON ss.snapshot_id = s.id WHERE s.user_id = ? ORDER BY s.timestamp DESC").bind(user.id).all();

    const exportData = {
        username: cleanName, exported_at: new Date().toISOString(),
        history: (snapshots.results || []).map(snap => ({
            timestamp: snap.timestamp, total_views: snap.total_views,
            songs: (songs.results || []).filter(s => s.snapshot_id === snap.id).map(s => ({ title: s.title, artist: s.artist, views: s.views, spotify_id: s.spotify_id }))
        }))
    };
    return new Response(JSON.stringify(exportData, null, 2), { headers: { "Content-Type": "application/json;charset=UTF-8", ...corsHeaders } });
}

async function handleAdminScrapeUser(request, env) {
    const { secret, username } = await request.json().catch(() => ({}));
    if (secret !== IMPORT_SECRET) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } });

    const cleanName = username.trim().replace(/^@/, "");
    const user = await env.DB.prepare("SELECT id, discord_id FROM users WHERE LOWER(username) = LOWER(?)").bind(cleanName).first();
    if (!user) return new Response(JSON.stringify({ error: "User not found" }), { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } });

    try {
        await scrapeAndSave(user.id, cleanName, user.discord_id, env);
        await logAction(env, "manual_scrape", `Manual scrape triggered for: @${cleanName}`, request);
        return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
    } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }
}

async function handleAdminScrapeAll(request, env, ctx) {
    const { secret } = await request.json().catch(() => ({}));
    if (secret !== IMPORT_SECRET) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } });
    try {
        ctx.waitUntil(runScraper(env));
        await logAction(env, "global_scrape", "Global scraper run triggered", request);
        return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
    } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }
}

async function handleAdminLogs(request, env) {
    const { secret, limit = 50, offset = 0 } = await request.json().catch(() => ({}));
    if (secret !== IMPORT_SECRET) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } });
    try {
        const { results } = await env.DB.prepare("SELECT id, action_type, details, ip_address, created_at FROM audit_logs ORDER BY id DESC LIMIT ? OFFSET ?").bind(limit, offset).all();
        return new Response(JSON.stringify({ logs: results || [] }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
    } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }
}

async function handleAdminPopulateMetadata(request, env, ctx) {
    const { secret, username } = await request.json().catch(() => ({}));
    if (secret !== IMPORT_SECRET) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } });
    try {
        if (username) {
            await populateMetadataCache(env, username);
            await logAction(env, "cache_rebuild", `Rebuilt metadata cache for: @${username}`, request);
            return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
        } else {
            ctx.waitUntil(populateMetadataCache(env));
            await logAction(env, "cache_rebuild", "Rebuilt metadata cache for all creators", request);
            return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
        }
    } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }
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
                const patterns = [
                    /cdn\.discordapp\.com\/avatars\/(\d{1,21})/i,
                    /cdn\.discordapp\.com\/guilds\/\d{1,21}\/users\/(\d{1,21})/i,
                    /"userId"\s*:\s*"?(\d{1,21})"?/i,
                    /\\"userId\\":\s*\\"(\d{1,21})\\"/,
                    /"perUser"\s*:\s*\{\s*"id"\s*:\s*"?(\d{1,21})"?/i,
                    /"(?:authorId|creatorId|ownerId)"\s*:\s*"?(\d{1,21})"?/i,
                    /\/users\/(\d{1,21})\/avatars\//
                ];
                for (const pattern of patterns) {
                    const match = html.match(pattern);
                    if (match) { userId = match[1]; break; }
                }
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
                    FROM snapshot_songs ss LEFT JOIN track_metadata tm ON ss.spotify_id = tm.spotify_id WHERE ss.snapshot_id = ?
                `).bind(latestSnap.id).all();

                const uniqueSongs = aggregateSongs(snapSongs);
                await env.DB.prepare("UPDATE snapshots SET total_songs = ? WHERE id = ?").bind(uniqueSongs.length, latestSnap.id).run();
            }
        } catch (err) {}
    }
}

async function handleAdminDeleteUser(request, env) {
    const { secret, username } = await request.json().catch(() => ({}));
    if (secret !== IMPORT_SECRET) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } });
    const cleanName = username.trim().replace(/^@/, "");
    const user = await env.DB.prepare("SELECT id FROM users WHERE LOWER(username) = LOWER(?)").bind(cleanName).first();
    if (!user) return new Response(JSON.stringify({ error: "User not found" }), { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } });

    try {
        await deleteUserFromDB(user.id, env);
        await logAction(env, "user_delete", `Deleted creator: @${cleanName}`, request);
        return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
    } catch (err) { return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders }); }
}

async function handleAdminMergeUsers(request, env) {
    const { secret, sourceUsername, targetUsername } = await request.json().catch(() => ({}));
    if (secret !== IMPORT_SECRET) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: corsHeaders });

    const sourceClean = sourceUsername.trim().replace(/^@/, "");
    const targetClean = targetUsername.trim().replace(/^@/, "");
    if (sourceClean.toLowerCase() === targetClean.toLowerCase()) return new Response(JSON.stringify({ error: "Same profile" }), { status: 400, headers: corsHeaders });

    const sourceUser = await env.DB.prepare("SELECT id FROM users WHERE LOWER(username) = LOWER(?)").bind(sourceClean).first();
    const targetUser = await env.DB.prepare("SELECT id FROM users WHERE LOWER(username) = LOWER(?)").bind(targetClean).first();

    if (!sourceUser || !targetUser) return new Response(JSON.stringify({ error: "User not found" }), { status: 404, headers: corsHeaders });

    try {
        await env.DB.prepare("UPDATE snapshots SET user_id = ? WHERE user_id = ?").bind(targetUser.id, sourceUser.id).run();
        await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(sourceUser.id).run();
        await logAction(env, "profile_merge", `Merged @${sourceClean} into @${targetClean}`, request);
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders });
    } catch (err) { return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders }); }
}

// ==========================================
// UTILITY FUNCTIONS (O(1) OPTIMIZED)
// ==========================================

function parseDate(rawStr) {
    if (!rawStr) return null;
    let s = rawStr.trim();
    if (!s.endsWith('Z') && !s.includes('+') && !s.match(/-\d{2}:\d{2}$/)) s = s.replace(' ', 'T') + 'Z';
    else s = s.replace(' ', 'T');
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
}

function normalizeTitle(title) {
    if (!title) return "";
    return title.replace(REGEX_TITLE_CLEAN, '').toLowerCase().replace(REGEX_NON_ALPHANUM, '');
}

function getPrimaryArtist(artistStr) {
    if (!artistStr) return "";
    return artistStr.replace(REGEX_ARTIST_CLEAN, ', ').replace(/;/g, ',').split(',')[0].trim().toLowerCase().replace(REGEX_NON_ALPHANUM, '');
}

function aggregateSongs(rawList) {
    // Hash map to lookup existing groups in O(1) time
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

        if (isrcKey && groupsMap.has(isrcKey)) {
            foundGroup = groupsMap.get(isrcKey);
        } else if (groupsMap.has(textKey)) {
            foundGroup = groupsMap.get(textKey);
        }

        const songInfo = {
            spotify_id: s.spotify_id, title, artist, normTitle, primaryArtist, cleanArtist: artist.toLowerCase(), isrc, views: s.views || 0
        };

        if (foundGroup) {
            foundGroup.songs.push(songInfo);
            foundGroup.views += songInfo.views;
            if (title.length < foundGroup.title.length) foundGroup.title = title;
            if (artist.length < foundGroup.artist.length) foundGroup.artist = artist;

            // Link secondary keys to avoid splits
            if (isrcKey && !groupsMap.has(isrcKey)) groupsMap.set(isrcKey, foundGroup);
            if (!groupsMap.has(textKey)) groupsMap.set(textKey, foundGroup);
        } else {
            const newGroup = { songs: [songInfo], views: songInfo.views, title, artist };
            groups.push(newGroup);
            if (isrcKey) groupsMap.set(isrcKey, newGroup);
            groupsMap.set(textKey, newGroup);
        }
    }

    return groups.map(g => ({
        title: g.title, artist: g.artist, views: g.views, spotify_id: g.songs[0].spotify_id,
        isrc: g.songs.find(x => x.isrc)?.isrc || null, normTitle: g.songs[0].normTitle, primaryArtist: g.songs[0].primaryArtist
    }));
}

async function handleImport(request, env) {
    try {
        const { secret, username, history } = await request.json();
        if (secret !== IMPORT_SECRET) return new Response(JSON.stringify({ error: "Access Denied" }), { status: 401, headers: corsHeaders });

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

            const info = await env.DB.prepare("INSERT INTO snapshots (user_id, total_views, total_songs, timestamp) VALUES (?, ?, ?, ?)").bind(user.id, totalViews, totalSongsCount, timestamp).run();
            if (songs && Object.keys(songs).length > 0) {
                const stmt = env.DB.prepare("INSERT INTO snapshot_songs (snapshot_id, spotify_id, title, artist, views) VALUES (?, ?, ?, ?, ?)");
                const batch = Object.entries(songs).map(([songKey, sData]) => stmt.bind(info.meta.last_row_id || info.meta.lastInsertedRowId, songKey.length < 30 ? songKey : "", sData.title, sData.artist, sData.views));
                await env.DB.batch(batch);
            }
            snapshotCount++;
        }
        return new Response(JSON.stringify({ success: true, imported: snapshotCount }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
    } catch (err) { return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders }); }
}

async function handleExport() {
    return new Response(JSON.stringify({ error: "Exports restricted. Contact admin." }), { status: 403, headers: corsHeaders });
}

// ==========================================
// SCRAPER ENGINE
// ==========================================

async function runScraper(env) {
    // 1. Fetch based on queue (NULLS FIRST handles freshly added schema columns)
    // Batch size strictly 3 to safely fit inside 10-50ms CPU bounds
    const { results: users } = await env.DB.prepare(`
        SELECT id, username, discord_id
        FROM users
        ORDER BY last_scraped_at ASC NULLS FIRST
        LIMIT 3
    `).all();

    if (!users || users.length === 0) return;

    // 2. POISON PILL FIX: Move all fetched users to the back of the queue BEFORE processing
    // So if the worker crashes on CPU limit, the next minute it processes different users
    const userIds = users.map(u => u.id);
    const placeholders = userIds.map(() => '?').join(',');
    await env.DB.prepare(`UPDATE users SET last_scraped_at = datetime('now') WHERE id IN (${placeholders})`).bind(...userIds).run();

    // 3. Sequential Execution: Don't use Promise.all. Await each to not stack CPU time
    for (const user of users) {
        try {
            await scrapeAndSave(user.id, user.username, user.discord_id, env);
        } catch (err) {
            console.error(`Error updating @${user.username}:`, err.message);
        }
    }
}

async function deleteUserFromDB(userId, env) {
    await env.DB.batch([
        env.DB.prepare("DELETE FROM snapshot_songs WHERE snapshot_id IN (SELECT id FROM snapshots WHERE user_id = ?)").bind(userId),
        env.DB.prepare("DELETE FROM snapshots WHERE user_id = ?").bind(userId),
        env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId)
    ]);
}

async function scrapeAndSave(userId, username, discordId, env) {
    let data = null, currentUsername = username, currentDiscordId = discordId;
    try {
        data = await fetchUserDataFromAPI(currentUsername, currentDiscordId);
    } catch (err) {
        if (err.message === "USER_NOT_FOUND" || err.message === "USER_NOT_CREATOR") {
            const dbUser = await env.DB.prepare("SELECT discord_id FROM users WHERE id = ?").bind(userId).first();
            if (dbUser && dbUser.discord_id) {
                try {
                    const headers = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36" };
                    const profileRes = await fetch(`https://spicylyrics.org/api/trpc/ttml.getTTMLProfile?input=${encodeURIComponent(JSON.stringify({ json: { id: dbUser.discord_id, includeTracks: false } }))}`, { headers });
                    if (profileRes.ok) {
                        const profileJson = await profileRes.json();
                        const newUsername = profileJson.result?.data?.json?.profile?.data?.username || profileJson.result?.data?.json?.perUser?.username;
                        if (newUsername && newUsername.toLowerCase() !== currentUsername.toLowerCase()) {
                            await env.DB.prepare("UPDATE users SET username = ? WHERE id = ?").bind(newUsername, userId).run();
                            currentUsername = newUsername; currentDiscordId = dbUser.discord_id;
                            try {
                                data = await fetchUserDataFromAPI(currentUsername, currentDiscordId);
                            } catch (err2) {
                                await logAction(env, "scrape_error", `❌ Failed to scrape @${currentUsername}: ${err2.message}`, null);
                            }
                        }
                    }
                } catch (e) {
                    await logAction(env, "scrape_error", `❌ Failed to resolve updated username for @${currentUsername}: ${e.message}`, null);
                }
            }
            if (!data) {
                await logAction(env, "scrape_error", `❌ Failed to scrape @${currentUsername}: Creator not found on SpicyLyrics`, null);
                const hasSnapshots = await env.DB.prepare("SELECT 1 FROM snapshots WHERE user_id = ? LIMIT 1").bind(userId).first();
                if (!hasSnapshots) await deleteUserFromDB(userId, env);
                return;
            }
        } else {
            await logAction(env, "scrape_error", `❌ Failed to scrape @${currentUsername}: ${err.message}`, null);
        }
    }

    if (!data) return;

    if (data.total_views === 0 && (!data.songs || data.songs.length === 0)) {
        const hasSnapshots = await env.DB.prepare("SELECT 1 FROM snapshots WHERE user_id = ? LIMIT 1").bind(userId).first();
        if (!hasSnapshots) await deleteUserFromDB(userId, env);
        return;
    }

    if (!data.songs || data.songs.length === 0) return;

    if (data.tracksDetails && data.tracksDetails.length > 0) {
        const trackIds = data.tracksDetails.map(track => track ? track.id : null).filter(Boolean);
        const existingIds = new Set();
        if (trackIds.length > 0) {
            const queryBatchSize = 50;
            for (let i = 0; i < trackIds.length; i += queryBatchSize) {
                const chunk = trackIds.slice(i, i + queryBatchSize);
                const { results } = await env.DB.prepare(`SELECT spotify_id FROM track_metadata WHERE spotify_id IN (${chunk.map(()=>'?').join(',')})`).bind(...chunk).all();
                if (results) results.forEach(r => existingIds.add(r.spotify_id));
            }
        }

        const stmt = env.DB.prepare("INSERT OR IGNORE INTO track_metadata (spotify_id, isrc, title, artist) VALUES (?, ?, ?, ?)");
        const batch = [];
        for (const track of data.tracksDetails) {
            if (!track || existingIds.has(track.id)) continue;
            batch.push(stmt.bind(track.id, track.isrc || null, track.name || "Hidden", (track.artists || []).map(a => a ? a.name : "SpicyLyrics").join(", ")));
        }
        if (batch.length > 0) await env.DB.batch(batch);
    }

    const totalSongsCount = aggregateSongs(data.songs).length;

    const prevSnap = await env.DB.prepare("SELECT id, total_views FROM snapshots WHERE user_id = ? ORDER BY id DESC LIMIT 1").bind(userId).first();
    const oldViews = prevSnap ? prevSnap.total_views : 0;

    const info = await env.DB.prepare("INSERT INTO snapshots (user_id, total_views, total_songs, timestamp) VALUES (?, ?, ?, datetime('now'))").bind(userId, data.total_views, totalSongsCount).run();
    const snapshotId = info.meta.last_row_id || info.meta.lastInsertedRowId;

    if (data.songs && data.songs.length > 0) {
        const stmt = env.DB.prepare("INSERT INTO snapshot_songs (snapshot_id, spotify_id, title, artist, views) VALUES (?, ?, ?, ?, ?)");
        const batch = data.songs.map(song => stmt.bind(snapshotId, song.spotify_id, song.title, song.artist, song.views));
        await env.DB.batch(batch); // Max items per batch safe here since rows are small
    }

    // Compare with previous snapshot to find new tracks
    if (prevSnap && data.songs && data.songs.length > 0) {
        try {
            const { results: prevSongs } = await env.DB.prepare("SELECT spotify_id FROM snapshot_songs WHERE snapshot_id = ?").bind(prevSnap.id).all();
            const prevSongIds = new Set((prevSongs || []).map(r => r.spotify_id));
            
            const newSongs = data.songs.filter(s => s && s.spotify_id && !prevSongIds.has(s.spotify_id));
            for (const song of newSongs) {
                await logAction(env, "new_track", `🆕 @${currentUsername} added a new track: "${song.title}"!`, null);
            }
        } catch (e) {
            console.error("Failed to check for new tracks:", e);
        }
    }

    if (oldViews > 0 && Math.floor(data.total_views / 50000) > Math.floor(oldViews / 50000)) {
        const ms = Math.floor(data.total_views / 50000) * 50000;
        await logAction(env, "milestone_reached", `🎉 @${currentUsername} reached ${ms >= 1000000 ? ms/1000000+'M' : ms/1000+'K'} views!`, null);
    }

    if (data.discord_id) await env.DB.prepare("UPDATE users SET discord_id = ?, discord_avatar = ? WHERE id = ?").bind(data.discord_id, data.discord_avatar || null, userId).run();
}

async function fetchUserDataFromAPI(username, discordId = null) {
    const headers = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36" };
    let userId = discordId, discord_avatar = null;

    if (!userId) {
        const response = await fetch(`https://spicylyrics.org/${username}`, { headers });
        if (response.status === 404) throw new Error("USER_NOT_FOUND");
        if (!response.ok) return null;
        const html = await response.text();

        const globalMatch = html.match(/(https:\/\/cdn\.discordapp\.com\/avatars\/(\d{1,21})\/(a_[a-f0-9]{32}|[a-f0-9]{32})[^\s"']*)/i);
        if (globalMatch) { userId = globalMatch[2]; discord_avatar = globalMatch[1]; }
        else {
            const guildMatch = html.match(/(https:\/\/cdn\.discordapp\.com\/guilds\/\d{1,21}\/users\/(\d{1,21})\/avatars\/(a_[a-f0-9]{32}|[a-f0-9]{32})[^\s"']*)/i);
            if (guildMatch) { userId = guildMatch[2]; discord_avatar = guildMatch[1]; }
        }

        if (!userId) {
            const patterns = [/"?userId"?\s*:\s*"?(\d{1,21})"?/i, /\\"userId\\":\s*\\"(\d{1,21})\\"/, /"?perUser"?\s*:\s*\{\s*"?id"?\s*:\s*"?(\d{1,21})"?/i, /"?(?:authorId|creatorId|ownerId)"?\s*:\s*"?(\d{1,21})"?/i, /\/users\/(\d{1,21})\/avatars\//, /avatars\/(\d{1,21})/];
            for (const p of patterns) { const m = html.match(p); if (m) { userId = m[1]; break; } }
        }
        if (!userId) throw new Error("USER_NOT_CREATOR");
    }

    const profileRes = await fetch(`https://spicylyrics.org/api/trpc/ttml.getTTMLProfile?input=${encodeURIComponent(JSON.stringify({ json: { id: userId, includeTracks: true } }))}`, { headers });
    if (!profileRes.ok) return null;
    const profileJson = await profileRes.json();

    const perUser = profileJson.result?.data?.json?.perUser;
    const profile = profileJson.result?.data?.json?.profile;
    if (!perUser && !profile) throw new Error("USER_NOT_FOUND");
    if (!discord_avatar) discord_avatar = profile?.data?.avatar || perUser?.avatar || null;

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
        total_views += (item.view_count || 0);
        const detail = tracksMap.get(item.id);
        if (detail) songs.push({ spotify_id: item.id, title: detail.title, artist: detail.artist, isrc: detail.isrc, views: item.view_count || 0 });
    }

    return { total_views, songs, tracksDetails, discord_id: userId, discord_avatar };
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
        return new Response(JSON.stringify({ events: results || [] }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
    } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }
}

async function handleAdminSearchMetadata(request, env) {
    const { secret, query } = await request.json().catch(() => ({}));
    if (secret !== IMPORT_SECRET) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } });
    
    try {
        const searchQuery = `%${(query || "").trim()}%`;
        const { results } = await env.DB.prepare(`
            SELECT spotify_id, title, artist, isrc, created_at 
            FROM track_metadata 
            WHERE title LIKE ? OR artist LIKE ? OR isrc LIKE ? OR spotify_id LIKE ? 
            LIMIT 50
        `).bind(searchQuery, searchQuery, searchQuery, searchQuery).all();
        
        return new Response(JSON.stringify({ results: results || [] }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
    } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }
}

async function handleAdminUpdateMetadata(request, env) {
    const { secret, spotify_id, title, artist, isrc } = await request.json().catch(() => ({}));
    if (secret !== IMPORT_SECRET) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } });
    if (!spotify_id) return new Response(JSON.stringify({ error: "Spotify ID required" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } });
    
    try {
        const cleanTitle = (title || "").trim();
        const cleanArtist = (artist || "").trim();
        const cleanIsrc = isrc ? isrc.trim() : null;
        
        await env.DB.prepare("UPDATE track_metadata SET title = ?, artist = ?, isrc = ? WHERE spotify_id = ?")
            .bind(cleanTitle, cleanArtist, cleanIsrc, spotify_id)
            .run();
            
        await logAction(env, "metadata_update", `Updated metadata for Spotify ID ${spotify_id}: "${cleanTitle}" by "${cleanArtist}" (ISRC: ${cleanIsrc || "none"})`, request);
        
        return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
    } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }
}
