/* =========================================================================
   aUToDash — WBS Dashboard Application Logic
   ========================================================================= */

// ---------------------------------------------------------------------------
// Config & Constants
// ---------------------------------------------------------------------------
const CONFIG = window.__CONFIG || {};
const PROJECT_ID = CONFIG.PROJECT_ID;

const TEAM_COLORS = [
    '#638cff', '#34d399', '#f87171', '#fbbf24', '#a78bfa',
    '#22d3ee', '#fb923c', '#e879f9', '#4ade80', '#f472b6',
    '#60a5fa', '#facc15', '#c084fc', '#2dd4bf', '#f97316',
];

const EXCLUDED_TEAMS = new Set(['DLA', 'RESEARCH']);

function isExcludedMember(rid) {
    const member = STATE.members[rid];
    return member && EXCLUDED_TEAMS.has(member.team);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let STATE = {
    project: null,
    tasks: [],
    groups: [],
    timeEntries: [],
    members: {},      // resourceId -> { name, fullName, team, memberClass }
    taskMap: {},       // taskId -> task
    groupMap: {},      // groupId -> group
    fetchedAt: null,
};

// ---------------------------------------------------------------------------
// Server API — data is fetched & cached on the server
// ---------------------------------------------------------------------------
async function loadCachedData() {
    setLoadingStatus('Loading cached data…');
    const resp = await fetch('/api/data');
    if (!resp.ok) throw new Error(`Server error ${resp.status}`);
    return resp.json();
}

async function triggerRefresh() {
    setLoadingStatus('Refreshing data from TeamGantt… This may take a few minutes.');
    const resp = await fetch('/api/refresh', { method: 'POST' });
    if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error(body.error || `Server error ${resp.status}`);
    }
    return resp.json();
}

// ---------------------------------------------------------------------------
// Member Name Parsing (ported from gen_hours.py)
// ---------------------------------------------------------------------------
function parseMemberName(resourceName) {
    if (!resourceName) return null;
    let name = resourceName.trim();

    // Normalize dashes
    let normalized = name.replace(/\u2013/g, ' - ').replace(/\u2014/g, ' - ');
    normalized = normalized.replace(/\s+-\s*/g, ' - ').replace(/\s*-\s+/g, ' - ');

    if (normalized.startsWith('!')) {
        const inner = normalized.slice(1).trim();
        const parts = inner.split(' - ').map(p => p.trim());

        if (parts.length === 1) {
            return { fullName: inner, team: 'LEADERSHIP', memberClass: 'SPECIAL' };
        } else if (parts.length === 2) {
            return { fullName: parts[0], team: 'LEADERSHIP', memberClass: parts[1].toUpperCase() };
        }
        return null;
    }

    const parts = normalized.split(' - ').map(p => p.trim());
    if (parts.length !== 3) {
        return { fullName: name, team: 'UNKNOWN', memberClass: 'UNKNOWN' };
    }

    let team = parts[0].toUpperCase();
    if (team === 'PLAN') team = 'PLANNING'; // Alias PLAN -> PLANNING
    const fullName = parts[1];
    let memberClass = parts[2].toUpperCase();

    const aliases = { MEMBER: 'MEM', LEAAD: 'LEAD' };
    memberClass = aliases[memberClass] || memberClass;

    return { fullName, team, memberClass };
}

// ---------------------------------------------------------------------------
// Data Processing
// ---------------------------------------------------------------------------
function processData() {
    const { tasks, groups } = STATE;

    STATE.groupMap = {};
    groups.forEach(g => { STATE.groupMap[g.id] = g; });

    STATE.taskMap = {};
    STATE.members = {};

    tasks.forEach(task => {
        STATE.taskMap[task.id] = task;

        const resources = task.resources || [];
        resources.forEach(res => {
            const rid = res.type_id || res.id;
            if (rid == null) return;
            if (!STATE.members[rid]) {
                const parsed = parseMemberName(res.name);
                STATE.members[rid] = {
                    name: res.name,
                    fullName: parsed ? parsed.fullName : res.name,
                    team: parsed ? parsed.team : 'UNKNOWN',
                    memberClass: parsed ? parsed.memberClass : 'UNKNOWN',
                    id: rid,
                };
            }
        });
    });

    // Also extract members from time entries (uses user_id + user object)
    STATE.timeEntries.forEach(te => {
        const rid = te.user_id;
        if (rid && !STATE.members[rid]) {
            // User name is split: first_name="TEAM", last_name="- Name - CLASS"
            const rawName = te.user
                ? `${te.user.first_name} ${te.user.last_name}`.trim()
                : `User ${rid}`;
            const parsed = parseMemberName(rawName);
            STATE.members[rid] = {
                name: rawName,
                fullName: parsed ? parsed.fullName : rawName,
                team: parsed ? parsed.team : 'UNKNOWN',
                memberClass: parsed ? parsed.memberClass : 'UNKNOWN',
                id: rid,
            };
        }
    });
}

