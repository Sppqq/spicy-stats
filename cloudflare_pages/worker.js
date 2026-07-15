const IMPORT_SECRET = "Spicy_Admin_#7f8c9b2d4e1a0673f8b9d07c01a2f3e4";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Access-Control-Allow-Headers": "Content-Type",
};

// In-memory rate limiting (Rate Limiting)
const rateLimitMap = new Map();

function isRateLimited(ip, limit, windowMs) {
    const now = Date.now();
    
    // Self-cleaning of the map from old entries when size is exceeded
    if (rateLimitMap.size > 10000) {
        for (const [key, timestamps] of rateLimitMap.entries()) {
            const active = timestamps.filter(ts => now - ts < windowMs);
            if (active.length === 0) {
                rateLimitMap.delete(key);
            } else {
                rateLimitMap.set(key, active);
            }
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
        await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_snapshot_songs_snapshot_id ON snapshot_songs(snapshot_id)").run().catch(() => {});
        
        // Track Metadata Cache Table
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

        // Add total_songs column to snapshots table
        await env.DB.prepare("ALTER TABLE snapshots ADD COLUMN total_songs INTEGER").run().catch(() => {});

        // Audit Logs Table
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
        // Ignore
    }
}

const allowedOrigins = [
    "https://spicy-stats.glyph-labs.site",
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
    if (request) {
        ipAddress = request.headers.get("CF-Connecting-IP") || request.headers.get("x-real-ip") || "Unknown IP";
    }
    try {
        await env.DB.prepare("INSERT INTO audit_logs (action_type, details, ip_address) VALUES (?, ?, ?)")
            .bind(actionType, details, ipAddress)
            .run();
    } catch (err) {
        console.error("Failed to write audit log:", err);
    }
}

function verifySignature(request, path) {
    const timestampStr = request.headers.get("X-Spicy-Timestamp");
    const signature = request.headers.get("X-Spicy-Signature");
    
    if (!timestampStr || !signature) return false;
    
    const timestamp = parseInt(timestampStr, 10);
    if (isNaN(timestamp)) return false;
    
    const now = Math.floor(Date.now() / 1000);
    // Allow up to 90 seconds clock drift
    if (Math.abs(now - timestamp) > 90) return false;
    
    const expected = generateSignature(path, timestampStr);
    return signature === expected;
}

function generateSignature(path, timestamp) {
    const salt = "SpicyLyrics_API_Secured_2026_GlyphLabs";
    const str = `${timestamp}:${path}:${salt}`;
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash) + str.charCodeAt(i);
    }
    return (hash >>> 0).toString(16);
}

export default {
    async fetch(request, env, ctx) {
        ctx.waitUntil(checkSchema(env));
        const url = new URL(request.url);

        // Handle CORS preflight
        if (request.method === "OPTIONS") {
            return new Response(null, { 
                headers: {
                    ...getCorsHeaders(request),
                    "Access-Control-Allow-Headers": request.headers.get("Access-Control-Request-Headers") || "Content-Type, X-Spicy-Signature, X-Spicy-Timestamp"
                }
            });
        }

        // Verify API Request Signatures for public API endpoints
        // Exclude export, import, options
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

        // Protection against spam and scraping (Rate Limiting)
        const ip = request.headers.get("CF-Connecting-IP") || "anonymous";
        if (url.pathname === "/api/add-user" && request.method === "POST") {
            if (isRateLimited(ip, 5, 60000)) { // 5 requests per minute for adding users
                return new Response(JSON.stringify({ error: "Too many requests. Please try again later." }), { 
                    status: 429, 
                    headers: { "Content-Type": "application/json", ...getCorsHeaders(request) } 
                });
            }
        } else if (url.pathname.startsWith("/api/")) {
            if (isRateLimited(ip, 60, 60000)) { // 60 requests per minute for other endpoints
                return new Response(JSON.stringify({ error: "Too many requests. Please try again later." }), { 
                    status: 429, 
                    headers: { "Content-Type": "application/json", ...getCorsHeaders(request) } 
                });
            }
        }

        let response;
        try {
            if (url.pathname === "/api/import" && request.method === "POST") {
                response = await handleImport(request, env);
            } else if (url.pathname.startsWith("/api/export/")) {
                const username = url.pathname.split("/")[3];
                response = await handleExport(username, env);
            } else if (url.pathname === "/api/add-user" && request.method === "POST") {
                response = await handleAddUser(request, env, ctx);
            } else if (url.pathname === "/api/dashboard" && request.method === "GET") {
                response = await handleDashboardAPI(request, env);
            } else if (url.pathname === "/api/track-history" && request.method === "GET") {
                response = await handleTrackHistoryAPI(request, env);
            } else if (url.pathname.startsWith("/api/user/") && request.method === "GET") {
                const username = url.pathname.split("/")[3];
                response = await handleUserDetailAPI(username, request, env);
            } else if (url.pathname === "/api/admin/stats" && request.method === "POST") {
                response = await handleAdminStats(request, env);
            } else if (url.pathname === "/api/admin/scrape-user" && request.method === "POST") {
                response = await handleAdminScrapeUser(request, env);
            } else if (url.pathname === "/api/admin/scrape-all" && request.method === "POST") {
                response = await handleAdminScrapeAll(request, env, ctx);
            } else if (url.pathname === "/api/admin/populate-metadata" && request.method === "POST") {
                response = await handleAdminPopulateMetadata(request, env, ctx);
            } else if (url.pathname === "/api/admin/logs" && request.method === "POST") {
                response = await handleAdminLogs(request, env);
            } else if (url.pathname === "/api/admin/merge-users" && request.method === "POST") {
                response = await handleAdminMergeUsers(request, env);
            } else if (url.pathname === "/api/admin/delete-user" && request.method === "POST") {
                response = await handleAdminDeleteUser(request, env);
            } else if (url.pathname === "/api/admin/export-user" && request.method === "POST") {
                response = await handleAdminExportUser(request, env);
            } else {
                response = new Response(JSON.stringify({ error: "API Endpoint Not Found" }), { status: 404, headers: { "Content-Type": "application/json" } });
            }
        } catch (err) {
            response = new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Content-Type": "application/json" } });
        }

        // Add dynamic CORS headers to all responses
        const finalHeaders = new Headers(response.headers);
        const cors = getCorsHeaders(request);
        for (const [key, val] of Object.entries(cors)) {
            finalHeaders.set(key, val);
        }
        
        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: finalHeaders
        });
    },

    async scheduled(event, env, ctx) {
        const run = async () => {
            try {
                await checkSchema(env);
                await runScraper(env);
            } catch (err) {
                console.error("Cron scraper error:", err.message, err.stack);
            }
        };

        if (ctx && typeof ctx.waitUntil === "function") {
            ctx.waitUntil(run());
        } else if (event && typeof event.waitUntil === "function") {
            event.waitUntil(run());
        } else {
            await run();
        }
    }
};

