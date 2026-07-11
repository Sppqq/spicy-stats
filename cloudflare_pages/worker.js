const IMPORT_SECRET = "MY_SUPER_SECRET_KEY";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Access-Control-Allow-Headers": "Content-Type",
};

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // Обработка CORS preflight
        if (request.method === "OPTIONS") {
            return new Response(null, { headers: corsHeaders });
        }

        try {
            if (url.pathname === "/api/import" && request.method === "POST") {
                return await handleImport(request, env);
            }

            if (url.pathname.startsWith("/api/export/")) {
                const username = url.pathname.split("/")[3];
                return await handleExport(username, env);
            }

            if (url.pathname === "/api/add-user" && request.method === "POST") {
                return await handleAddUser(request, env, ctx);
            }

            if (url.pathname === "/api/dashboard" && request.method === "GET") {
                return await handleDashboardAPI(env);
            }

            if (url.pathname.startsWith("/api/user/") && request.method === "GET") {
                const username = url.pathname.split("/")[3];
                return await handleUserDetailAPI(username, env);
            }

            return new Response(JSON.stringify({ error: "API Endpoint Not Found" }), { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } });
        } catch (err) {
            return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } });
        }
    },

    async scheduled(event, env, ctx) {
        ctx.waitUntil(runScraper(env));
    }
};

// ==========================================
// ОСНОВНЫЕ API МЕТОДЫ (JSON)
// ==========================================

async function handleAddUser(request, env, ctx) {
    const { username } = await request.json();
    if (!username || typeof username !== "string") {
        return new Response(JSON.stringify({ error: "Введите корректный никнейм." }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } });
    }

    const cleanName = username.trim().replace(/^@/, "");

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
    WITH target_snapshots AS (
        SELECT u.id AS user_id, s_latest.id AS latest_id, s_past_7d.id AS past_7d_id
        FROM users u
        LEFT JOIN snapshots s_latest ON s_latest.id = (SELECT id FROM snapshots WHERE user_id = u.id ORDER BY id DESC LIMIT 1)
        LEFT JOIN snapshots s_past_7d ON s_past_7d.id = (SELECT id FROM snapshots WHERE user_id = u.id AND timestamp <= datetime(s_latest.timestamp, '-7 days') ORDER BY id DESC LIMIT 1)
    ),
    song_counts AS (
        SELECT 
            snapshot_id, 
            COUNT(DISTINCT LOWER(COALESCE(NULLIF(TRIM(title), ''), 'Скрыто')) || '|||' || LOWER(COALESCE(NULLIF(TRIM(artist), ''), 'SpicyLyrics'))) AS cnt
        FROM snapshot_songs
        WHERE snapshot_id IN (SELECT latest_id FROM target_snapshots UNION SELECT past_7d_id FROM target_snapshots WHERE past_7d_id IS NOT NULL)
        GROUP BY snapshot_id
    )
    SELECT 
        u.username, 
        s_latest.total_views AS current_views, 
        s_latest.timestamp AS last_updated, 
        s_past.total_views AS past_views,
        COALESCE(sc_latest.cnt, 0) AS total_songs,
        COALESCE(sc_past.cnt, 0) AS total_songs_7d
    FROM users u 
    LEFT JOIN snapshots s_latest ON s_latest.id = ( SELECT id FROM snapshots WHERE user_id = u.id ORDER BY id DESC LIMIT 1)
    LEFT JOIN snapshots s_past ON s_past.id = (SELECT id FROM snapshots WHERE user_id = u.id AND timestamp <= datetime(s_latest.timestamp, '-24 hours') ORDER BY id DESC LIMIT 1)
    LEFT JOIN snapshots s_past_7d ON s_past_7d.id = (SELECT id FROM snapshots WHERE user_id = u.id AND timestamp <= datetime(s_latest.timestamp, '-7 days') ORDER BY id DESC LIMIT 1)
    LEFT JOIN song_counts sc_latest ON sc_latest.snapshot_id = s_latest.id
    LEFT JOIN song_counts sc_past ON sc_past.snapshot_id = s_past_7d.id
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
            growth: (u.current_views || 0) - (u.past_views || 0),
            total_songs: u.total_songs || 0,
            tracks_growth_7d: u.total_songs_7d !== null ? (u.total_songs || 0) - (u.total_songs_7d || 0) : 0,
            last_updated: u.last_updated || null
        }))
    };

    return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json", ...corsHeaders } });
}

async function handleUserDetailAPI(username, env) {
    const user = await env.DB.prepare("SELECT * FROM users WHERE LOWER(username) = LOWER(?)").bind(username).first();
    if (!user) return new Response(JSON.stringify({ error: "Пользователь не найден" }), { status: 404, headers: { "Content-Type": "application/json", ...corsHeaders } });

    const { results: history } = await env.DB.prepare("SELECT id, total_views, timestamp FROM snapshots WHERE user_id = ? ORDER BY id DESC LIMIT 100").bind(user.id).all();

    let totalViews = 0, growth24h = 0, totalSongs = 0;
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
        }) || history[history.length - 1];

        if (pastSnapshot) growth24h = totalViews - pastSnapshot.total_views;

        const { results: pastRaw } = await env.DB.prepare("SELECT * FROM snapshot_songs WHERE snapshot_id = ?").bind(pastSnapshot.id).all();

        const getTrackKey = (s) => `${(s.title || "Скрыто").trim().toLowerCase()}|||${(s.artist || "SpicyLyrics").trim().toLowerCase()}`;

        const aggregateSongs = (rawList) => {
            const map = new Map();
            for (const s of rawList || []) {
                const key = getTrackKey(s);
                if (map.has(key)) map.get(key).views += s.views;
                else map.set(key, { title: s.title || "Скрыто", artist: s.artist || "SpicyLyrics", views: s.views || 0 });
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
        total_views: totalViews,
        growth24h,
        total_songs: totalSongs,
        highlights: topTracks,
        chart_data: chartDataRaw,
        songs: finalSongs
    };

    return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json", ...corsHeaders } });
}