function classifyTask(task) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (task.type === 'milestone') {
        const endDate = task.end_date ? new Date(task.end_date + 'T00:00:00') : null;
        const pct = task.percent_complete || 0;
        if (pct === 100) return 'complete';
        if (endDate && endDate < today) return 'overdue';
        if (endDate) {
            const twoWeeks = new Date(today);
            twoWeeks.setDate(twoWeeks.getDate() + 14);
            if (endDate <= twoWeeks) return 'upcoming';
        }
        return 'active';
    }

    const endDate = new Date(task.end_date + 'T00:00:00');
    const pct = task.percent_complete || 0;
    const isComplete = pct === 100;

    if (isComplete) return 'complete';
    if (endDate < today) return 'overdue';

    const twoWeeks = new Date(today);
    twoWeeks.setDate(twoWeeks.getDate() + 14);
    if (endDate <= twoWeeks) return 'upcoming';

    return 'active';
}

// Compute hours from a time entry (end_time - start_time)
function getEntryHours(te) {
    if (te.hours != null) return te.hours;
    if (te.start_time && te.end_time) {
        return (new Date(te.end_time) - new Date(te.start_time)) / 3600000;
    }
    return 0;
}

// Extract a YYYY-MM-DD date string from a time entry
function getEntryDate(te) {
    if (te.date) return te.date;
    if (te.start_time) return te.start_time.slice(0, 10);
    if (te.start_date) return te.start_date;
    if (te.end_date) return te.end_date;
    return null;
}

// Get the user/resource ID from a time entry
function getEntryUserId(te) {
    return te.user_id || te.resource_id;
}

function getISOWeek(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
    const yearStart = new Date(d.getFullYear(), 0, 4);
    const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    return `${d.getFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function getWeekLabel(isoWeek) {
    const [year, wStr] = isoWeek.split('-W');
    const jan4 = new Date(parseInt(year), 0, 4);
    const dayOfWeek = jan4.getDay() || 7;
    const mondayOfW1 = new Date(jan4);
    mondayOfW1.setDate(jan4.getDate() - dayOfWeek + 1);
    const monday = new Date(mondayOfW1);
    monday.setDate(monday.getDate() + (parseInt(wStr) - 1) * 7);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${months[monday.getMonth()]} ${monday.getDate()}`;
}

// ---------------------------------------------------------------------------
// Render — Summary Tab
// ---------------------------------------------------------------------------
function renderSummary() {
    const tasks = STATE.tasks;
    const timeEntries = STATE.timeEntries;

    let nComplete = 0, nOverdue = 0, nUpcoming = 0;
    const overdueTasks = [];

    tasks.forEach(t => {
        const cls = classifyTask(t);
        if (cls === 'complete') nComplete++;
        else if (cls === 'overdue') { nOverdue++; overdueTasks.push(t); }
        else if (cls === 'upcoming') nUpcoming++;
    });

    let totalHours = 0;
    timeEntries.forEach(te => {
        if (!isExcludedMember(getEntryUserId(te))) totalHours += getEntryHours(te);
    });

    document.getElementById('stat-total').textContent = tasks.length;
    document.getElementById('stat-complete').textContent = nComplete;
    document.getElementById('stat-overdue').textContent = nOverdue;
    document.getElementById('stat-upcoming').textContent = nUpcoming;
    document.getElementById('stat-hours').textContent = Math.round(totalHours).toLocaleString();

    renderTeamChart(timeEntries);
    renderMemberLeaderboard(timeEntries);
    renderOverdueSpotlight(overdueTasks);
}

function renderTeamChart(timeEntries) {
    const teamHours = {};

    timeEntries.forEach(te => {
        const rid = getEntryUserId(te);
        if (isExcludedMember(rid)) return;
        const member = STATE.members[rid];
        const team = member ? member.team : 'UNKNOWN';
        teamHours[team] = (teamHours[team] || 0) + getEntryHours(te);
    });

    const sorted = Object.entries(teamHours).sort((a, b) => b[1] - a[1]);
    const maxHours = sorted.length > 0 ? sorted[0][1] : 1;

    const container = document.getElementById('team-chart');
    container.innerHTML = '';

    if (sorted.length === 0) {
        container.innerHTML = '<div class="empty-state">No time data available</div>';
        return;
    }

    sorted.forEach(([team, hours], i) => {
        const pct = Math.max(5, (hours / maxHours) * 100);
        const color = TEAM_COLORS[i % TEAM_COLORS.length];
        const row = document.createElement('div');
        row.className = 'chart-bar-row';
        row.innerHTML = `
      <span class="chart-bar-label">${esc(team)}</span>
      <div class="chart-bar-track">
        <div class="chart-bar-fill" style="width:${pct}%;background:${color}"></div>
      </div>
      <span class="chart-bar-value">${Math.round(hours)}h</span>
    `;
        container.appendChild(row);
    });
}

