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
                response = await handleDashboardAPI(env);
            } else if (url.pathname === "/api/track-history" && request.method === "GET") {
                response = await handleTrackHistoryAPI(request, env);
            } else if (url.pathname.startsWith("/api/user/") && request.method === "GET") {
                const username = url.pathname.split("/")[3];
                response = await handleUserDetailAPI(username, env);
            } else if (url.pathname === "/api/admin/stats" && request.method === "POST") {
                response = await handleAdminStats(request, env);
            } else if (url.pathname === "/api/admin/scrape-user" && request.method === "POST") {
                response = await handleAdminScrapeUser(request, env);
            } else if (url.pathname === "/api/admin/scrape-all" && request.method === "POST") {
                response = await handleAdminScrapeAll(request, env, ctx);
            } else if (url.pathname === "/api/admin/delete-user" && request.method === "POST") {
                response = await handleAdminDeleteUser(request, env);
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
        ctx.waitUntil(runScraper(env));
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

    ctx.waitUntil(scrapeSingleUser(cleanName, env));

    return new Response(JSON.stringify({ success: true, cleanName }), {
        headers: { "Content-Type": "application/json", ...corsHeaders }
    });
}

async function handleDashboardAPI(env) {
    const globalQuery = await env.DB.prepare("SELECT COUNT(id) as total_users FROM users").first();

    const totalViewsQuery = await env.DB.prepare(`
    SELECT SUM(total_views) as global_views FROM (
      SELECT total_views FROM snapshots s1
      WHERE id = (SELECT id FROM snapshots s2 WHERE s2.user_id = s1.user_id ORDER BY id DESC LIMIT 1)
    )
  `).first();

    const { results: users } = await env.DB.prepare(`
    WITH latest_snapshots AS (
        SELECT user_id, id AS latest_id, timestamp AS latest_timestamp, total_views AS latest_views
        FROM snapshots s1
        WHERE id = (SELECT id FROM snapshots s2 WHERE s2.user_id = s1.user_id ORDER BY id DESC LIMIT 1)
    ),
    target_snapshots AS (
        SELECT 
            u.id AS user_id, 
            ls.latest_id, 
            ls.latest_timestamp,
            ls.latest_views,
            (
                SELECT id FROM snapshots 
                WHERE user_id = u.id 
                  AND timestamp >= datetime(ls.latest_timestamp, '-8.5 days') 
                  AND timestamp <= datetime(ls.latest_timestamp, '-5.5 days') 
                ORDER BY ABS(strftime('%s', timestamp) - strftime('%s', datetime(ls.latest_timestamp, '-7 days'))) ASC 
                LIMIT 1
            ) AS past_7d_id
        FROM users u
        LEFT JOIN latest_snapshots ls ON ls.user_id = u.id
    ),
    song_counts AS (
        SELECT 
            snapshot_id, 
            COUNT(DISTINCT LOWER(COALESCE(NULLIF(TRIM(title), ''), 'Hidden')) || '|||' || LOWER(COALESCE(NULLIF(TRIM(artist), ''), 'SpicyLyrics'))) AS cnt
        FROM snapshot_songs
        WHERE snapshot_id IN (SELECT latest_id FROM target_snapshots UNION SELECT past_7d_id FROM target_snapshots WHERE past_7d_id IS NOT NULL)
        GROUP BY snapshot_id
    )
    SELECT 
        u.username, 
        ts.latest_views AS current_views, 
        ts.latest_timestamp AS last_updated, 
        s_past.total_views AS past_views,
        s_first.timestamp AS first_snapshot,
        ts.past_7d_id,
        COALESCE(sc_latest.cnt, 0) AS total_songs,
        COALESCE(sc_past.cnt, 0) AS total_songs_7d
    FROM users u 
    LEFT JOIN target_snapshots ts ON ts.user_id = u.id
    LEFT JOIN snapshots s_past ON s_past.id = (
        SELECT id FROM snapshots 
        WHERE user_id = u.id 
          AND timestamp >= datetime(ts.latest_timestamp, '-30 hours') 
          AND timestamp <= datetime(ts.latest_timestamp, '-18 hours') 
        ORDER BY ABS(strftime('%s', timestamp) - strftime('%s', datetime(ts.latest_timestamp, '-24 hours'))) ASC 
        LIMIT 1
    )
    LEFT JOIN snapshots s_first ON s_first.id = (SELECT id FROM snapshots WHERE user_id = u.id ORDER BY id ASC LIMIT 1)
    LEFT JOIN song_counts sc_latest ON sc_latest.snapshot_id = ts.latest_id
    LEFT JOIN song_counts sc_past ON sc_past.snapshot_id = ts.past_7d_id
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
            tracks_growth_7d: u.past_7d_id !== null ? (u.total_songs || 0) - (u.total_songs_7d || 0) : 0,
            last_updated: u.last_updated || null
        }))
    };

    return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json", ...corsHeaders } });
}

async function handleUserDetailAPI(username, env) {
    const user = await env.DB.prepare("SELECT * FROM users WHERE LOWER(username) = LOWER(?)").bind(username).first();
    if (!user) return new Response(JSON.stringify({ error: "User not found" }), { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } });

    const firstSnapshot = await env.DB.prepare("SELECT timestamp FROM snapshots WHERE user_id = ? ORDER BY id ASC LIMIT 1").bind(user.id).first();
    const firstSnapshotTimestamp = firstSnapshot ? firstSnapshot.timestamp : null;

    const { results: history } = await env.DB.prepare("SELECT id, total_views, timestamp FROM snapshots WHERE user_id = ? ORDER BY id DESC LIMIT 100").bind(user.id).all();

    let totalViews = 0, growth24h = null, totalSongs = 0;
    let topTracks = [], chartDataRaw = [], finalSongs = [];

    if (history && history.length > 0) {
        let latestSnapshot = null;
        let latestRaw = [];

        for (const snap of history) {
            const { results: songs } = await env.DB.prepare("SELECT * FROM snapshot_songs WHERE snapshot_id = ?").bind(snap.id).all();
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
            const { results } = await env.DB.prepare("SELECT * FROM snapshot_songs WHERE snapshot_id = ?").bind(pastSnapshot.id).all();
            if (results) pastRaw = results;
        }

        const getTrackKey = (s) => `${(s.title || "Hidden").trim().toLowerCase()}|||${(s.artist || "SpicyLyrics").trim().toLowerCase()}`;

        const aggregateSongs = (rawList) => {
            const map = new Map();
            for (const s of rawList || []) {
                const key = getTrackKey(s);
                if (map.has(key)) map.get(key).views += s.views;
                else map.set(key, { title: s.title || "Hidden", artist: s.artist || "SpicyLyrics", views: s.views || 0 });
            }
            return Array.from(map.values());
        };

        const latestSongs = aggregateSongs(latestRaw);
        const pastSongs = aggregateSongs(pastRaw);
        totalSongs = latestSongs.length;

        const pastMap = new Map();
        pastSongs.forEach(s => pastMap.set(getTrackKey(s), s.views));

        finalSongs = latestSongs.map(s => {
            const key = getTrackKey(s);
            const prev = pastMap.get(key) ?? s.views;
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

    const { results } = await env.DB.prepare(`
        SELECT SUM(ss.views) as views, s.timestamp
        FROM snapshot_songs ss
        JOIN snapshots s ON ss.snapshot_id = s.id
        WHERE s.user_id = ? AND LOWER(ss.title) = LOWER(?) AND LOWER(ss.artist) = LOWER(?)
        GROUP BY s.id, s.timestamp
        ORDER BY s.id ASC
    `).bind(user.id, title.trim(), artist.trim()).all();

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
    // Aggregate by title and artist to exactly match dashboard and profile counts
    const { results: songCounts } = await env.DB.prepare(`
        SELECT snapshot_id, COUNT(DISTINCT (LOWER(TRIM(title)) || ' - ' || LOWER(TRIM(artist)))) as cnt
        FROM snapshot_songs
        WHERE snapshot_id IN (
            SELECT MAX(id) FROM snapshots GROUP BY user_id
        )
        GROUP BY snapshot_id
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

async function handleAdminScrapeUser(request, env) {
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
        await scrapeAndSave(user.id, cleanName, env);
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
        return new Response(JSON.stringify({ success: true, message: "Scraper run triggered in background" }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
    } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } });
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
        return new Response(JSON.stringify({ success: true, message: `Successfully deleted @${cleanName}` }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
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

            const info = await env.DB.prepare("INSERT INTO snapshots (user_id, total_views, timestamp) VALUES (?, ?, ?)").bind(user.id, totalViews, timestamp).run();
            const snapshotId = info.meta.last_row_id || info.meta.lastInsertedRowId;
            const songs = record.data.songs;

            if (songs && Object.keys(songs).length > 0) {
                const stmt = env.DB.prepare("INSERT INTO snapshot_songs (snapshot_id, spotify_id, title, artist, views) VALUES (?, ?, ?, ?, ?)");
                const batch = Object.entries(songs).map(([songKey, sData]) => stmt.bind(snapshotId, songKey.length < 30 ? songKey : "", sData.title, sData.artist, sData.views));
                await env.DB.batch(batch);
            }
            snapshotCount++;
        }
        return new Response(JSON.stringify({ success: true, imported: snapshotCount }), { headers: { "Content-Type": "application/json", ...corsHeaders } });
    } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }
}