// ==========================================
// СТАРЫЕ ФУНКЦИИ (ОСТАЮТСЯ БЕЗ ИЗМЕНЕНИЙ, ДОБАВЛЕН CORS)
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
    if (!user) return new Response("Пользователь не найден", { status: 404, headers: corsHeaders });

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

// Функции парсинга (runScraper, scrapeSingleUser, scrapeAndSave, fetchUserDataFromAPI) 
// остаются ИДЕНТИЧНЫМИ твоему оригинальному файлу, просто скопируй их сюда.
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
        await Promise.all(batch.map(user => scrapeAndSave(user.id, user.username, env).catch(err => console.error(`Ошибка обновления @${user.username}:`, err.message))));
    }
}

async function scrapeSingleUser(username, env) {
    const user = await env.DB.prepare("SELECT id, username FROM users WHERE LOWER(username) = LOWER(?)").bind(username).first();
    if (user) await scrapeAndSave(user.id, user.username, env);
}

async function scrapeAndSave(userId, username, env) {
    let data = null;
    try { data = await fetchUserDataFromAPI(username); } catch (err) { }

    if (!data) {
        // Проверяем: были ли у юзера хоть раз треки (успешный скрейп)
        const hasSongs = await env.DB.prepare(
            "SELECT 1 FROM snapshot_songs ss JOIN snapshots s ON ss.snapshot_id = s.id WHERE s.user_id = ? LIMIT 1"
        ).bind(userId).first();

        const snapCount = await env.DB.prepare(
            "SELECT COUNT(*) as cnt FROM snapshots WHERE user_id = ?"
        ).bind(userId).first();

        if (!hasSongs && snapCount && snapCount.cnt >= 3) {
            // Никогда не найден на сайте после 3+ попыток — удаляем
            await env.DB.prepare("DELETE FROM snapshots WHERE user_id = ?").bind(userId).run();
            await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();
            return;
        }

        // Временная ошибка или новый юзер — сохраняем пустой снапшот
        const lastSnap = await env.DB.prepare("SELECT total_views FROM snapshots WHERE user_id = ? ORDER BY id DESC LIMIT 1").bind(userId).first();
        const lastViews = lastSnap ? lastSnap.total_views : 0;
        await env.DB.prepare("INSERT INTO snapshots (user_id, total_views, timestamp) VALUES (?, ?, datetime('now'))").bind(userId, lastViews).run();
        return;
    }

    const info = await env.DB.prepare("INSERT INTO snapshots (user_id, total_views, timestamp) VALUES (?, ?, datetime('now'))").bind(userId, data.total_views).run();
    const snapshotId = info.meta.last_row_id || info.meta.lastInsertedRowId;

    if (data.songs && data.songs.length > 0) {
        const stmt = env.DB.prepare("INSERT INTO snapshot_songs (snapshot_id, spotify_id, title, artist, views) VALUES (?, ?, ?, ?, ?)");
        const batch = data.songs.map(song => stmt.bind(snapshotId, song.spotify_id, song.title, song.artist, song.views));
        await env.DB.batch(batch);
    }
}

async function fetchUserDataFromAPI(username) {
    const pageUrl = `https://spicylyrics.org/${username}`;
    const headers = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" };
    const response = await fetch(pageUrl, { headers });
    if (!response.ok) return null;
    const html = await response.text();

    let userId = null;
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

    if (!userId) return null;

    const profileRes = await fetch(`https://spicylyrics.org/api/trpc/ttml.getTTMLProfile?input=${encodeURIComponent(JSON.stringify({ json: { id: userId, includeTracks: true } }))}`, { headers });
    if (!profileRes.ok) return null;
    const profileJson = await profileRes.json();

    const tracksRes = await fetch(`https://spicylyrics.org/api/trpc/ttml.getTTMLProfileTracks?input=${encodeURIComponent(JSON.stringify({ json: { id: userId } }))}`, { headers });
    if (!tracksRes.ok) return null;
    const tracksJson = await tracksRes.json();

    const makesList = profileJson.result?.data?.json?.perUser?.makes || [];
    const tracksDetails = tracksJson.result?.data?.json?.data || [];
    const tracksMap = new Map();
    for (const track of tracksDetails) {
        if (!track) continue;
        const artistNames = (track.artists || []).map(a => a ? a.name : "SpicyLyrics").join(", ");
        tracksMap.set(track.id, { title: track.name || "Скрыто", artist: artistNames });
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

    return { total_views, songs };
}