function renderMemberLeaderboard(timeEntries) {
    const memberHours = {};

    timeEntries.forEach(te => {
        const rid = getEntryUserId(te);
        if (isExcludedMember(rid)) return;
        memberHours[rid] = (memberHours[rid] || 0) + getEntryHours(te);
    });

    const sorted = Object.entries(memberHours).sort((a, b) => b[1] - a[1]);
    const container = document.getElementById('member-leaderboard');
    container.innerHTML = '';

    if (sorted.length === 0) {
        container.innerHTML = '<div class="empty-state">No time data available</div>';
        return;
    }

    sorted.slice(0, 15).forEach(([rid, hours], i) => {
        const member = STATE.members[rid] || { fullName: `User ${rid}`, team: '?' };
        const div = document.createElement('div');
        div.className = 'leaderboard-item';
        div.innerHTML = `
      <span class="leaderboard-rank">${i + 1}</span>
      <span class="leaderboard-name">${esc(member.fullName)}
        <span class="leaderboard-team">${esc(member.team)}</span>
      </span>
      <span class="leaderboard-hours">${Math.round(hours)}h</span>
    `;
        container.appendChild(div);
    });
}

function renderOverdueSpotlight(overdueTasks) {
    const container = document.getElementById('overdue-spotlight');
    const card = document.getElementById('overdue-spotlight-card');
    container.innerHTML = '';

    if (overdueTasks.length === 0) {
        card.classList.add('hidden');
        return;
    }
    card.classList.remove('hidden');

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    overdueTasks.sort((a, b) => new Date(a.end_date) - new Date(b.end_date));

    overdueTasks.slice(0, 20).forEach(t => {
        const endDate = new Date(t.end_date + 'T00:00:00');
        const daysOver = Math.ceil((today - endDate) / 86400000);
        const groupName = STATE.groupMap[t.parent_group_id]?.name || '';

        const div = document.createElement('div');
        div.className = 'overdue-item';
        div.innerHTML = `
      <div>
        <div class="overdue-item-name">${esc(t.name)}</div>
        <div class="overdue-item-info">Due: ${t.end_date}${groupName ? ` · ${esc(groupName)}` : ''}</div>
      </div>
      <div class="overdue-item-days">${daysOver}d overdue</div>
    `;
        container.appendChild(div);
    });
}

// ---------------------------------------------------------------------------
// Render — Weekly Hours View
// ---------------------------------------------------------------------------
let currentWeekOffset = 0; // 0 = this week, -1 = last week, etc.

function getWeekBounds(offset) {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const dayOfWeek = now.getDay() || 7; // Mon=1..Sun=7
    const monday = new Date(now);
    monday.setDate(now.getDate() - dayOfWeek + 1 + (offset * 7));
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    return { monday, sunday };
}