async function handleExport(username, env) {
    const user = await env.DB.prepare("SELECT id FROM users WHERE LOWER(username) = LOWER(?)").bind(username).first();
    if (!user) return new Response("User not found", { status: 404, headers: corsHeaders });

    const snapshots = await env.DB.prepare("SELECT id, total_views, timestamp FROM snapshots WHERE user_id = ? ORDER BY timestamp DESC").bind(user.id).all();
    const songs = await env.DB.prepare(`
    SELECT ss.title, ss.artist, ss.views, ss.spotify_id, ss.snapshot_id
    FROM snapshot_songs ss JOIN snapshots s ON ss.snapshot_id = s.id
    WHERE s.user_id = ? ORDER BY s.timestamp DESC
  `).bind(user.id).all();

    const exportData = {
        username,
        exported_at: new Date().toISOString(),
        history: snapshots.results.map(snap => ({
            timestamp: snap.timestamp,
            total_views: snap.total_views,
            songs: songs.results.filter(s => s.snapshot_id === snap.id).map(s => ({ title: s.title, artist: s.artist, views: s.views, spotify_id: s.spotify_id }))
        }))
    };

    return new Response(JSON.stringify(exportData, null, 2), {
        headers: { "Content-Type": "application/json;charset=UTF-8", "Content-Disposition": `attachment; filename="${username}_spicy_data.json"`, ...corsHeaders }
    });
}