// ==========================================
// CORE API METHODS (JSON)
// ==========================================

async function handleAddUser(request, env, ctx) {
    const { username } = await request.json();
    if (!username || typeof username !== "string") {
        return new Response(JSON.stringify({ error: "Please enter a valid username." }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    const cleanName = username.trim().replace(/^@/, "");
    if (cleanName.length === 0 || cleanName.length > 50 || !/^[a-zA-Z0-9_\.\-]+$/.test(cleanName)) {
        return new Response(JSON.stringify({ error: "Invalid username format. Only alphanumeric characters, dots, hyphens, and underscores are allowed (up to 50 characters)." }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    await env.DB.prepare("INSERT INTO users (username) VALUES (?) ON CONFLICT(username) DO NOTHING")
        .bind(cleanName)
        .run();

    await logAction(env, "user_add", `Added new creator: @${cleanName}`, request);

    ctx.waitUntil(scrapeSingleUser(cleanName, env));

    return new Response(JSON.stringify({ success: true, cleanName }), {
        headers: { "Content-Type": "application/json", ...corsHeaders }
    });
}

async function handleDashboardAPI(request, env) {
    const globalQuery = await env.DB.prepare("SELECT COUNT(id) as total_users FROM users").first();

    await logAction(env, "visit_dashboard", "Loaded main dashboard", request);

    const totalViewsQuery = await env.DB.prepare(`
    SELECT SUM(total_views) as global_views FROM (
      SELECT total_views FROM snapshots s1
      WHERE id = (SELECT id FROM snapshots s2 WHERE s2.user_id = s1.user_id ORDER BY id DESC LIMIT 1)
    )
  `).first();

    const { results: users } = await env.DB.prepare(`
    WITH latest_snapshots AS (
        SELECT user_id, id AS latest_id, timestamp AS latest_timestamp, total_views AS latest_views, total_songs AS latest_total_songs
        FROM snapshots s1
        WHERE id = (SELECT id FROM snapshots s2 WHERE s2.user_id = s1.user_id ORDER BY id DESC LIMIT 1)
    )
    SELECT 
        u.username, 
        ls.latest_views AS current_views, 
        ls.latest_timestamp AS last_updated, 
        s_past.total_views AS past_views,
        (SELECT timestamp FROM snapshots WHERE user_id = u.id ORDER BY id ASC LIMIT 1) AS first_snapshot,
        s_past_7d.id AS past_7d_id,
        COALESCE(ls.latest_total_songs, (SELECT COUNT(DISTINCT LOWER(COALESCE(NULLIF(TRIM(title), ''), 'Hidden')) || '|||' || LOWER(COALESCE(NULLIF(TRIM(artist), ''), 'SpicyLyrics'))) FROM snapshot_songs WHERE snapshot_id = ls.latest_id), 0) AS total_songs,
        COALESCE(s_past_7d.total_songs, (SELECT COUNT(DISTINCT LOWER(COALESCE(NULLIF(TRIM(title), ''), 'Hidden')) || '|||' || LOWER(COALESCE(NULLIF(TRIM(artist), ''), 'SpicyLyrics'))) FROM snapshot_songs WHERE snapshot_id = s_past_7d.id), 0) AS total_songs_7d
    FROM users u 
    LEFT JOIN latest_snapshots ls ON ls.user_id = u.id
    LEFT JOIN snapshots s_past ON s_past.id = (
        SELECT id FROM snapshots s_past_in
        WHERE s_past_in.user_id = u.id 
          AND s_past_in.timestamp >= datetime((SELECT timestamp FROM snapshots WHERE user_id = s_past_in.user_id ORDER BY id DESC LIMIT 1), '-30 hours') 
          AND s_past_in.timestamp <= datetime((SELECT timestamp FROM snapshots WHERE user_id = s_past_in.user_id ORDER BY id DESC LIMIT 1), '-18 hours') 
        ORDER BY ABS(strftime('%s', s_past_in.timestamp) - strftime('%s', datetime((SELECT timestamp FROM snapshots WHERE user_id = s_past_in.user_id ORDER BY id DESC LIMIT 1), '-24 hours'))) ASC 
        LIMIT 1
    )
    LEFT JOIN snapshots s_past_7d ON s_past_7d.id = (
        SELECT id FROM snapshots s_7d_in
        WHERE s_7d_in.user_id = u.id 
          AND s_7d_in.timestamp >= datetime((SELECT timestamp FROM snapshots WHERE user_id = s_7d_in.user_id ORDER BY id DESC LIMIT 1), '-8.5 days') 
          AND s_7d_in.timestamp <= datetime((SELECT timestamp FROM snapshots WHERE user_id = s_7d_in.user_id ORDER BY id DESC LIMIT 1), '-5.5 days') 
        ORDER BY ABS(strftime('%s', s_7d_in.timestamp) - strftime('%s', datetime((SELECT timestamp FROM snapshots WHERE user_id = s_7d_in.user_id ORDER BY id DESC LIMIT 1), '-7 days'))) ASC 
        LIMIT 1
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
    const firstSnapshotTimestamp = firstSnapshot ? firstSnapshot.timestamp : null;

    const { results: history } = await env.DB.prepare("SELECT id, total_views, timestamp FROM snapshots WHERE user_id = ? ORDER BY id DESC LIMIT 100").bind(user.id).all();

    let totalViews = 0, growth24h = null, totalSongs = 0;
    let topTracks = [], chartDataRaw = [], finalSongs = [];

    if (history && history.length > 0) {
        let latestSnapshot = null;
        let latestRaw = [];

        for (const snap of history) {
            const { results: songs } = await env.DB.prepare(`
                SELECT ss.spotify_id, ss.views, ss.title, ss.artist, tm.isrc, tm.title as meta_title, tm.artist as meta_artist
                FROM snapshot_songs ss
                LEFT JOIN track_metadata tm ON ss.spotify_id = tm.spotify_id
                WHERE ss.snapshot_id = ?
            `).bind(snap.id).all();
            if (songs && songs.length > 0) {
                latestSnapshot = snap;
                latestRaw = songs;
                break;
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
                FROM snapshot_songs ss
                LEFT JOIN track_metadata tm ON ss.spotify_id = tm.spotify_id
                WHERE ss.snapshot_id = ?
            `).bind(pastSnapshot.id).all();
            if (results) pastRaw = results;
        }

        const latestSongs = aggregateSongs(latestRaw);
        const pastSongs = aggregateSongs(pastRaw);
        totalSongs = latestSongs.length;

        const findPastViews = (ls, pastSongsList) => {
            const lsNormTitle = normalizeTitle(ls.title);
            const lsArtist = ls.artist.trim().toLowerCase();
            const lsIsrc = ls.isrc ? ls.isrc.trim() : null;
            
            for (const ps of pastSongsList) {
                const psIsrc = ps.isrc ? ps.isrc.trim() : null;
                if (lsIsrc && psIsrc && lsIsrc === psIsrc) {
                    return ps.views;
                }
                if (lsNormTitle === normalizeTitle(ps.title) && lsArtist === ps.artist.trim().toLowerCase()) {
                    return ps.views;
                }
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

    const data = {
        username: user.username,
        discord_id: user.discord_id || null,
        discord_avatar: user.discord_avatar || null,
        total_views: totalViews,
        growth24h,
        first_snapshot: firstSnapshotTimestamp,
        total_songs: totalSongs,
        highlights: topTracks,
        chart_data: chartDataRaw,
        songs: finalSongs
    };

    return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json", ...corsHeaders } });
}

async function handleTrackHistoryAPI(request, env) {
    const url = new URL(request.url);
    const username = url.searchParams.get("username");
    const title = url.searchParams.get("title");
    const artist = url.searchParams.get("artist");

    if (!username || !title || !artist) {
        return new Response(JSON.stringify({ error: "Missing parameters" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    const user = await env.DB.prepare("SELECT id FROM users WHERE LOWER(username) = LOWER(?)").bind(username).first();
    if (!user) {
        return new Response(JSON.stringify({ error: "User not found" }), { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    await logAction(env, "visit_history", `Viewed track history for @${user.username || username}: "${title}" by "${artist}"`, request);

    // 1. Find any ISRCs for this track in track_metadata using normalized matching
    const allMeta = await env.DB.prepare("SELECT isrc, title, artist FROM track_metadata").all();
    const queryNormTitle = normalizeTitle(title);
    const queryCleanArtist = artist.toLowerCase();
    
    const isrcs = (allMeta.results || [])
        .filter(r => normalizeTitle(r.title) === queryNormTitle && r.artist.toLowerCase() === queryCleanArtist)
        .map(r => r.isrc)
        .filter(Boolean);

    // 2. Query history matching either Title+Artist or ISRC
    let sql = `
        SELECT SUM(ss.views) as views, s.timestamp
        FROM snapshot_songs ss
        JOIN snapshots s ON ss.snapshot_id = s.id
        LEFT JOIN track_metadata tm ON ss.spotify_id = tm.spotify_id
        WHERE s.user_id = ? 
          AND (
            (LOWER(ss.title) = LOWER(?) AND LOWER(ss.artist) = LOWER(?))
            ${isrcs.length > 0 ? `OR (tm.isrc IN (${isrcs.map(() => '?').join(', ')}))` : ''}
          )
        GROUP BY s.id, s.timestamp
        ORDER BY s.id ASC
    `;

    const bindParams = [user.id, title.trim(), artist.trim(), ...isrcs];
    const { results } = await env.DB.prepare(sql).bind(...bindParams).all();

    return new Response(JSON.stringify({ history: results || [] }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
}

// ==========================================
// ADMIN CONTROL METHODS (JSON)
// ==========================================

async function handleAdminStats(request, env) {
    const { secret } = await request.json().catch(() => ({}));
    if (secret !== IMPORT_SECRET) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    const userCount = await env.DB.prepare("SELECT COUNT(*) as cnt FROM users").first();
    const snapshotCount = await env.DB.prepare("SELECT COUNT(*) as cnt FROM snapshots").first();
    const songCount = await env.DB.prepare("SELECT COUNT(DISTINCT (LOWER(TRIM(title)) || ' - ' || LOWER(TRIM(artist)))) as cnt FROM snapshot_songs").first();
    
    const { results: usersList } = await env.DB.prepare(`
        SELECT u.id, u.username, 
               (SELECT COUNT(*) FROM snapshots WHERE user_id = u.id) as snap_count,
               (SELECT MAX(timestamp) FROM snapshots WHERE user_id = u.id) as last_updated,
               (SELECT total_views FROM snapshots WHERE user_id = u.id ORDER BY id DESC LIMIT 1) as current_views
        FROM users u
        ORDER BY current_views DESC
    `).all();

    // Fetch the song counts for the latest snapshot of each user in ONE query to avoid full table scans
    // Aggregate by title and artist to exactly match dashboard and profile counts, falling back to older method if total_songs is null
    const { results: songCounts } = await env.DB.prepare(`
        SELECT id as snapshot_id, COALESCE(total_songs, (SELECT COUNT(DISTINCT (LOWER(TRIM(title)) || ' - ' || LOWER(TRIM(artist)))) FROM snapshot_songs WHERE snapshot_id = s.id)) as cnt
        FROM snapshots s
        WHERE id IN (
            SELECT MAX(id) FROM snapshots GROUP BY user_id
        )
    `).all();

    const songCountMap = new Map();
    (songCounts || []).forEach(row => {
        songCountMap.set(row.snapshot_id, row.cnt);
    });

    const { results: latestSnaps } = await env.DB.prepare(`
        SELECT user_id, MAX(id) as latest_snap_id FROM snapshots GROUP BY user_id
    `).all();
    const userLatestSnapMap = new Map();
    (latestSnaps || []).forEach(row => {
        userLatestSnapMap.set(row.user_id, row.latest_snap_id);
    });

    const data = {
        total_users: userCount.cnt || 0,
        total_snapshots: snapshotCount.cnt || 0,
        total_songs: songCount.cnt || 0,
        users: usersList.map(u => {
            const latestSnapId = userLatestSnapMap.get(u.id);
            const songCountVal = latestSnapId ? (songCountMap.get(latestSnapId) || 0) : 0;
            return {
                id: u.id,
                username: u.username,
                snap_count: u.snap_count || 0,
                last_updated: u.last_updated || null,
                views: u.current_views || 0,
                song_count: songCountVal
            };
        })
    };

    return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json", ...corsHeaders } });
}

async function handleAdminExportUser(request, env) {
    const { secret, username } = await request.json().catch(() => ({}));
    if (secret !== IMPORT_SECRET) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }
    if (!username) {
        return new Response(JSON.stringify({ error: "Username is required" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    const cleanName = username.trim().replace(/^@/, "");
    const user = await env.DB.prepare("SELECT id FROM users WHERE LOWER(username) = LOWER(?)").bind(cleanName).first();
    if (!user) return new Response(JSON.stringify({ error: "User not found" }), { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } });

    const snapshots = await env.DB.prepare("SELECT id, total_views, timestamp FROM snapshots WHERE user_id = ? ORDER BY timestamp DESC").bind(user.id).all();
    const songs = await env.DB.prepare(`
        SELECT ss.title, ss.artist, ss.views, ss.spotify_id, ss.snapshot_id
        FROM snapshot_songs ss JOIN snapshots s ON ss.snapshot_id = s.id
        WHERE s.user_id = ? ORDER BY s.timestamp DESC
    `).bind(user.id).all();

    const exportData = {
        username: cleanName,
        exported_at: new Date().toISOString(),
        history: (snapshots.results || []).map(snap => ({
            timestamp: snap.timestamp,
            total_views: snap.total_views,
            songs: (songs.results || []).filter(s => s.snapshot_id === snap.id).map(s => ({ title: s.title, artist: s.artist, views: s.views, spotify_id: s.spotify_id }))
        }))
    };

    return new Response(JSON.stringify(exportData, null, 2), {
        headers: { "Content-Type": "application/json;charset=UTF-8", ...corsHeaders }
    });
}

async function handleAdminScrapeUser(request, env) {
    const { secret, username } = await request.json().catch(() => ({}));
    if (secret !== IMPORT_SECRET) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }
    if (!username) {
        return new Response(JSON.stringify({ error: "Username is required" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    const cleanName = username.trim().replace(/^@/, "");
    const user = await env.DB.prepare("SELECT id, discord_id FROM users WHERE LOWER(username) = LOWER(?)").bind(cleanName).first();
    if (!user) {
        return new Response(JSON.stringify({ error: "User not found in database" }), { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    try {
        await scrapeAndSave(user.id, cleanName, user.discord_id, env);
        await logAction(env, "manual_scrape", `Manual scrape triggered for: @${cleanName}`, request);
        return new Response(JSON.stringify({ success: true, message: `Successfully scraped @${cleanName}` }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
    } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }
}

async function handleAdminScrapeAll(request, env, ctx) {
    const { secret } = await request.json().catch(() => ({}));
    if (secret !== IMPORT_SECRET) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    try {
        ctx.waitUntil(runScraper(env));
        await logAction(env, "global_scrape", "Global scraper queue run triggered", request);
        return new Response(JSON.stringify({ success: true, message: "Scraper run triggered in background" }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
    } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }
}

async function handleAdminLogs(request, env) {
    const { secret, limit = 50, offset = 0 } = await request.json().catch(() => ({}));
    if (secret !== IMPORT_SECRET) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    try {
        const { results } = await env.DB.prepare("SELECT id, action_type, details, ip_address, created_at FROM audit_logs ORDER BY id DESC LIMIT ? OFFSET ?")
            .bind(limit, offset)
            .all();
        return new Response(JSON.stringify({ logs: results || [] }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
    } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }
}

async function handleAdminPopulateMetadata(request, env, ctx) {
    const { secret, username } = await request.json().catch(() => ({}));
    if (secret !== IMPORT_SECRET) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    try {
        if (username) {
            // Process single user synchronously for the client-side loop
            await populateMetadataCache(env, username);
            await logAction(env, "cache_rebuild", `Rebuilt metadata cache for: @${username}`, request);
            return new Response(JSON.stringify({ success: true, message: `Successfully populated metadata for @${username}` }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
        } else {
            // Fallback: run in background for all users
            ctx.waitUntil(populateMetadataCache(env));
            await logAction(env, "cache_rebuild", "Rebuilt metadata cache for all creators", request);
            return new Response(JSON.stringify({ success: true, message: "Metadata cache population started in background" }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
        }
    } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }
}

async function populateMetadataCache(env, targetUsername = null) {
    let query = "SELECT id, username, discord_id FROM users";
    let bindParams = [];
    if (targetUsername) {
        query += " WHERE LOWER(username) = LOWER(?)";
        bindParams.push(targetUsername);
    }
    const { results: users } = await env.DB.prepare(query).bind(...bindParams).all();
    const headers = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" };
    
    for (const user of users) {
        try {
            let userId = user.discord_id;
            if (!userId) {
                const pageUrl = `https://spicylyrics.org/${user.username}`;
                const response = await fetch(pageUrl, { headers });
                if (!response.ok) continue;
                const html = await response.text();
                const globalMatch = html.match(/cdn\.discordapp\.com\/avatars\/(\d{1,21})/i);
                if (globalMatch) userId = globalMatch[1];
                if (!userId) {
                    const guildMatch = html.match(/cdn\.discordapp\.com\/guilds\/\d{1,21}\/users\/(\d{1,21})/i);
                    if (guildMatch) userId = guildMatch[1];
                }
                if (!userId) {
                    const patterns = [
                        /"userId"\s*:\s*"?(\d{1,21})"?/i,
                        /\\"userId\\":\s*\\"(\d{1,21})\\"/,
                        /"perUser"\s*:\s*\{\s*"id"\s*:\s*"?(\d{1,21})"?/i,
                        /"(?:authorId|creatorId|ownerId)"\s*:\s*"?(\d{1,21})"?/i,
                        /\/users\/(\d{1,21})\/avatars\//,
                        /avatars\/(\d{1,21})/
                    ];
                    for (const pattern of patterns) {
                        const match = html.match(pattern);
                        if (match) { userId = match[1]; break; }
                    }
                }
            }
            
            if (!userId) continue;
            
            const tracksRes = await fetch(`https://spicylyrics.org/api/trpc/ttml.getTTMLProfileTracks?input=${encodeURIComponent(JSON.stringify({ json: { id: userId } }))}`, { headers });
            if (!tracksRes.ok) continue;
            const tracksJson = await tracksRes.json();
            const tracksDetails = tracksJson.result?.data?.json?.data || [];
            
            if (tracksDetails.length > 0) {
                const stmt = env.DB.prepare("INSERT OR REPLACE INTO track_metadata (spotify_id, isrc, title, artist) VALUES (?, ?, ?, ?)");
                const batch = tracksDetails.map(track => {
                    if (!track) return null;
                    const artistNames = (track.artists || []).map(a => a ? a.name : "SpicyLyrics").join(", ");
                    return stmt.bind(track.id, track.isrc || null, track.name || "Hidden", artistNames);
                }).filter(Boolean);
                if (batch.length > 0) {
                    await env.DB.batch(batch);
                }
            }
            
            const latestSnap = await env.DB.prepare("SELECT id FROM snapshots WHERE user_id = ? ORDER BY id DESC LIMIT 1").bind(user.id).first();
            if (latestSnap) {
                const { results: snapSongs } = await env.DB.prepare(`
                    SELECT ss.spotify_id, ss.views, ss.title, ss.artist, tm.isrc, tm.title as meta_title, tm.artist as meta_artist
                    FROM snapshot_songs ss
                    LEFT JOIN track_metadata tm ON ss.spotify_id = tm.spotify_id
                    WHERE ss.snapshot_id = ?
                `).bind(latestSnap.id).all();
                
                const uniqueSongs = aggregateSongs(snapSongs);
                await env.DB.prepare("UPDATE snapshots SET total_songs = ? WHERE id = ?").bind(uniqueSongs.length, latestSnap.id).run();
            }
        } catch (err) {
            console.error(`Error populating metadata for ${user.username}:`, err.message);
        }
    }
}

async function handleAdminDeleteUser(request, env) {
    const { secret, username } = await request.json().catch(() => ({}));
    if (secret !== IMPORT_SECRET) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }
    if (!username) {
        return new Response(JSON.stringify({ error: "Username is required" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    const cleanName = username.trim().replace(/^@/, "");
    const user = await env.DB.prepare("SELECT id FROM users WHERE LOWER(username) = LOWER(?)").bind(cleanName).first();
    if (!user) {
        return new Response(JSON.stringify({ error: "User not found in database" }), { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    try {
        await deleteUserFromDB(user.id, env);
        await logAction(env, "user_delete", `Deleted creator: @${cleanName}`, request);
        return new Response(JSON.stringify({ success: true, message: `Successfully deleted @${cleanName}` }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
    } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }
}

async function handleAdminMergeUsers(request, env) {
    const { secret, sourceUsername, targetUsername } = await request.json().catch(() => ({}));
    if (secret !== IMPORT_SECRET) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    if (!sourceUsername || !targetUsername) {
        return new Response(JSON.stringify({ error: "Both source and target usernames are required" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    const sourceClean = sourceUsername.trim().replace(/^@/, "");
    const targetClean = targetUsername.trim().replace(/^@/, "");

    if (sourceClean.toLowerCase() === targetClean.toLowerCase()) {
        return new Response(JSON.stringify({ error: "Cannot merge a profile into itself" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    const sourceUser = await env.DB.prepare("SELECT id FROM users WHERE LOWER(username) = LOWER(?)").bind(sourceClean).first();
    const targetUser = await env.DB.prepare("SELECT id FROM users WHERE LOWER(username) = LOWER(?)").bind(targetClean).first();

    if (!sourceUser) {
        return new Response(JSON.stringify({ error: `Source user @${sourceClean} not found` }), { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }
    if (!targetUser) {
        return new Response(JSON.stringify({ error: `Target user @${targetClean} not found` }), { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    try {
        // Move snapshots
        await env.DB.prepare("UPDATE snapshots SET user_id = ? WHERE user_id = ?").bind(targetUser.id, sourceUser.id).run();
        
        // Delete source user
        await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(sourceUser.id).run();

        await logAction(env, "profile_merge", `Merged profile @${sourceClean} into @${targetClean}`, request);

        return new Response(JSON.stringify({ success: true, message: `Successfully merged @${sourceClean} into @${targetClean}` }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
    } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }
}

// ==========================================
// UTILITY FUNCTIONS (UNCHANGED, WITH CORS ADDED)
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
    return title
        // Ignored case (/gi) and cut out remasters, deluxes, edits and lives
        // Leave "single version" untouched (singles are not merged)
        // Added \s* after the separator to match spaces after dashes/parentheses
        // Put longer words (remastered) before shorter ones (remaster) to avoid partial matching
        .replace(/\s*[-\(]\s*(?:20\d{2}\s+)?(?:remastered|remaster|deluxe|edit|radio edit|live|acoustic)[\)]?/gi, '')
        .toLowerCase()
        .replace(/[^a-z0-9а-яё]/g, '');
}

function getPrimaryArtist(artistStr) {
    if (!artistStr) return "";
    const primary = artistStr
        .replace(/\s+(?:feat\.?|ft\.?|&|and)\s+/gi, ', ')
        .replace(/;/g, ',')
        .split(',')[0]
        .trim()
        .toLowerCase();
    return primary.replace(/[^a-z0-9а-яё]/g, '');
}

function aggregateSongs(rawList) {
    const groups = [];
    for (const s of rawList || []) {
        const title = (s.meta_title || s.title || "Hidden").trim();
        const artist = (s.meta_artist || s.artist || "SpicyLyrics").trim();
        const normTitle = normalizeTitle(title);
        const cleanArtist = artist.toLowerCase();
        const isrc = s.isrc ? s.isrc.trim() : null;
        
        let foundGroup = null;
        for (const g of groups) {
            let match = false;
            for (const member of g.songs) {
                if (isrc && member.isrc && isrc === member.isrc) {
                    match = true;
                    break;
                }
                if (normTitle === member.normTitle && getPrimaryArtist(artist) === getPrimaryArtist(member.artist)) {
                    match = true;
                    break;
                }
            }
            if (match) {
                foundGroup = g;
                break;
            }
        }
        
        const songInfo = {
            spotify_id: s.spotify_id,
            title,
            artist,
            normTitle,
            cleanArtist,
            isrc,
            views: s.views || 0
        };
        
        if (foundGroup) {
            foundGroup.songs.push(songInfo);
            foundGroup.views += songInfo.views;
            // Use the shortest title as representative of the group (e.g. "тело" instead of "тело - Slowed")
            if (title.length < foundGroup.title.length) {
                foundGroup.title = title;
            }
            // Use the shortest artist list as representative of the group (e.g. "tuborosho" instead of "tuborosho, DJ EMBER")
            if (artist.length < foundGroup.artist.length) {
                foundGroup.artist = artist;
            }
        } else {
            groups.push({
                songs: [songInfo],
                views: songInfo.views,
                title: songInfo.title,
                artist: songInfo.artist
            });
        }
    }
    
    return groups.map(g => ({
        title: g.title,
        artist: g.artist,
        views: g.views,
        spotify_id: g.songs[0].spotify_id,
        isrc: g.songs.find(x => x.isrc)?.isrc || null
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
                const rawList = Object.entries(songs).map(([songKey, sData]) => ({
                    spotify_id: songKey.length < 30 ? songKey : "",
                    title: sData.title,
                    artist: sData.artist,
                    views: sData.views || 0,
                    isrc: null
                }));
                const uniqueSongs = aggregateSongs(rawList);
                totalSongsCount = uniqueSongs.length;
            }

            const info = await env.DB.prepare("INSERT INTO snapshots (user_id, total_views, total_songs, timestamp) VALUES (?, ?, ?, ?)").bind(user.id, totalViews, totalSongsCount, timestamp).run();
            const snapshotId = info.meta.last_row_id || info.meta.lastInsertedRowId;

            if (songs && Object.keys(songs).length > 0) {
                const stmt = env.DB.prepare("INSERT INTO snapshot_songs (snapshot_id, spotify_id, title, artist, views) VALUES (?, ?, ?, ?, ?)");
                const batch = Object.entries(songs).map(([songKey, sData]) => stmt.bind(snapshotId, songKey.length < 30 ? songKey : "", sData.title, sData.artist, sData.views));
                await env.DB.batch(batch);
            }
            snapshotCount++;
        }
        await logAction(env, "history_import", `Imported ${snapshotCount} history snapshots for @${cleanName}`, request);
        return new Response(JSON.stringify({ success: true, imported: snapshotCount }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
    } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }
}

async function handleExport(username, env) {
    return new Response(JSON.stringify({
        error: "JSON exports are currently restricted to prevent database scraping and server overload. If you require a full JSON dump of this creator's history, please request it directly via Discord @sppq or Telegram @lellyn. Sorry for the inconvenience!"
    }), {
        status: 403,
        headers: { "Content-Type": "application/json;charset=UTF-8", ...corsHeaders }
    });
}

// Scraper & parser functions
// remain IDENTICAL to your original file.
async function runScraper(env) {
    const { results: users } = await env.DB.prepare(`
    SELECT u.id, u.username, u.discord_id, s_latest.id AS latest_snap_id
    FROM users u
    LEFT JOIN snapshots s_latest ON s_latest.id = (
        SELECT id FROM snapshots WHERE user_id = u.id ORDER BY id DESC LIMIT 1
    )
    ORDER BY latest_snap_id ASC
    LIMIT 4
  `).all();

    if (!users || users.length === 0) return;

    const batchSize = 2;
    for (let i = 0; i < users.length; i += batchSize) {
        const batch = users.slice(i, i + batchSize);
        await Promise.all(batch.map(user => scrapeAndSave(user.id, user.username, user.discord_id, env).catch(err => console.error(`Error updating @${user.username}:`, err.message))));
    }
}

async function scrapeSingleUser(username, env) {
    const user = await env.DB.prepare("SELECT id, username, discord_id FROM users WHERE LOWER(username) = LOWER(?)").bind(username).first();
    if (user) await scrapeAndSave(user.id, user.username, user.discord_id, env);
}

async function deleteUserFromDB(userId, env) {
    await env.DB.batch([
        env.DB.prepare("DELETE FROM snapshot_songs WHERE snapshot_id IN (SELECT id FROM snapshots WHERE user_id = ?)").bind(userId),
        env.DB.prepare("DELETE FROM snapshots WHERE user_id = ?").bind(userId),
        env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId)
    ]);
}

async function scrapeAndSave(userId, username, discordId, env) {
    let data = null;
    let currentUsername = username;
    let currentDiscordId = discordId;
    try {
        data = await fetchUserDataFromAPI(currentUsername, currentDiscordId);
    } catch (err) {
        if (err.message === "USER_NOT_FOUND" || err.message === "USER_NOT_CREATOR") {
            // Check if user has a discord_id in database to resolve username changes
            const dbUser = await env.DB.prepare("SELECT discord_id FROM users WHERE id = ?").bind(userId).first();
            if (dbUser && dbUser.discord_id) {
                try {
                    const headers = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" };
                    const profileRes = await fetch(`https://spicylyrics.org/api/trpc/ttml.getTTMLProfile?input=${encodeURIComponent(JSON.stringify({ json: { id: dbUser.discord_id, includeTracks: false } }))}`, { headers });
                    if (profileRes.ok) {
                        const profileJson = await profileRes.json();
                        const newUsername = profileJson.result?.data?.json?.profile?.data?.username || profileJson.result?.data?.json?.perUser?.username;
                        if (newUsername && newUsername.toLowerCase() !== currentUsername.toLowerCase()) {
                            // Update database username
                            await env.DB.prepare("UPDATE users SET username = ? WHERE id = ?").bind(newUsername, userId).run();
                            await logAction(env, "username_change", `Automatically updated username for @${currentUsername} -> @${newUsername} (Discord ID: ${dbUser.discord_id})`, null);
                            currentUsername = newUsername;
                            currentDiscordId = dbUser.discord_id;
                            // Retry fetch with the new username
                            data = await fetchUserDataFromAPI(currentUsername, currentDiscordId);
                        }
                    }
                } catch (fetchErr) {
                    console.error(`Failed to auto-detect username change for @${username}:`, fetchErr.message);
                }
            }
            
            if (!data) {
                const hasSnapshots = await env.DB.prepare("SELECT 1 FROM snapshots WHERE user_id = ? LIMIT 1").bind(userId).first();
                if (hasSnapshots) {
                    console.warn(`User @${currentUsername} (id: ${userId}) not valid (${err.message}) but has history. Skipping this update.`);
                    return;
                }
                console.warn(`User @${currentUsername} (id: ${userId}) not valid (${err.message}). Removing from tracked users.`);
                await deleteUserFromDB(userId, env);
                return;
            }
        }
    }

    if (!data) {
        console.error(`Failed to fetch data for @${currentUsername}. Skipping this update.`);
        return;
    }

    if (data.total_views === 0 && (!data.songs || data.songs.length === 0)) {
        const hasSnapshots = await env.DB.prepare("SELECT 1 FROM snapshots WHERE user_id = ? LIMIT 1").bind(userId).first();
        if (hasSnapshots) {
            console.warn(`User @${currentUsername} (id: ${userId}) returned 0 views and 0 tracks. Skipping this update to prevent data loss.`);
            return;
        } else {
            console.warn(`New User @${currentUsername} (id: ${userId}) has 0 views and 0 tracks on initial scrape. Removing from tracked users.`);
            await deleteUserFromDB(userId, env);
            return;
        }
    }

    // Safeguard: if total_views > 0 but songs list is empty, it's an API/fetch glitch.
    // We should skip saving this snapshot to prevent resetting the track list.
    if (!data.songs || data.songs.length === 0) {
        console.warn(`User @${currentUsername} (id: ${userId}) has ${data.total_views} views but returned 0 tracks. Skipping this update to prevent tracks count reset.`);
        return;
    }

    // 1. Cache track metadata
    if (data.tracksDetails && data.tracksDetails.length > 0) {
        // Query existing track IDs to find if there are any new ones
        const { results: existing } = await env.DB.prepare("SELECT spotify_id FROM track_metadata").all();
        const existingIds = new Set((existing || []).map(r => r.spotify_id));

        const stmt = env.DB.prepare("INSERT OR REPLACE INTO track_metadata (spotify_id, isrc, title, artist) VALUES (?, ?, ?, ?)");
        const batch = [];
        
        for (const track of data.tracksDetails) {
            if (!track) continue;
            const artistNames = (track.artists || []).map(a => a ? a.name : "SpicyLyrics").join(", ");
            batch.push(stmt.bind(track.id, track.isrc || null, track.name || "Hidden", artistNames));
            
            // If it is a new track, log it!
            if (!existingIds.has(track.id)) {
                await logAction(env, "new_track", `New track cached for @${currentUsername}: "${track.name}" by "${artistNames}" (ISRC: ${track.isrc || 'None'})`, null);
            }
        }

        if (batch.length > 0) {
            await env.DB.batch(batch);
        }
    }

    // 2. Calculate deduplicated total songs count
    const uniqueSongs = aggregateSongs(data.songs);
    const totalSongsCount = uniqueSongs.length;

    // 3. Save snapshot with total_songs
    const prevSnap = await env.DB.prepare("SELECT total_views FROM snapshots WHERE user_id = ? ORDER BY id DESC LIMIT 1").bind(userId).first();
    const oldViews = prevSnap ? prevSnap.total_views : 0;
    const newViews = data.total_views;

    const info = await env.DB.prepare("INSERT INTO snapshots (user_id, total_views, total_songs, timestamp) VALUES (?, ?, ?, datetime('now'))").bind(userId, newViews, totalSongsCount).run();
    const snapshotId = info.meta.last_row_id || info.meta.lastInsertedRowId;

    if (data.songs && data.songs.length > 0) {
        const stmt = env.DB.prepare("INSERT INTO snapshot_songs (snapshot_id, spotify_id, title, artist, views) VALUES (?, ?, ?, ?, ?)");
        const batch = data.songs.map(song => stmt.bind(snapshotId, song.spotify_id, song.title, song.artist, song.views));
        await env.DB.batch(batch);
    }

    // Check milestones (every 50K views)
    const step = 50000;
    if (oldViews > 0 && Math.floor(newViews / step) > Math.floor(oldViews / step)) {
        const milestone = Math.floor(newViews / step) * step;
        let milestoneText = `${milestone / 1000}K`;
        if (milestone >= 1000000) {
            milestoneText = `${milestone / 1000000}M`;
        }
        await logAction(env, "milestone_reached", `🎉 @${currentUsername} reached the milestone of ${milestoneText} total views! (Current: ${newViews.toLocaleString()})`, null);
    }

    if (data.discord_id) {
        await env.DB.prepare("UPDATE users SET discord_id = ?, discord_avatar = ? WHERE id = ?")
            .bind(data.discord_id, data.discord_avatar || null, userId)
            .run();
    }
}

async function fetchUserDataFromAPI(username, discordId = null) {
    const headers = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" };
    let userId = discordId;
    let discord_avatar = null;

    if (!userId) {
        const pageUrl = `https://spicylyrics.org/${username}`;
        const response = await fetch(pageUrl, { headers });
        if (response.status === 404) {
            throw new Error("USER_NOT_FOUND");
        }
        if (!response.ok) return null;
        const html = await response.text();

        const globalMatch = html.match(/(https:\/\/cdn\.discordapp\.com\/avatars\/(\d{1,21})\/(a_[a-f0-9]{32}|[a-f0-9]{32})[^\s"']*)/i);
        if (globalMatch) {
            userId = globalMatch[2];
            discord_avatar = globalMatch[1];
        } else {
            const guildMatch = html.match(/(https:\/\/cdn\.discordapp\.com\/guilds\/\d{1,21}\/users\/(\d{1,21})\/avatars\/(a_[a-f0-9]{32}|[a-f0-9]{32})[^\s"']*)/i);
            if (guildMatch) {
                userId = guildMatch[2];
                discord_avatar = guildMatch[1];
            }
        }

        if (!userId) {
            const patterns = [
                /"?userId"?\s*:\s*"?(\d{1,21})"?/i,
                /\\"userId\\":\s*\\"(\d{1,21})\\"/,
                /"?perUser"?\s*:\s*\{\s*"?id"?\s*:\s*"?(\d{1,21})"?/i,
                /"?(?:authorId|creatorId|ownerId)"?\s*:\s*"?(\d{1,21})"?/i,
                /\/users\/(\d{1,21})\/avatars\//,
                /avatars\/(\d{1,21})/
            ];
            for (const pattern of patterns) {
                const match = html.match(pattern);
                if (match) { userId = match[1]; break; }
            }
        }

        if (!userId) {
            throw new Error("USER_NOT_CREATOR");
        }
    }

    const profileRes = await fetch(`https://spicylyrics.org/api/trpc/ttml.getTTMLProfile?input=${encodeURIComponent(JSON.stringify({ json: { id: userId, includeTracks: true } }))}`, { headers });
    if (!profileRes.ok) return null;
    const profileJson = await profileRes.json();

    const perUser = profileJson.result?.data?.json?.perUser;
    const profile = profileJson.result?.data?.json?.profile;
    if (!perUser && !profile) {
        throw new Error("USER_NOT_FOUND");
    }

    // Fallback to TRPC if avatar was not found in HTML meta
    if (!discord_avatar) {
        discord_avatar = profile?.data?.avatar || perUser?.avatar || null;
    }

    const tracksRes = await fetch(`https://spicylyrics.org/api/trpc/ttml.getTTMLProfileTracks?input=${encodeURIComponent(JSON.stringify({ json: { id: userId } }))}`, { headers });
    if (!tracksRes.ok) return null;
    const tracksJson = await tracksRes.json();

    const makesList = perUser?.makes || [];
    const tracksDetails = tracksJson.result?.data?.json?.data || [];
    const tracksMap = new Map();
    for (const track of tracksDetails) {
        if (!track) continue;
        const artistNames = (track.artists || []).map(a => a ? a.name : "SpicyLyrics").join(", ");
        tracksMap.set(track.id, { title: track.name || "Hidden", artist: artistNames, isrc: track.isrc || null });
    }

    let total_views = 0, songs = [];
    for (const item of makesList) {
        const views = item.view_count || 0;
        total_views += views;
        const detail = tracksMap.get(item.id);
        if (detail) {
            songs.push({ spotify_id: item.id, title: detail.title, artist: detail.artist, isrc: detail.isrc, views: views });
        }
    }

    return { total_views, songs, tracksDetails, discord_id: userId, discord_avatar };
}