function formatDate(d) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${months[d.getMonth()]} ${d.getDate()}`;
}

function renderWeekView() {
    const { monday, sunday } = getWeekBounds(currentWeekOffset);
    const monStr = monday.toISOString().slice(0, 10);
    const sunStr = sunday.toISOString().slice(0, 10);

    // Update week label
    const label = currentWeekOffset === 0 ? 'This Week' :
        currentWeekOffset === -1 ? 'Last Week' :
            `${formatDate(monday)} — ${formatDate(sunday)}`;
    document.getElementById('week-label').textContent =
        `${label}  (${formatDate(monday)} — ${formatDate(sunday)})`;

    // Filter time entries for this week, excluding DLA/RESEARCH
    const weekEntries = STATE.timeEntries.filter(te => {
        const d = getEntryDate(te);
        if (!d || d < monStr || d > sunStr) return false;
        return !isExcludedMember(getEntryUserId(te));
    });

    // Aggregate per member and per team
    const memberHours = {};
    const teamHours = {};
    const taskHours = {};
    let totalHours = 0;

    weekEntries.forEach(te => {
        const hours = getEntryHours(te);
        if (hours === 0) return;
        totalHours += hours;

        const rid = getEntryUserId(te);
        const member = STATE.members[rid];
        const name = member ? member.fullName : `User ${rid}`;
        const team = member ? member.team : 'UNKNOWN';
        if (!memberHours[rid]) memberHours[rid] = { name, team, hours: 0 };
        memberHours[rid].hours += hours;

        teamHours[team] = (teamHours[team] || 0) + hours;

        const taskId = te.task_id;
        const task = STATE.taskMap[taskId];
        const taskName = task ? task.name : `Task ${taskId}`;
        const taskEndDate = task ? task.end_date : null;
        if (!taskHours[taskId]) {
            taskHours[taskId] = {
                id: taskId,
                name: taskName,
                hours: 0,
                members: new Set(),
                endDate: taskEndDate,
                breakdown: {}
            };
        }
        taskHours[taskId].hours += hours;
        taskHours[taskId].members.add(name);

        if (!taskHours[taskId].breakdown[name]) taskHours[taskId].breakdown[name] = 0;
        taskHours[taskId].breakdown[name] += hours;
    });

    // Save for modal access
    STATE.weekTaskData = taskHours;

    // Stats
    document.getElementById('week-total-hours').textContent = Math.round(totalHours).toLocaleString();
    document.getElementById('week-active-members').textContent = Object.keys(memberHours).length;
    document.getElementById('week-tasks-worked').textContent = Object.keys(taskHours).length;

    // Weekly team bar chart
    const weekTeamChartContainer = document.getElementById('week-team-chart');
    const sortedTeams = Object.entries(teamHours).sort((a, b) => b[1] - a[1]);
    const maxTeamHours = sortedTeams.length > 0 ? sortedTeams[0][1] : 1;
    weekTeamChartContainer.innerHTML = '';
    if (sortedTeams.length === 0) {
        weekTeamChartContainer.innerHTML = '<div class="empty-state">No data</div>';
    } else {
        sortedTeams.forEach(([team, hours], i) => {
            const pct = Math.max(5, (hours / maxTeamHours) * 100);
            const color = TEAM_COLORS[i % TEAM_COLORS.length];
            const row = document.createElement('div');
            row.className = 'chart-bar-row';
            row.innerHTML = `
              <span class="chart-bar-label">${esc(team)}</span>
              <div class="chart-bar-track">
                <div class="chart-bar-fill" style="width:${pct}%;background:${color}"></div>
              </div>
              <span class="chart-bar-value">${Math.round(hours)}h</span>
            `;
            weekTeamChartContainer.appendChild(row);
        });
    }

    // Top performers (sorted desc)
    const sortedMembers = Object.values(memberHours).sort((a, b) => b.hours - a.hours);
    const topContainer = document.getElementById('week-top-performers');
    const bottomContainer = document.getElementById('week-bottom-performers');

    if (sortedMembers.length === 0) {
        topContainer.innerHTML = '<div class="empty-state">No hours logged this week</div>';
        bottomContainer.innerHTML = '<div class="empty-state">No hours logged this week</div>';
    } else {
        const top10 = sortedMembers.slice(0, 10);
        topContainer.innerHTML = '';
        top10.forEach((m, i) => {
            const div = document.createElement('div');
            div.className = 'leaderboard-row';
            div.innerHTML = `
              <span class="leaderboard-rank">${i + 1}</span>
              <span class="leaderboard-name">${esc(m.name)} <span class="resource-badge">${esc(m.team)}</span></span>
              <span class="leaderboard-hours">${Math.round(m.hours)}h</span>
            `;
            topContainer.appendChild(div);
        });

        // Bottom performers (lowest non-zero, ranked 1-10)
        const bottom10 = sortedMembers.slice(-10).reverse();
        bottomContainer.innerHTML = '';
        bottom10.forEach((m, i) => {
            const div = document.createElement('div');
            div.className = 'leaderboard-row';
            div.innerHTML = `
              <span class="leaderboard-rank">${i + 1}</span>
              <span class="leaderboard-name">${esc(m.name)} <span class="resource-badge">${esc(m.team)}</span></span>
              <span class="leaderboard-hours">${Math.round(m.hours)}h</span>
            `;
            bottomContainer.appendChild(div);
        });
    }

    // Active tasks — sorted by due date, with time-left badges relative to end of week
    const tasksContainer = document.getElementById('week-active-tasks');
    const sortedTasks = Object.values(taskHours).sort((a, b) => {
        if (!a.endDate && !b.endDate) return 0;
        if (!a.endDate) return 1;
        if (!b.endDate) return -1;
        return a.endDate.localeCompare(b.endDate);
    });

    if (sortedTasks.length === 0) {
        tasksContainer.innerHTML = '<div class="empty-state">No tasks worked on this week</div>';
    } else {
        tasksContainer.innerHTML = '';
        sortedTasks.forEach(t => {
            let dueBadge = '';
            if (t.endDate) {
                const due = new Date(t.endDate + 'T00:00:00');
                const diffDays = Math.round((due - monday) / 86400000);
                if (diffDays < 0) {
                    dueBadge = `<span class="status-badge status-overdue">${Math.abs(diffDays)}d overdue</span>`;
                } else if (diffDays === 0) {
                    dueBadge = `<span class="status-badge status-overdue">Due this week</span>`;
                } else if (diffDays <= 14) {
                    dueBadge = `<span class="status-badge status-upcoming">${diffDays}d left</span>`;
                } else {
                    dueBadge = `<span class="status-badge status-active">${diffDays}d left</span>`;
                }
            }
            const div = document.createElement('div');
            div.className = 'task-item task-clickable';
            div.onclick = (e) => toggleTaskBreakdown(t.id, e);
            const dueDateStr = t.endDate ? (() => {
                const d = new Date(t.endDate + 'T00:00:00');
                const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
                return `Due: ${months[d.getMonth()]} ${d.getDate()}`;
            })() : '';
            div.innerHTML = `
              <div class="task-main-row">
                <div>
                    <div class="task-name">${esc(t.name)}</div>
                    <div class="task-group">${dueDateStr ? `<span style="color:var(--text-secondary);margin-right:8px">${dueDateStr}</span>` : ''}${Array.from(t.members).slice(0, 5).map(n => esc(n)).join(', ')}${t.members.size > 5 ? ` +${t.members.size - 5} more` : ''}</div>
                </div>
                <div style="display:flex;gap:8px;align-items:center">
                    ${dueBadge}
                    <span class="status-badge">${Math.round(t.hours)}h</span>
                </div>
              </div>
              <div id="breakdown-${t.id}" class="task-breakdown hidden"></div>
            `;
            tasksContainer.appendChild(div);
        });
    }
}

// ---------------------------------------------------------------------------
// Inline Expansion Logic
// ---------------------------------------------------------------------------
function toggleTaskBreakdown(taskId, event) {
    // Prevent triggering if clicking inside the breakdown itself
    if (event.target.closest('.task-breakdown')) return;

    const breakdownEl = document.getElementById(`breakdown-${taskId}`);
    if (!breakdownEl) return;

    const isHidden = breakdownEl.classList.contains('hidden');

    // Close other open breakdowns (optional, but keeps UI clean)
    document.querySelectorAll('.task-breakdown').forEach(el => {
        if (el.id !== `breakdown-${taskId}`) el.classList.add('hidden');
    });

    if (isHidden) {
        // Populate if empty
        if (breakdownEl.innerHTML.trim() === '') {
            const taskData = STATE.weekTaskData[taskId];
            if (taskData) {
                const sortedMembers = Object.entries(taskData.breakdown).sort((a, b) => b[1] - a[1]);
                if (sortedMembers.length === 0) {
                    breakdownEl.innerHTML = '<div class="empty-state-sm">No hours recorded.</div>';
                } else {
                    let html = '<div class="breakdown-list">';
                    sortedMembers.forEach(([name, hours]) => {
                        html += `
                            <div class="breakdown-row-inline">
                                <div class="breakdown-name">${esc(name)}</div>
                                <div class="breakdown-hours-container">
                                    <span class="breakdown-hours">${Math.round(hours * 10) / 10}h</span>
                                </div>
                            </div>
                        `;
                    });
                    html += '</div>';
                    breakdownEl.innerHTML = html;
                }
            }
        }
        breakdownEl.classList.remove('hidden');
    } else {
        breakdownEl.classList.add('hidden');
    }
}

// ---------------------------------------------------------------------------
// Render — Tasks Tab
// ---------------------------------------------------------------------------
function renderTasks() {
    const tasks = STATE.tasks;
    const overdue = [], upcoming = [], all = [];

    tasks.forEach(t => {
        const cls = classifyTask(t);
        t._status = cls;
        all.push(t);
        if (cls === 'overdue') overdue.push(t);
        else if (cls === 'upcoming') upcoming.push(t);
    });

    const dateSorter = (a, b) => (a.end_date || '').localeCompare(b.end_date || '');
    overdue.sort(dateSorter);
    upcoming.sort(dateSorter);
    all.sort(dateSorter);

    renderTaskList('overdue-list', overdue);
    renderTaskList('upcoming-list', upcoming);
    renderTaskList('all-list', all);

    const teams = new Set();
    Object.values(STATE.members).forEach(m => {
        if (!EXCLUDED_TEAMS.has(m.team)) teams.add(m.team);
    });
    const filterEl = document.getElementById('task-team-filter');
    filterEl.innerHTML = '<option value="">All Teams</option>';
    Array.from(teams).sort().forEach(t => {
        filterEl.innerHTML += `<option value="${esc(t)}">${esc(t)}</option>`;
    });

    document.getElementById('task-search').addEventListener('input', filterTasks);
    filterEl.addEventListener('change', filterTasks);
}

function renderTaskList(containerId, tasks) {
    const container = document.getElementById(containerId);
    container.innerHTML = '';

    if (tasks.length === 0) {
        container.innerHTML = '<div class="empty-state">No tasks found</div>';
        return;
    }

    tasks.forEach(t => {
        const groupName = STATE.groupMap[t.parent_group_id]?.name || '';
        const resources = (t.resources || []).map(r => {
            const parsed = parseMemberName(r.name);
            return parsed ? parsed.fullName : r.name;
        });

        const statusLabel = {
            overdue: 'Overdue',
            upcoming: 'Due Soon',
            complete: 'Complete',
            active: 'Active',
        }[t._status] || 'Active';

        const statusClass = `status-${t._status}`;

        const teamNames = (t.resources || []).map(r => {
            const parsed = parseMemberName(r.name);
            return parsed ? parsed.team : '';
        });

        const div = document.createElement('div');
        div.className = 'task-item';
        div.dataset.teams = teamNames.join(',').toUpperCase();
        div.dataset.taskName = (t.name || '').toLowerCase();
        div.innerHTML = `
      <div class="task-main-row">
          <div>
            <div class="task-name">${esc(t.name)}</div>
            ${groupName ? `<div class="task-group">${esc(groupName)}</div>` : ''}
          </div>
          <div class="task-dates">${t.start_date || '?'} → ${t.end_date || '?'}</div>
          <div class="task-resources">
            ${resources.slice(0, 3).map(r => `<span class="resource-badge">${esc(r)}</span>`).join('')}
            ${resources.length > 3 ? `<span class="resource-badge">+${resources.length - 3}</span>` : ''}
          </div>
          <span class="status-badge ${statusClass}">${statusLabel}</span>
      </div>
    `;
        container.appendChild(div);
    });
}

function filterTasks() {
    const search = (document.getElementById('task-search').value || '').toLowerCase();
    const teamFilter = (document.getElementById('task-team-filter').value || '').toUpperCase();

    document.querySelectorAll('.task-item').forEach(el => {
        const nameMatch = !search || (el.dataset.taskName || '').includes(search);
        const teamMatch = !teamFilter || (el.dataset.teams || '').includes(teamFilter);
        el.style.display = (nameMatch && teamMatch) ? '' : 'none';
    });
}

// ---------------------------------------------------------------------------
// Render — Hours Tab (Pivot Tables)
// ---------------------------------------------------------------------------
function renderHours() {
    const timeEntries = STATE.timeEntries;

    const memberWeekly = {};
    const teamWeekly = {};
    const taskWeekly = {};
    const allWeeks = new Set();

    // memberWeekly keyed by "TEAM|memberName" for grouped display
    timeEntries.forEach(te => {
        const hours = getEntryHours(te);
        if (hours === 0) return;

        const rid = getEntryUserId(te);
        if (isExcludedMember(rid)) return;

        const dateStr = getEntryDate(te);
        if (!dateStr) return;
        const week = getISOWeek(dateStr);
        allWeeks.add(week);

        const member = STATE.members[rid];
        const memberName = member ? member.fullName : `User ${rid}`;
        const team = member ? member.team : 'UNKNOWN';
        const memberKey = `${team}|${memberName}`;

        if (!memberWeekly[memberKey]) memberWeekly[memberKey] = { _team: team };
        memberWeekly[memberKey][week] = (memberWeekly[memberKey][week] || 0) + hours;

        if (!teamWeekly[team]) teamWeekly[team] = {};
        teamWeekly[team][week] = (teamWeekly[team][week] || 0) + hours;

        const taskId = te.task_id;
        const task = STATE.taskMap[taskId];
        const taskName = task ? task.name : `Task ${taskId}`;

        if (!taskWeekly[taskName]) taskWeekly[taskName] = {};
        taskWeekly[taskName][week] = (taskWeekly[taskName][week] || 0) + hours;
    });

    const weeks = Array.from(allWeeks).sort();

    renderGroupedPivotTable('table-member-hours', memberWeekly, weeks);
    renderPivotTable('table-team-hours', teamWeekly, weeks, 'Team');
    renderPivotTable('table-task-hours', taskWeekly, weeks, 'Task');

    renderWeekView();
}

function renderPivotTable(tableId, data, weeks, rowLabel) {
    const table = document.getElementById(tableId);
    table.innerHTML = '';

    const rows = Object.keys(data).sort();

    if (rows.length === 0 || weeks.length === 0) {
        table.innerHTML = '<tbody><tr><td class="empty-state" colspan="99">No data available</td></tr></tbody>';
        return;
    }

    const thead = document.createElement('thead');
    let headerHtml = `<tr><th>${esc(rowLabel)}</th>`;
    weeks.forEach(w => {
        headerHtml += `<th>${getWeekLabel(w)}</th>`;
    });
    headerHtml += '<th>Total</th></tr>';
    thead.innerHTML = headerHtml;
    table.appendChild(thead);

    const tbody = document.createElement('tbody');

    rows.forEach(rowName => {
        let rowTotal = 0;
        let rowHtml = `<tr><td>${esc(rowName)}</td>`;

        weeks.forEach(w => {
            const val = data[rowName][w] || 0;
            rowTotal += val;
            const display = val === 0 ? '-' : Math.round(val);
            const cls = val === 0 ? ' class="hours-cell-zero"' : '';
            rowHtml += `<td${cls}>${display}</td>`;
        });

        rowHtml += `<td>${Math.round(rowTotal)}</td></tr>`;
        tbody.innerHTML += rowHtml;
    });

    // Footer totals
    const tfoot = document.createElement('tfoot');
    let footHtml = '<tr><td><strong>Total</strong></td>';
    let grandTotal = 0;

    weeks.forEach(w => {
        let colTotal = 0;
        rows.forEach(r => { colTotal += (data[r][w] || 0); });
        grandTotal += colTotal;
        footHtml += `<td><strong>${Math.round(colTotal)}</strong></td>`;
    });
    footHtml += `<td><strong>${Math.round(grandTotal)}</strong></td></tr>`;
    tfoot.innerHTML = footHtml;
    table.appendChild(tfoot);

    table.appendChild(tbody);
}

function renderGroupedPivotTable(tableId, data, weeks) {
    const table = document.getElementById(tableId);
    table.innerHTML = '';

    const keys = Object.keys(data);
    if (keys.length === 0 || weeks.length === 0) {
        table.innerHTML = '<tbody><tr><td class="empty-state" colspan="99">No data available</td></tr></tbody>';
        return;
    }

    // Group by team
    const teamGroups = {};
    keys.forEach(key => {
        const team = data[key]._team || 'UNKNOWN';
        if (!teamGroups[team]) teamGroups[team] = [];
        teamGroups[team].push(key);
    });

    // Sort teams, then members within each team
    const sortedTeamNames = Object.keys(teamGroups).sort();

    const thead = document.createElement('thead');
    let headerHtml = '<tr><th>Team / Member</th>';
    weeks.forEach(w => { headerHtml += `<th>${getWeekLabel(w)}</th>`; });
    headerHtml += '<th>Total</th></tr>';
    thead.innerHTML = headerHtml;
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    let grandTotal = 0;

    sortedTeamNames.forEach(team => {
        const memberKeys = teamGroups[team].sort((a, b) => {
            const nameA = a.split('|')[1] || a;
            const nameB = b.split('|')[1] || b;
            return nameA.localeCompare(nameB);
        });

        // Team subtotal row
        let teamTotal = 0;
        let teamRowHtml = `<tr class="pivot-team-header"><td><strong>${esc(team)}</strong></td>`;
        weeks.forEach(w => {
            let weekTeamTotal = 0;
            memberKeys.forEach(k => { weekTeamTotal += (data[k][w] || 0); });
            teamTotal += weekTeamTotal;
            teamRowHtml += `<td><strong>${weekTeamTotal === 0 ? '-' : Math.round(weekTeamTotal)}</strong></td>`;
        });
        teamRowHtml += `<td><strong>${Math.round(teamTotal)}</strong></td></tr>`;
        grandTotal += teamTotal;
        tbody.innerHTML += teamRowHtml;

        // Member rows
        memberKeys.forEach(key => {
            const memberName = key.split('|')[1] || key;
            let rowTotal = 0;
            let rowHtml = `<tr><td style="padding-left:24px">${esc(memberName)}</td>`;
            weeks.forEach(w => {
                const val = data[key][w] || 0;
                rowTotal += val;
                const display = val === 0 ? '-' : Math.round(val);
                const cls = val === 0 ? ' class="hours-cell-zero"' : '';
                rowHtml += `<td${cls}>${display}</td>`;
            });
            rowHtml += `<td>${Math.round(rowTotal)}</td></tr>`;
            tbody.innerHTML += rowHtml;
        });
    });

    // Footer
    const tfoot = document.createElement('tfoot');
    let footHtml = '<tr><td><strong>Grand Total</strong></td>';
    let footGrandTotal = 0;
    weeks.forEach(w => {
        let colTotal = 0;
        keys.forEach(k => { colTotal += (data[k][w] || 0); });
        footGrandTotal += colTotal;
        footHtml += `<td><strong>${Math.round(colTotal)}</strong></td>`;
    });
    footHtml += `<td><strong>${Math.round(footGrandTotal)}</strong></td></tr>`;
    tfoot.innerHTML = footHtml;
    table.appendChild(tfoot);
    table.appendChild(tbody);
}

// ---------------------------------------------------------------------------
// Navigation / Tab Switching
// ---------------------------------------------------------------------------
function initNavigation() {
    document.querySelectorAll('.nav-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
        });
    });

    document.querySelectorAll('.sub-tabs').forEach(group => {
        group.querySelectorAll('.sub-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                group.querySelectorAll('.sub-tab').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');

                const parent = group.parentElement;
                parent.querySelectorAll('.subtab-content').forEach(c => c.classList.remove('active'));
                const target = parent.querySelector(`#subtab-${btn.dataset.subtab}`);
                if (target) target.classList.add('active');
            });
        });
    });

    // Week navigation
    document.getElementById('week-prev')?.addEventListener('click', () => {
        currentWeekOffset--;
        renderWeekView();
    });
    document.getElementById('week-next')?.addEventListener('click', () => {
        currentWeekOffset++;
        renderWeekView();
    });
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------
function esc(str) {
    const d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
}

