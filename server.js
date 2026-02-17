#!/usr/bin/env node
/**
 * AutoDash Server
 *
 * - Serves static frontend from public/
 * - Fetches data from TeamGantt API and caches to cache.json
 * - GET /api/data    → returns cached data (or empty if no cache)
 * - POST /api/refresh → re-fetches all data from TeamGantt, updates cache
 * - GET /config.js   → injects PROJECT_ID (token stays server-side now)
 *
 * Time entries are fetched using GET /times?date=... day-by-day
 * (same approach as clear_hours.py — the bulk endpoints return 404).
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const SECRETS_FILE = path.join(__dirname, 'secrets.txt');
const CACHE_FILE = path.join(__dirname, 'cache.json');
const BASE_URL = 'https://api.teamgantt.com/v1';

// --- Read secrets -----------------------------------------------------------
let API_TOKEN, PROJECT_ID;
try {
    const lines = fs.readFileSync(SECRETS_FILE, 'utf-8').trim().split('\n');
    API_TOKEN = lines[0].trim();
    PROJECT_ID = lines[1]?.trim() || '';
    if (!API_TOKEN || API_TOKEN === 'YOUR_API_TOKEN_HERE') {
        console.error('⚠  Please set your API token in secrets.txt (line 1)');
        process.exit(1);
    }
    if (!PROJECT_ID) {
        console.error('⚠  Please set the Project ID in secrets.txt (line 2)');
        process.exit(1);
    }
} catch (err) {
    console.error('⚠  Could not read secrets.txt:', err.message);
    process.exit(1);
}

// --- API helpers ------------------------------------------------------------
async function apiFetch(path, params = {}) {
    const url = new URL(`${BASE_URL}${path}`);
    Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    });

    const resp = await fetch(url.toString(), {
        headers: {
            'Authorization': `Bearer ${API_TOKEN}`,
            'Content-Type': 'application/json',
        },
    });

    if (!resp.ok) {
        throw new Error(`API ${resp.status}: ${resp.statusText} — ${path}`);
    }
    return resp.json();
}

// --- Data fetching ----------------------------------------------------------
async function fetchAllData(progressCb) {
    progressCb('Fetching project info…');
    const project = await apiFetch(`/projects/${PROJECT_ID}`);

    progressCb('Fetching tasks…');
    const items = await apiFetch('/tasks', { project_ids: PROJECT_ID });
    const tasks = [];
    const groups = [];
    if (Array.isArray(items)) {
        items.forEach(item => {
            if (item.type === 'task' || item.type === 'milestone') tasks.push(item);
            else if (item.type === 'group') groups.push(item);
        });
    }

    // Extract unique resource IDs from task assignments
    const resourceIds = new Set();
    tasks.forEach(task => {
        (task.resources || []).forEach(res => {
            const rid = res.type_id || res.id;
            if (rid) resourceIds.add(String(rid));
        });
    });

    progressCb(`Fetching time entries for ${resourceIds.size} users…`);
    const projStart = project.start_date;
    const projEnd = project.end_date;
    const todayStr = new Date().toISOString().slice(0, 10);
    const endStr = projEnd < todayStr ? projEnd : todayStr;

    const userIdStr = Array.from(resourceIds).join(',');
    const timeEntries = await fetchTimeEntriesByDate(projStart, endStr, userIdStr, progressCb);

    const data = {
        project,
        tasks,
        groups,
        timeEntries,
        fetchedAt: new Date().toISOString(),
    };

    return data;
}

async function fetchTimeEntriesByDate(startDate, endDate, userIds, progressCb) {
    const entries = [];
    const seen = new Set();

    const start = new Date(startDate + 'T00:00:00');
    const end = new Date(endDate + 'T00:00:00');

    // Step by day but batch 15 concurrent requests at a time.
    // Each request fetches ALL users at once via user_ids param.
    const dates = [];
    const current = new Date(start);
    while (current <= end) {
        dates.push(current.toISOString().slice(0, 10));
        current.setDate(current.getDate() + 1);
    }

    const BATCH_SIZE = 15;
    for (let i = 0; i < dates.length; i += BATCH_SIZE) {
        const batch = dates.slice(i, i + BATCH_SIZE);
        const promises = batch.map(async (dateStr) => {
            try {
                const resp = await apiFetch('/times', {
                    date: dateStr,
                    user_ids: userIds,
                });
                const data = Array.isArray(resp) ? resp : [];
                // Filter to our project
                return data.filter(e => String(e.project_id) === String(PROJECT_ID));
            } catch (e) {
                console.warn(`  Failed /times?date=${dateStr}:`, e.message);
                return [];
            }
        });

        const results = await Promise.all(promises);
        results.forEach(dayEntries => {
            dayEntries.forEach(entry => {
                if (!seen.has(entry.id)) {
                    seen.add(entry.id);
                    entries.push(entry);
                }
            });
        });

        const progress = Math.min(i + BATCH_SIZE, dates.length);
        progressCb(`Fetching time entries… ${progress}/${dates.length} days`);
    }

    console.log(`  Found ${entries.length} unique time entries`);
    return entries;
}

// --- Cache ------------------------------------------------------------------
function readCache() {
    try {
        if (fs.existsSync(CACHE_FILE)) {
            const raw = fs.readFileSync(CACHE_FILE, 'utf-8');
            return JSON.parse(raw);
        }
    } catch (e) {
        console.warn('Could not read cache:', e.message);
    }
    return null;
}

function writeCache(data) {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), 'utf-8');
    console.log(`✓ Cache written: ${(fs.statSync(CACHE_FILE).size / 1024).toFixed(1)} KB`);
}

// --- Express app ------------------------------------------------------------
const app = express();
app.use(express.json());

let refreshInProgress = false;

// Serve runtime config (project ID only, token stays server-side)
app.get('/config.js', (_req, res) => {
    res.type('application/javascript');
    res.send(`window.__CONFIG = ${JSON.stringify({ PROJECT_ID })};`);
});

// GET /api/data — return cached data
app.get('/api/data', (_req, res) => {
    const cache = readCache();
    if (!cache) {
        return res.json({ cached: false, data: null });
    }
    res.json({ cached: true, data: cache });
});

// POST /api/refresh — re-fetch everything from TeamGantt
app.post('/api/refresh', async (_req, res) => {
    if (refreshInProgress) {
        return res.status(409).json({ error: 'Refresh already in progress' });
    }

    refreshInProgress = true;
    try {
        console.log('--- Starting data refresh ---');
        const data = await fetchAllData((msg) => console.log(`  ${msg}`));
        writeCache(data);
        console.log('--- Refresh complete ---');
        res.json({ success: true, data });
    } catch (err) {
        console.error('Refresh failed:', err);
        res.status(500).json({ error: err.message });
    } finally {
        refreshInProgress = false;
    }
});

// GET /api/refresh/status
app.get('/api/refresh/status', (_req, res) => {
    res.json({ inProgress: refreshInProgress });
});

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// SPA fallback
app.get('*', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`✓ AutoDash running at http://0.0.0.0:${PORT}`);
    console.log(`  Project ID: ${PROJECT_ID}`);
    const cache = readCache();
    if (cache) {
        console.log(`  Cache found (fetched at ${cache.fetchedAt})`);
    } else {
        console.log('  No cache — click Refresh in the dashboard to fetch data');
    }
});