// Scraper & parser functions
// remain IDENTICAL to your original file.
async function runScraper(env) {
    const { results: users } = await env.DB.prepare(`
    SELECT u.id, u.username, s_latest.id AS latest_snap_id
    FROM users u
    LEFT JOIN snapshots s_latest ON s_latest.id = (
        SELECT id FROM snapshots WHERE user_id = u.id ORDER BY id DESC LIMIT 1
    )
    ORDER BY latest_snap_id ASC
    LIMIT 12
  `).all();

    if (!users || users.length === 0) return;

    const batchSize = 4;
    for (let i = 0; i < users.length; i += batchSize) {
        const batch = users.slice(i, i + batchSize);
        await Promise.all(batch.map(user => scrapeAndSave(user.id, user.username, env).catch(err => console.error(`Error updating @${user.username}:`, err.message))));
    }
}

async function scrapeSingleUser(username, env) {
    const user = await env.DB.prepare("SELECT id, username FROM users WHERE LOWER(username) = LOWER(?)").bind(username).first();
    if (user) await scrapeAndSave(user.id, user.username, env);
}

async function deleteUserFromDB(userId, env) {
    await env.DB.batch([
        env.DB.prepare("DELETE FROM snapshot_songs WHERE snapshot_id IN (SELECT id FROM snapshots WHERE user_id = ?)").bind(userId),
        env.DB.prepare("DELETE FROM snapshots WHERE user_id = ?").bind(userId),
        env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId)
    ]);
}