function setLoadingStatus(msg) {
    const el = document.getElementById('loading-status');
    if (el) el.textContent = msg;
}

function showError(msg) {
    document.getElementById('loading-overlay').classList.add('hidden');
    document.getElementById('error-message').textContent = msg;
    document.getElementById('error-overlay').classList.remove('hidden');
}

function hideError() {
    document.getElementById('error-overlay').classList.add('hidden');
}

function formatTimestamp(isoStr) {
    if (!isoStr) return 'never';
    const d = new Date(isoStr);
    return d.toLocaleString();
}

// ---------------------------------------------------------------------------
// Populate dashboard from data object
// ---------------------------------------------------------------------------
function populateDashboard(data) {
    STATE.project = data.project;
    STATE.tasks = data.tasks || [];
    STATE.groups = data.groups || [];
    STATE.timeEntries = data.timeEntries || [];
    STATE.fetchedAt = data.fetchedAt;

    processData();

    document.getElementById('project-name').textContent =
        data.project?.name || `Project ${PROJECT_ID}`;
    document.getElementById('last-updated').textContent =
        `Data from: ${formatTimestamp(data.fetchedAt)}`;

    renderSummary();
    renderTasks();
    renderHours();

    document.getElementById('loading-overlay').classList.add('hidden');
    hideError();
    document.getElementById('app').classList.remove('hidden');
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------
async function loadData() {
    try {
        const result = await loadCachedData();

        if (result.cached && result.data) {
            setLoadingStatus('Rendering dashboard…');
            populateDashboard(result.data);
        } else {
            // No cache — trigger a refresh
            setLoadingStatus('No cached data. Fetching from TeamGantt…');
            const refreshResult = await triggerRefresh();
            if (refreshResult.data) {
                populateDashboard(refreshResult.data);
            } else {
                showError('Refresh completed but no data returned.');
            }
        }
    } catch (err) {
        console.error('Failed to load data:', err);
        showError(err.message || 'Failed to load data. Click Refresh to try again.');
    }
}

async function refreshData() {
    const btn = document.getElementById('btn-refresh');
    btn.disabled = true;
    btn.textContent = '⏳';

    try {
        document.getElementById('app').classList.add('hidden');
        document.getElementById('loading-overlay').classList.remove('hidden');
        setLoadingStatus('Refreshing data from TeamGantt…');

        const result = await triggerRefresh();
        if (result.data) {
            populateDashboard(result.data);
        } else {
            showError('Refresh completed but no data returned.');
        }
    } catch (err) {
        console.error('Refresh failed:', err);
        showError(err.message || 'Refresh failed.');
        // Try to reload from cache
        try {
            const cached = await loadCachedData();
            if (cached.cached && cached.data) {
                populateDashboard(cached.data);
            }
        } catch (_) {
            // ignore
        }
    } finally {
        btn.disabled = false;
        btn.textContent = '↻';
    }
}

// Boot
document.addEventListener('DOMContentLoaded', () => {
    initNavigation();

    // Wire up refresh button
    document.getElementById('btn-refresh').addEventListener('click', refreshData);

    loadData();
});

// ---------------------------------------------------------------------------
// Task Modal Logic
// ---------------------------------------------------------------------------
function showTaskBreakdown(taskId) {
    console.log('showTaskBreakdown called for:', taskId);
    if (!STATE.weekTaskData || !STATE.weekTaskData[taskId]) {
        console.error('No data found for task:', taskId);
        return;
    }
    const task = STATE.weekTaskData[taskId];

    document.getElementById('modal-title').textContent = task.name;
    const body = document.getElementById('modal-body');
    body.innerHTML = '';

    const breakdown = Object.entries(task.breakdown || {})
        .sort((a, b) => b[1] - a[1]); // Sort by hours descending

    breakdown.forEach(([member, hours]) => {
        const row = document.createElement('div');
        row.className = 'breakdown-row';
        row.innerHTML = `
            <span class="breakdown-name">${esc(member)}</span>
            <span class="breakdown-hours">${hours.toFixed(1)}h</span>
        `;
        body.appendChild(row);
    });

    const modal = document.getElementById('task-modal');
    modal.classList.add('active');
}

function closeModal() {
    const modal = document.getElementById('task-modal');
    modal.classList.remove('active');
}

// Close modal when clicking outside
document.getElementById('task-modal').addEventListener('click', (e) => {
    if (e.target.id === 'task-modal') closeModal();
});

// ESC key to close
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
});