async function scrapeAndSave(userId, username, env) {
    let data = null;
    try {
        data = await fetchUserDataFromAPI(username);
    } catch (err) {
        if (err.message === "USER_NOT_FOUND" || err.message === "USER_NOT_CREATOR") {
            console.warn(`User @${username} (id: ${userId}) not valid (${err.message}). Removing from tracked users.`);
            await deleteUserFromDB(userId, env);
            return;
        }
    }

    if (!data) {
        const lastSnap = await env.DB.prepare("SELECT total_views FROM snapshots WHERE user_id = ? ORDER BY id DESC LIMIT 1").bind(userId).first();
        const lastViews = lastSnap ? lastSnap.total_views : 0;
        await env.DB.prepare("INSERT INTO snapshots (user_id, total_views, timestamp) VALUES (?, ?, datetime('now'))").bind(userId, lastViews).run();
        return;
    }

    if (data.total_views === 0 && (!data.songs || data.songs.length === 0)) {
        console.warn(`User @${username} (id: ${userId}) has 0 views and 0 tracks. Removing from tracked users.`);
        await deleteUserFromDB(userId, env);
        return;
    }

    const info = await env.DB.prepare("INSERT INTO snapshots (user_id, total_views, timestamp) VALUES (?, ?, datetime('now'))").bind(userId, data.total_views).run();
    const snapshotId = info.meta.last_row_id || info.meta.lastInsertedRowId;

    if (data.songs && data.songs.length > 0) {
        const stmt = env.DB.prepare("INSERT INTO snapshot_songs (snapshot_id, spotify_id, title, artist, views) VALUES (?, ?, ?, ?, ?)");
        const batch = data.songs.map(song => stmt.bind(snapshotId, song.spotify_id, song.title, song.artist, song.views));
        await env.DB.batch(batch);
    }

    if (data.discord_id) {
        await env.DB.prepare("UPDATE users SET discord_id = ?, discord_avatar = ? WHERE id = ?")
            .bind(data.discord_id, data.discord_avatar || null, userId)
            .run();
    }
}

async function fetchUserDataFromAPI(username) {
    const pageUrl = `https://spicylyrics.org/${username}`;
    const headers = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" };
    const response = await fetch(pageUrl, { headers });
    if (response.status === 404) {
        throw new Error("USER_NOT_FOUND");
    }
    if (!response.ok) return null;
    const html = await response.text();

    if (html.includes('"userId":""') || html.includes('\\"userId\\":\\"\\"') || html.includes('"userId":null') || html.includes('\\"userId\\":null')) {
        throw new Error("USER_NOT_CREATOR");
    }

    const avatarMatch = html.match(/cdn\.discordapp\.com\/avatars\/(\d{1,21})\/([a-f0-9]{32})/i);
    let discord_id = null;
    let discord_avatar = null;
    if (avatarMatch) {
        discord_id = avatarMatch[1];
        discord_avatar = avatarMatch[2];
    }

    let userId = discord_id;
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

    if (!userId) return null;
    if (!discord_id) discord_id = userId;

    const profileRes = await fetch(`https://spicylyrics.org/api/trpc/ttml.getTTMLProfile?input=${encodeURIComponent(JSON.stringify({ json: { id: userId, includeTracks: true } }))}`, { headers });
    if (!profileRes.ok) return null;
    const profileJson = await profileRes.json();

    // Fallback to TRPC if avatar was not found in HTML meta
    if (!discord_avatar) {
        const perUser = profileJson.result?.data?.json?.perUser || {};
        discord_avatar = perUser.avatar || null;
    }

    const tracksRes = await fetch(`https://spicylyrics.org/api/trpc/ttml.getTTMLProfileTracks?input=${encodeURIComponent(JSON.stringify({ json: { id: userId } }))}`, { headers });
    if (!tracksRes.ok) return null;
    const tracksJson = await tracksRes.json();

    const makesList = profileJson.result?.data?.json?.perUser?.makes || [];
    const tracksDetails = tracksJson.result?.data?.json?.data || [];
    const tracksMap = new Map();
    for (const track of tracksDetails) {
        if (!track) continue;
        const artistNames = (track.artists || []).map(a => a ? a.name : "SpicyLyrics").join(", ");
        tracksMap.set(track.id, { title: track.name || "Hidden", artist: artistNames });
    }

    let total_views = 0, songs = [];
    for (const item of makesList) {
        const views = item.view_count || 0;
        total_views += views;
        const detail = tracksMap.get(item.id);
        if (detail) {
            songs.push({ spotify_id: item.id, title: detail.title, artist: detail.artist, views: views });
        }
    }

    return { total_views, songs, discord_id, discord_avatar };
}