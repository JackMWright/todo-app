const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const { Pool } = require('pg');

console.log('DATABASE_URL:', process.env.DATABASE_URL ? 'SET' : 'NOT SET');

// ── Process-level safety nets ──────────────────────────────────────────────
process.on('uncaughtException',  err => console.error('Uncaught exception:',   err));
process.on('unhandledRejection', err => console.error('Unhandled rejection:',  err));

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

// ── Database ───────────────────────────────────────────────────────────────
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Prevent pool errors (e.g. dropped connections) from crashing the process
pool.on('error', err => console.error('Database pool error:', err.message));

async function query(sql, params = []) {
  try {
    const { rows } = await pool.query(sql, params);
    return rows;
  } catch (err) {
    console.error('DB query error:', err.message, '\nSQL:', sql);
    throw err;
  }
}

// ── Schema ─────────────────────────────────────────────────────────────────
async function createTables() {
  const tables = [
    ['personal_tasks', `
      CREATE TABLE IF NOT EXISTS personal_tasks (
        id       SERIAL PRIMARY KEY,
        owner    TEXT NOT NULL,
        text     TEXT NOT NULL,
        done     BOOLEAN NOT NULL DEFAULT FALSE,
        category TEXT,
        urgent   BOOLEAN NOT NULL DEFAULT FALSE,
        added_by TEXT NOT NULL,
        time     TEXT,
        date     TEXT
      )
    `],
    ['team_tasks', `
      CREATE TABLE IF NOT EXISTS team_tasks (
        id       SERIAL PRIMARY KEY,
        text     TEXT NOT NULL,
        done     BOOLEAN NOT NULL DEFAULT FALSE,
        by       TEXT NOT NULL,
        category TEXT,
        urgent   BOOLEAN NOT NULL DEFAULT FALSE
      )
    `],
    ['schedule_items', `
      CREATE TABLE IF NOT EXISTS schedule_items (
        id          SERIAL PRIMARY KEY,
        date        TEXT NOT NULL,
        text        TEXT NOT NULL,
        type        TEXT NOT NULL,
        by          TEXT NOT NULL,
        members     TEXT NOT NULL DEFAULT '[]',
        time        TEXT,
        description TEXT
      )
    `],
    ['shorts', `
      CREATE TABLE IF NOT EXISTS shorts (
        id       SERIAL PRIMARY KEY,
        title    TEXT NOT NULL,
        notes    TEXT NOT NULL DEFAULT '',
        used     BOOLEAN NOT NULL DEFAULT FALSE,
        date     TEXT,
        assignee TEXT,
        added_by TEXT NOT NULL
      )
    `],
    ['long_forms', `
      CREATE TABLE IF NOT EXISTS long_forms (
        id       SERIAL PRIMARY KEY,
        title    TEXT NOT NULL,
        notes    TEXT NOT NULL DEFAULT '',
        used     BOOLEAN NOT NULL DEFAULT FALSE,
        date     TEXT,
        assignee TEXT,
        added_by TEXT NOT NULL
      )
    `],
    ['goals', `
      CREATE TABLE IF NOT EXISTS goals (
        id       SERIAL PRIMARY KEY,
        text     TEXT NOT NULL,
        done     BOOLEAN NOT NULL DEFAULT FALSE,
        period   TEXT NOT NULL,
        added_by TEXT NOT NULL
      )
    `],
    ['recurring_schedule', `
      CREATE TABLE IF NOT EXISTS recurring_schedule (
        id          SERIAL PRIMARY KEY,
        day_of_week INT NOT NULL,
        time        TEXT,
        type        TEXT NOT NULL,
        text        TEXT NOT NULL,
        members     TEXT NOT NULL DEFAULT '[]',
        alternate   BOOLEAN NOT NULL DEFAULT FALSE,
        description TEXT
      )
    `],
    ['recurring_schedule_skips', `
      CREATE TABLE IF NOT EXISTS recurring_schedule_skips (
        template_id INT NOT NULL,
        date        TEXT NOT NULL,
        PRIMARY KEY (template_id, date)
      )
    `],
    ['recurring_team_tasks', `
      CREATE TABLE IF NOT EXISTS recurring_team_tasks (
        id   SERIAL PRIMARY KEY,
        text TEXT NOT NULL
      )
    `],
    ['recurring_team_completions', `
      CREATE TABLE IF NOT EXISTS recurring_team_completions (
        template_id  INT NOT NULL,
        week_iso     TEXT NOT NULL,
        completed_by TEXT,
        PRIMARY KEY (template_id, week_iso)
      )
    `],
    ['user_sessions', `
      CREATE TABLE IF NOT EXISTS user_sessions (
        id          SERIAL PRIMARY KEY,
        user_name   TEXT NOT NULL,
        login_time  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        logout_time TIMESTAMPTZ,
        duration    INT
      )
    `],
    ['idea_bank', `
      CREATE TABLE IF NOT EXISTS idea_bank (
        id           SERIAL PRIMARY KEY,
        title        TEXT NOT NULL,
        description  TEXT NOT NULL DEFAULT '',
        category     TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'New',
        submitted_by TEXT NOT NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `],
    ['out_of_office', `
      CREATE TABLE IF NOT EXISTS out_of_office (
        id         SERIAL PRIMARY KEY,
        person     TEXT NOT NULL,
        start_date TEXT NOT NULL,
        end_date   TEXT NOT NULL,
        added_by   TEXT NOT NULL
      )
    `],
    ['xp_events', `
      CREATE TABLE IF NOT EXISTS xp_events (
        id         SERIAL PRIMARY KEY,
        user_name  TEXT NOT NULL,
        points     INT NOT NULL,
        reason     TEXT NOT NULL,
        task_id    INT,
        date       TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `],
  ];

  for (const [name, sql] of tables) {
    console.log(`createTables: creating ${name}...`);
    try {
      await pool.query(sql);
      console.log(`createTables: ${name} OK`);
    } catch (err) {
      console.error(`createTables: FAILED on ${name}:`, err.message);
      throw err;
    }
  }

  // Migrations — add columns to existing tables if missing
  const migrations = [
    ["shorts.members",            `ALTER TABLE shorts          ADD COLUMN IF NOT EXISTS members     TEXT NOT NULL DEFAULT '[]'`],
    ["long_forms.members",        `ALTER TABLE long_forms      ADD COLUMN IF NOT EXISTS members     TEXT NOT NULL DEFAULT '[]'`],
    ["schedule_items.description", `ALTER TABLE schedule_items ADD COLUMN IF NOT EXISTS description TEXT`],
  ];
  for (const [name, sql] of migrations) {
    try { await pool.query(sql); console.log(`migration: ${name} OK`); }
    catch (err) { console.error(`migration: ${name} FAILED:`, err.message); }
  }
}

// ── In-memory state ────────────────────────────────────────────────────────
const userTasks                = {};
const teamTasks                = [];
const scheduleItems            = [];
const shortsLog                = [];
const longFormsLog             = [];
const goals                    = [];
const recurringSchedule        = [];
const recurringSkips           = [];   // [{ templateId, date }]
const recurringTeamTasks       = [];
const recurringTeamCompletions = [];   // [{ templateId, weekIso, completedBy }]
const userSessions             = [];   // [{ id, userName, loginTime, logoutTime, duration }]
const ideas                    = [];   // [{ id, title, description, category, status, submittedBy, createdAt }]
const oooEntries               = [];
const xpEvents                 = [];   // [{ id, userName, points, reason, taskId, date, createdAt }]
const clients                  = new Map();

async function loadData() {
  console.log('loadData: starting...');

  console.log('loadData: querying personal_tasks...');
  try {
    const rows = await query('SELECT * FROM personal_tasks ORDER BY id');
    console.log(`loadData: personal_tasks OK (${rows.length} rows)`);
    rows.forEach(r => {
      if (!userTasks[r.owner]) userTasks[r.owner] = [];
      userTasks[r.owner].push({ id: r.id, text: r.text, done: r.done, category: r.category, urgent: r.urgent, addedBy: r.added_by, time: r.time, date: r.date });
    });
  } catch (err) { console.error('loadData: FAILED on personal_tasks:', err.message); }

  console.log('loadData: querying team_tasks...');
  try {
    const rows = await query('SELECT * FROM team_tasks ORDER BY id');
    console.log(`loadData: team_tasks OK (${rows.length} rows)`);
    rows.forEach(r => {
      teamTasks.push({ id: r.id, text: r.text, done: r.done, by: r.by, category: r.category, urgent: r.urgent });
    });
  } catch (err) { console.error('loadData: FAILED on team_tasks:', err.message); }

  console.log('loadData: querying schedule_items...');
  try {
    const rows = await query('SELECT * FROM schedule_items ORDER BY id');
    console.log(`loadData: schedule_items OK (${rows.length} rows)`);
    rows.forEach(r => {
      scheduleItems.push({ id: r.id, date: r.date, text: r.text, type: r.type, by: r.by, members: JSON.parse(r.members), time: r.time, description: r.description || '' });
    });
  } catch (err) { console.error('loadData: FAILED on schedule_items:', err.message); }

  console.log('loadData: querying shorts...');
  try {
    const rows = await query('SELECT * FROM shorts ORDER BY id');
    console.log(`loadData: shorts OK (${rows.length} rows)`);
    rows.forEach(r => {
      shortsLog.push({ id: r.id, title: r.title, notes: r.notes, used: r.used, date: r.date, assignee: r.assignee, addedBy: r.added_by, members: r.members ? JSON.parse(r.members) : [] });
    });
  } catch (err) { console.error('loadData: FAILED on shorts:', err.message); }

  console.log('loadData: querying long_forms...');
  try {
    const rows = await query('SELECT * FROM long_forms ORDER BY id');
    console.log(`loadData: long_forms OK (${rows.length} rows)`);
    rows.forEach(r => {
      longFormsLog.push({ id: r.id, title: r.title, notes: r.notes, used: r.used, date: r.date, assignee: r.assignee, addedBy: r.added_by, members: r.members ? JSON.parse(r.members) : [] });
    });
  } catch (err) { console.error('loadData: FAILED on long_forms:', err.message); }

  console.log('loadData: querying goals...');
  try {
    const rows = await query('SELECT * FROM goals ORDER BY id');
    console.log(`loadData: goals OK (${rows.length} rows)`);
    rows.forEach(r => {
      goals.push({ id: r.id, text: r.text, done: r.done, period: r.period, addedBy: r.added_by });
    });
  } catch (err) { console.error('loadData: FAILED on goals:', err.message); }

  console.log('loadData: querying recurring_schedule...');
  try {
    const rows = await query('SELECT * FROM recurring_schedule ORDER BY day_of_week, time NULLS LAST, id');
    console.log(`loadData: recurring_schedule OK (${rows.length} rows)`);
    rows.forEach(r => {
      recurringSchedule.push({
        id: r.id, dayOfWeek: r.day_of_week, time: r.time, type: r.type,
        text: r.text, members: JSON.parse(r.members), alternate: r.alternate,
        description: r.description || ''
      });
    });
  } catch (err) { console.error('loadData: FAILED on recurring_schedule:', err.message); }

  console.log('loadData: querying recurring_schedule_skips...');
  try {
    const rows = await query('SELECT * FROM recurring_schedule_skips');
    console.log(`loadData: recurring_schedule_skips OK (${rows.length} rows)`);
    rows.forEach(r => recurringSkips.push({ templateId: r.template_id, date: r.date }));
  } catch (err) { console.error('loadData: FAILED on recurring_schedule_skips:', err.message); }

  console.log('loadData: querying recurring_team_tasks...');
  try {
    const rows = await query('SELECT * FROM recurring_team_tasks ORDER BY id');
    console.log(`loadData: recurring_team_tasks OK (${rows.length} rows)`);
    rows.forEach(r => recurringTeamTasks.push({ id: r.id, text: r.text }));
  } catch (err) { console.error('loadData: FAILED on recurring_team_tasks:', err.message); }

  console.log('loadData: querying recurring_team_completions...');
  try {
    const rows = await query('SELECT * FROM recurring_team_completions');
    console.log(`loadData: recurring_team_completions OK (${rows.length} rows)`);
    rows.forEach(r => recurringTeamCompletions.push({
      templateId: r.template_id, weekIso: r.week_iso, completedBy: r.completed_by
    }));
  } catch (err) { console.error('loadData: FAILED on recurring_team_completions:', err.message); }

  console.log('loadData: querying idea_bank...');
  try {
    const rows = await query('SELECT * FROM idea_bank ORDER BY id');
    console.log(`loadData: idea_bank OK (${rows.length} rows)`);
    rows.forEach(r => ideas.push({
      id: r.id, title: r.title, description: r.description,
      category: r.category, status: r.status,
      submittedBy: r.submitted_by,
      createdAt: r.created_at.toISOString()
    }));
  } catch (err) { console.error('loadData: FAILED on idea_bank:', err.message); }

  console.log('loadData: querying xp_events...');
  try {
    const rows = await query('SELECT * FROM xp_events ORDER BY id');
    console.log(`loadData: xp_events OK (${rows.length} rows)`);
    rows.forEach(r => xpEvents.push({
      id: r.id, userName: r.user_name, points: r.points, reason: r.reason,
      taskId: r.task_id, date: r.date, createdAt: r.created_at.toISOString()
    }));
  } catch (err) { console.error('loadData: FAILED on xp_events:', err.message); }

  console.log('loadData: querying user_sessions (last 30 days)...');
  try {
    const rows = await query(`
      SELECT * FROM user_sessions
      WHERE login_time > NOW() - INTERVAL '30 days'
      ORDER BY login_time
    `);
    console.log(`loadData: user_sessions OK (${rows.length} rows)`);
    rows.forEach(r => userSessions.push({
      id: r.id,
      userName: r.user_name,
      loginTime: r.login_time.toISOString(),
      logoutTime: r.logout_time ? r.logout_time.toISOString() : null,
      duration: r.duration
    }));
  } catch (err) { console.error('loadData: FAILED on user_sessions:', err.message); }

  console.log('loadData: querying out_of_office...');
  try {
    const rows = await query('SELECT * FROM out_of_office ORDER BY id');
    console.log(`loadData: out_of_office OK (${rows.length} rows)`);
    rows.forEach(r => {
      oooEntries.push({ id: r.id, person: r.person, startDate: r.start_date, endDate: r.end_date });
    });
  } catch (err) { console.error('loadData: FAILED on out_of_office:', err.message); }

  console.log('loadData: done');
}

// ── Session lifecycle ──────────────────────────────────────────────────────
// On boot, cap any orphaned sessions (server crashed mid-session) at +5 min
async function recoverOrphanedSessions() {
  try {
    const rows = await query(`
      UPDATE user_sessions
      SET logout_time = login_time + INTERVAL '5 minutes',
          duration    = 300
      WHERE logout_time IS NULL
      RETURNING id
    `);
    if (rows.length) console.log(`recoverOrphanedSessions: capped ${rows.length} orphaned session(s)`);
  } catch (err) { console.error('recoverOrphanedSessions: FAILED:', err.message); }
}

// Close any open session(s) for a user, both in DB and in memory.
async function closeOpenSessions(userName) {
  const now = new Date();
  await query(`
    UPDATE user_sessions
    SET logout_time = $1,
        duration    = GREATEST(EXTRACT(EPOCH FROM ($1::timestamptz - login_time))::int, 0)
    WHERE user_name = $2 AND logout_time IS NULL
  `, [now, userName]);
  for (const s of userSessions) {
    if (s.userName === userName && !s.logoutTime) {
      s.logoutTime = now.toISOString();
      s.duration = Math.max(0, Math.round((now - new Date(s.loginTime)) / 1000));
    }
  }
}

// Open a fresh session. Returns the session object pushed into in-memory state.
async function openSession(userName) {
  const now = new Date();
  const [row] = await query(
    'INSERT INTO user_sessions (user_name, login_time) VALUES ($1, $2) RETURNING id',
    [userName, now]
  );
  const session = {
    id: row.id, userName, loginTime: now.toISOString(),
    logoutTime: null, duration: null,
  };
  userSessions.push(session);
  return session;
}

// ── Recurring seed ─────────────────────────────────────────────────────────
async function seedRecurring() {
  try {
    const [{ count: schedCount }] = await query('SELECT COUNT(*)::int AS count FROM recurring_schedule');
    if (schedCount === 0) {
      console.log('seedRecurring: seeding recurring_schedule...');
      // Schedule template seed: { dayOfWeek (0=Sun..6=Sat), time, type, text, members, alternate }
      const seeds = [
        // Sunday
        { dayOfWeek: 0, time: '13:00', type: 'Shorts',    text: 'Trivia Short', members: ['Joe'],          alternate: false },
        { dayOfWeek: 0, time: '15:30', type: 'Shorts',    text: 'Clips Short',  members: ['Jack', 'Joe'],   alternate: true  },
        { dayOfWeek: 0, time: '18:00', type: 'Shorts',    text: 'Trivia Short', members: ['Jack'],         alternate: false },
        // Monday
        { dayOfWeek: 1, time: '10:00', type: 'Meetings',  text: 'Owners Meeting', members: [],              alternate: false },
        { dayOfWeek: 1, time: '12:00', type: 'Graphics',  text: 'Graphic',        members: ['Jack', 'Joe'], alternate: true  },
        { dayOfWeek: 1, time: '13:00', type: 'Shorts',    text: 'Trivia Short',   members: ['Joe'],         alternate: false },
        { dayOfWeek: 1, time: '13:00', type: 'Shorts',    text: 'Trivia Short',   members: ['Jack'],        alternate: false },
        { dayOfWeek: 1, time: '15:30', type: 'Shorts',    text: 'Clips Short',    members: ['Jack', 'Joe'], alternate: true  },
        { dayOfWeek: 1, time: '19:00', type: 'Meetings',  text: 'Livestream',     members: [],              alternate: false },
        // Tuesday
        { dayOfWeek: 2, time: '10:00', type: 'Meetings',  text: 'Team Meeting',     members: [],              alternate: false },
        { dayOfWeek: 2, time: '12:00', type: 'Graphics',  text: 'Graphic',          members: ['Jack', 'Joe'], alternate: true  },
        { dayOfWeek: 2, time: null,    type: 'Long Form', text: 'Long Form Shoot',  members: ['Jack', 'Joe'], alternate: false },
        { dayOfWeek: 2, time: null,    type: 'Long Form', text: 'Long Form Release',members: [],              alternate: false },
        { dayOfWeek: 2, time: '13:00', type: 'Shorts',    text: 'Trivia Short',     members: ['Joe'],         alternate: false },
        { dayOfWeek: 2, time: '15:30', type: 'Shorts',    text: 'Clips Short',      members: ['Jack', 'Joe'], alternate: true  },
        { dayOfWeek: 2, time: '18:00', type: 'Shorts',    text: 'Trivia Short',     members: ['Jack'],        alternate: false },
        // Wednesday
        { dayOfWeek: 3, time: '10:00', type: 'Meetings',  text: 'AI Meeting',        members: [],              alternate: false },
        { dayOfWeek: 3, time: null,    type: 'Long Form', text: 'Long Form Shoot',   members: ['Jack', 'Joe'], alternate: false },
        { dayOfWeek: 3, time: null,    type: 'Long Form', text: 'Long Form Release', members: [],              alternate: false },
        { dayOfWeek: 3, time: '13:00', type: 'Shorts',    text: 'Trivia Short',      members: ['Joe'],         alternate: false },
        { dayOfWeek: 3, time: '15:30', type: 'Shorts',    text: 'Clips Short',       members: ['Jack', 'Joe'], alternate: true  },
        { dayOfWeek: 3, time: '18:00', type: 'Shorts',    text: 'Trivia Short',      members: ['Jack'],        alternate: false },
        // Thursday
        { dayOfWeek: 4, time: '12:00', type: 'Graphics',  text: 'Graphic',      members: ['Jack', 'Joe'], alternate: true  },
        { dayOfWeek: 4, time: '13:00', type: 'Shorts',    text: 'Trivia Short', members: ['Joe'],         alternate: false },
        { dayOfWeek: 4, time: '15:30', type: 'Shorts',    text: 'Clips Short',  members: ['Jack', 'Joe'], alternate: true  },
        { dayOfWeek: 4, time: '18:00', type: 'Shorts',    text: 'Trivia Short', members: ['Jack'],        alternate: false },
        { dayOfWeek: 4, time: '19:00', type: 'Meetings',  text: 'Livestream',   members: [],              alternate: false },
        // Friday
        { dayOfWeek: 5, time: '12:00', type: 'Graphics',  text: 'Graphic',           members: ['Jack', 'Joe'], alternate: true  },
        { dayOfWeek: 5, time: null,    type: 'Long Form', text: 'Long Form Shoot',   members: ['Jack', 'Joe'], alternate: false },
        { dayOfWeek: 5, time: null,    type: 'Long Form', text: 'Long Form Release', members: [],              alternate: false },
        { dayOfWeek: 5, time: '13:00', type: 'Shorts',    text: 'Trivia Short',      members: ['Joe'],         alternate: false },
        { dayOfWeek: 5, time: '15:30', type: 'Shorts',    text: 'Clips Short',       members: ['Jack', 'Joe'], alternate: true  },
        { dayOfWeek: 5, time: '18:00', type: 'Shorts',    text: 'Trivia Short',      members: ['Jack'],        alternate: false },
        // Saturday
        { dayOfWeek: 6, time: '12:00', type: 'Graphics',  text: 'Graphic',           members: ['Jack', 'Joe'], alternate: true  },
        { dayOfWeek: 6, time: null,    type: 'Long Form', text: 'Long Form Release', members: [],              alternate: false },
        { dayOfWeek: 6, time: '13:00', type: 'Shorts',    text: 'Trivia Short',      members: ['Joe'],         alternate: false },
        { dayOfWeek: 6, time: '18:00', type: 'Shorts',    text: 'Trivia Short',      members: ['Jack'],        alternate: false },
      ];
      for (const t of seeds) {
        await query(
          'INSERT INTO recurring_schedule (day_of_week,time,type,text,members,alternate) VALUES ($1,$2,$3,$4,$5,$6)',
          [t.dayOfWeek, t.time, t.type, t.text, JSON.stringify(t.members), t.alternate]
        );
      }
      console.log(`seedRecurring: seeded ${seeds.length} recurring schedule rows`);
    }

    const [{ count: taskCount }] = await query('SELECT COUNT(*)::int AS count FROM recurring_team_tasks');
    if (taskCount === 0) {
      console.log('seedRecurring: seeding recurring_team_tasks...');
      const taskSeeds = [
        '10–15 cold sponsorship outreaches',
        'Ad market research for team/owners meeting prep',
        'Data analysis review for team/owners meeting prep',
      ];
      for (const text of taskSeeds) {
        await query('INSERT INTO recurring_team_tasks (text) VALUES ($1)', [text]);
      }
      console.log(`seedRecurring: seeded ${taskSeeds.length} recurring team tasks`);
    }
  } catch (err) {
    console.error('seedRecurring: FAILED:', err.message);
  }
}

// ── Constants & helpers ────────────────────────────────────────────────────
const ALLOWED_USERS   = ['Jack', 'Joe', 'Becca'];
const TASK_TYPES      = ['Shorts', 'Long Form', 'Graphics', 'Meetings', 'Shoots'];
const TASK_CATEGORIES = ['Create Short', 'Edit Short', 'Create Graphic', 'Edit Long Form'];
const GOAL_PERIODS    = ['weekly', 'monthly', 'yearly'];
const IDEA_CATEGORIES = ['Show Format', 'Short Form', 'Long Form', 'Game', 'Sponsorship', 'Other'];
const IDEA_STATUSES   = ['New', 'In Development', 'Tested', 'Shipped', 'Parked'];

function onlineUsers() {
  return [...clients.values()].filter(u => !u.idle).map(u => u.name);
}
function send(ws, msg) {
  if (ws.readyState !== ws.OPEN) return;
  try { ws.send(JSON.stringify(msg)); } catch (err) { console.error('send() error:', err.message); }
}
function broadcast(msg) {
  for (const ws of wss.clients) {
    if (ws.readyState !== ws.OPEN) continue;
    try { ws.send(JSON.stringify(msg)); } catch (err) { console.error('broadcast() error:', err.message); }
  }
}
function broadcastAllPersonal() { broadcast({ type: 'all_personal_tasks', tasks: userTasks }); }
function broadcastXP(highlight = null) {
  broadcast({ type: 'xp_events', events: xpEvents, highlight });
}

function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function prevDayISO(iso) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Remove any existing daily_goal / streak_bonus events for (user, date)
// from DB and memory.
async function clearGoalAndStreakEvents(userName, date) {
  const rows = await query(
    "DELETE FROM xp_events WHERE user_name=$1 AND date=$2 AND reason IN ('daily_goal','streak_bonus') RETURNING id",
    [userName, date]
  );
  const removed = new Set(rows.map(r => r.id));
  for (let i = xpEvents.length - 1; i >= 0; i--) {
    if (removed.has(xpEvents[i].id)) xpEvents.splice(i, 1);
  }
}

async function insertXP(userName, points, reason, taskId, date) {
  const [row] = await query(
    'INSERT INTO xp_events (user_name, points, reason, task_id, date) VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at',
    [userName, points, reason, taskId, date]
  );
  const ev = {
    id: row.id, userName, points, reason, taskId: taskId || null,
    date, createdAt: row.created_at.toISOString(),
  };
  xpEvents.push(ev);
  return ev;
}

// After a complete event is added/removed, recompute today's daily-goal
// and streak-bonus events for the user. Returns total bonus points awarded
// (for animation/highlight purposes).
async function recomputeDailyAndStreak(userName, date) {
  await clearGoalAndStreakEvents(userName, date);
  const completes = xpEvents.filter(e =>
    e.userName === userName && e.date === date && e.reason === 'complete'
  ).length;
  let bonusAwarded = 0;
  if (completes >= 5) {
    await insertXP(userName, 25, 'daily_goal', null, date);
    bonusAwarded += 25;
    // Streak: count consecutive previous days with a daily_goal event.
    let streak = 1;
    let cursor = prevDayISO(date);
    while (xpEvents.some(e =>
      e.userName === userName && e.date === cursor && e.reason === 'daily_goal'
    )) {
      streak++;
      cursor = prevDayISO(cursor);
    }
    if (streak >= 2) {
      const bonus = (streak - 1) * 5;
      await insertXP(userName, bonus, 'streak_bonus', null, date);
      bonusAwarded += bonus;
    }
  }
  return bonusAwarded;
}

// Add a +10 complete event for (userName, taskId) on today's date and
// recompute daily/streak. Returns { complete: 10, bonus }.
async function awardCompletionXP(userName, taskId) {
  const date = todayISO();
  await insertXP(userName, 10, 'complete', taskId, date);
  const bonus = await recomputeDailyAndStreak(userName, date);
  return { complete: 10, bonus, date };
}

// Remove the complete event tied to taskId (if any) and recompute daily/streak
// for the day(s) affected.
async function revokeCompletionXP(taskId) {
  // Find the existing complete event(s) for this task in memory first
  // to know which (user, date) buckets we need to recompute.
  const buckets = new Set();
  for (const ev of xpEvents) {
    if (ev.reason === 'complete' && ev.taskId === taskId) {
      buckets.add(ev.userName + '|' + ev.date);
    }
  }
  const rows = await query(
    "DELETE FROM xp_events WHERE task_id=$1 AND reason='complete' RETURNING id",
    [taskId]
  );
  const removed = new Set(rows.map(r => r.id));
  for (let i = xpEvents.length - 1; i >= 0; i--) {
    if (removed.has(xpEvents[i].id)) xpEvents.splice(i, 1);
  }
  for (const key of buckets) {
    const [userName, date] = key.split('|');
    await recomputeDailyAndStreak(userName, date);
  }
}

// ── WebSocket handlers ─────────────────────────────────────────────────────
wss.on('error', err => console.error('WebSocket server error:', err.message));

wss.on('connection', (ws) => {
  console.log('WS: client connected');
  ws.on('error', err => console.error('WebSocket client error:', err.message));

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const user = clients.get(ws);

    try {
      switch (msg.type) {

        case 'login': {
          const name = (msg.name || '').trim();
          if (!ALLOWED_USERS.includes(name)) return;
          if (!userTasks[name]) userTasks[name] = [];
          clients.set(ws, { name, idle: false });

          // Time tracking: only one active session per user — close any prior, open a new one
          await closeOpenSessions(name);
          await openSession(name);

          console.log(`login: building init payload for ${name}`);
          console.log(`login: teamTasks        count=${teamTasks.length}`);
          console.log(`login: scheduleItems    count=${scheduleItems.length}`);
          console.log(`login: shortsLog        count=${shortsLog.length}`);
          console.log(`login: longFormsLog     count=${longFormsLog.length}`);
          console.log(`login: goals            count=${goals.length}`);
          console.log(`login: allPersonalTasks owners=${Object.keys(userTasks).join(',')}`);
          Object.entries(userTasks).forEach(([owner, tasks]) =>
            console.log(`login: userTasks[${owner}] count=${tasks.length}`)
          );

          console.log('login: serialising teamTasks...');
          JSON.stringify(teamTasks);
          console.log('login: serialising scheduleItems...');
          JSON.stringify(scheduleItems);
          console.log('login: serialising shortsLog...');
          JSON.stringify(shortsLog);
          console.log('login: serialising longFormsLog...');
          JSON.stringify(longFormsLog);
          console.log('login: serialising goals...');
          JSON.stringify(goals);
          console.log('login: serialising userTasks...');
          JSON.stringify(userTasks);
          console.log('login: all serialisations OK — sending init...');

          send(ws, { type: 'init', name, teamTasks, scheduleItems, shortsLog, longFormsLog, onlineUsers: onlineUsers(), allPersonalTasks: userTasks, goals, recurringSchedule, recurringSkips, recurringTeamTasks, recurringTeamCompletions, userSessions, ideas, oooEntries, xpEvents });
          console.log('login: init sent — broadcasting presence...');
          broadcast({ type: 'presence', onlineUsers: onlineUsers(), joined: name });
          broadcast({ type: 'sessions_updated', sessions: userSessions });
          console.log('login: done');
          break;
        }

        case 'idle': {
          if (!user) return;
          const c = clients.get(ws);
          if (!c || c.idle) return;
          c.idle = true;
          await closeOpenSessions(user.name);
          broadcast({ type: 'presence', onlineUsers: onlineUsers(), left: user.name });
          broadcast({ type: 'sessions_updated', sessions: userSessions });
          break;
        }

        case 'resume': {
          if (!user) return;
          const c = clients.get(ws);
          if (!c || !c.idle) return;
          c.idle = false;
          // Should not have an open session (idle closed it), but guard anyway
          await closeOpenSessions(user.name);
          await openSession(user.name);
          broadcast({ type: 'presence', onlineUsers: onlineUsers(), joined: user.name });
          broadcast({ type: 'sessions_updated', sessions: userSessions });
          break;
        }

        case 'add_personal': {
          if (!user) return;
          const text     = (msg.text || '').trim();
          if (!text) return;
          const category = TASK_CATEGORIES.includes(msg.category) ? msg.category : null;
          const urgent   = !!msg.urgent;
          const time     = (msg.time || '').trim() || null;
          const date     = (msg.date || '').trim() || null;
          const target   = ALLOWED_USERS.includes(msg.target) ? msg.target : user.name;
          if (target !== user.name && user.name !== 'Jack') return;
          if (!userTasks[target]) userTasks[target] = [];
          const [row] = await query(
            'INSERT INTO personal_tasks (owner,text,done,category,urgent,added_by,time,date) VALUES ($1,$2,FALSE,$3,$4,$5,$6,$7) RETURNING id',
            [target, text, category, urgent, user.name, time, date]
          );
          userTasks[target].push({ id: row.id, text, done: false, category, urgent, addedBy: user.name, time, date });
          broadcastAllPersonal();
          break;
        }

        case 'toggle_personal': {
          if (!user) return;
          const t = (userTasks[user.name] || []).find(t => t.id === msg.id);
          if (!t) return;
          await query('UPDATE personal_tasks SET done = NOT done WHERE id = $1', [msg.id]);
          t.done = !t.done;
          broadcastAllPersonal();
          // XP: award on transition to done, revoke on transition to not-done.
          if (t.done) {
            const award = await awardCompletionXP(user.name, t.id);
            broadcastXP({ userName: user.name, taskId: t.id, points: award.complete, bonus: award.bonus });
          } else {
            await revokeCompletionXP(t.id);
            broadcastXP();
          }
          break;
        }

        case 'delete_personal': {
          if (!user) return;
          const owner = ALLOWED_USERS.includes(msg.owner) ? msg.owner : user.name;
          await query('DELETE FROM personal_tasks WHERE id = $1 AND owner = $2', [msg.id, owner]);
          userTasks[owner] = (userTasks[owner] || []).filter(t => t.id !== msg.id);
          broadcastAllPersonal();
          // Clean up any XP earned for this task so totals stay auditable.
          await revokeCompletionXP(msg.id);
          broadcastXP();
          break;
        }

        case 'edit_personal': {
          if (!user) return;
          const t = (userTasks[user.name] || []).find(t => t.id === msg.id);
          if (!t) return;
          if (msg.text     !== undefined) t.text     = (msg.text || '').trim() || t.text;
          if (msg.urgent   !== undefined) t.urgent   = !!msg.urgent;
          if (msg.time     !== undefined) t.time     = (msg.time || '').trim() || null;
          if (msg.date     !== undefined) t.date     = (msg.date || '').trim() || null;
          if (msg.category !== undefined && TASK_CATEGORIES.includes(msg.category)) t.category = msg.category;
          await query(
            'UPDATE personal_tasks SET text=$1,urgent=$2,time=$3,date=$4,category=$5 WHERE id=$6 AND owner=$7',
            [t.text, t.urgent, t.time, t.date, t.category, msg.id, user.name]
          );
          broadcastAllPersonal();
          break;
        }

        case 'add_team': {
          if (!user) return;
          const text     = (msg.text || '').trim();
          if (!text) return;
          const category = TASK_CATEGORIES.includes(msg.category) ? msg.category : null;
          const urgent   = !!msg.urgent;
          const [row] = await query(
            'INSERT INTO team_tasks (text,done,by,category,urgent) VALUES ($1,FALSE,$2,$3,$4) RETURNING id',
            [text, user.name, category, urgent]
          );
          teamTasks.push({ id: row.id, text, done: false, by: user.name, category, urgent });
          broadcast({ type: 'team_tasks', tasks: teamTasks });
          break;
        }

        case 'toggle_team': {
          if (!user) return;
          const t = teamTasks.find(t => t.id === msg.id);
          if (!t) return;
          await query('UPDATE team_tasks SET done = NOT done WHERE id = $1', [msg.id]);
          t.done = !t.done;
          broadcast({ type: 'team_tasks', tasks: teamTasks });
          break;
        }

        case 'delete_team': {
          if (!user) return;
          await query('DELETE FROM team_tasks WHERE id = $1', [msg.id]);
          const idx = teamTasks.findIndex(t => t.id === msg.id);
          if (idx !== -1) teamTasks.splice(idx, 1);
          broadcast({ type: 'team_tasks', tasks: teamTasks });
          break;
        }

        case 'edit_team': {
          if (!user) return;
          const t = teamTasks.find(t => t.id === msg.id);
          if (!t) return;
          if (msg.text     !== undefined) t.text     = (msg.text || '').trim() || t.text;
          if (msg.urgent   !== undefined) t.urgent   = !!msg.urgent;
          if (msg.category !== undefined && TASK_CATEGORIES.includes(msg.category)) t.category = msg.category;
          await query(
            'UPDATE team_tasks SET text=$1,urgent=$2,category=$3 WHERE id=$4',
            [t.text, t.urgent, t.category, msg.id]
          );
          broadcast({ type: 'team_tasks', tasks: teamTasks });
          break;
        }

        case 'add_schedule': {
          if (!user) return;
          const text        = (msg.text || '').trim();
          const date        = (msg.date || '').trim();
          const type        = msg.taskType;
          const time        = (msg.time || '').trim() || null;
          const description = (msg.description || '').trim() || null;
          if (!text || !date || !TASK_TYPES.includes(type)) return;
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
          const members = Array.isArray(msg.members)
            ? msg.members.filter(m => ALLOWED_USERS.includes(m))
            : [];
          const [row] = await query(
            'INSERT INTO schedule_items (date,text,type,by,members,time,description) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
            [date, text, type, user.name, JSON.stringify(members), time, description]
          );
          scheduleItems.push({ id: row.id, date, text, type, by: user.name, members, time, description: description || '' });
          broadcast({ type: 'schedule_items', items: scheduleItems });
          let personalChanged = false;
          for (const member of members) {
            if (!userTasks[member]) userTasks[member] = [];
            const [pr] = await query(
              'INSERT INTO personal_tasks (owner,text,done,category,urgent,added_by,time,date) VALUES ($1,$2,FALSE,NULL,FALSE,$3,NULL,$4) RETURNING id',
              [member, text, user.name, date]
            );
            userTasks[member].push({ id: pr.id, text, done: false, category: null, urgent: false, addedBy: user.name, date, time: null });
            personalChanged = true;
          }
          if (personalChanged) broadcastAllPersonal();
          break;
        }

        case 'edit_schedule': {
          if (!user) return;
          const item = scheduleItems.find(i => i.id === msg.id);
          if (!item) return;
          if (msg.text        !== undefined) item.text        = (msg.text || '').trim() || item.text;
          if (msg.taskType    !== undefined && TASK_TYPES.includes(msg.taskType)) item.type = msg.taskType;
          if (msg.time        !== undefined) item.time        = (msg.time || '').trim() || null;
          if (msg.description !== undefined) item.description = (msg.description || '').trim();
          if (Array.isArray(msg.members)) item.members = msg.members.filter(m => ALLOWED_USERS.includes(m));
          await query(
            'UPDATE schedule_items SET text=$1,type=$2,time=$3,members=$4,description=$5 WHERE id=$6',
            [item.text, item.type, item.time, JSON.stringify(item.members), item.description || null, msg.id]
          );
          broadcast({ type: 'schedule_items', items: scheduleItems });
          break;
        }

        case 'delete_schedule': {
          if (!user) return;
          await query('DELETE FROM schedule_items WHERE id = $1', [msg.id]);
          const idx = scheduleItems.findIndex(i => i.id === msg.id);
          if (idx !== -1) scheduleItems.splice(idx, 1);
          broadcast({ type: 'schedule_items', items: scheduleItems });
          break;
        }

        case 'add_short': {
          if (!user) return;
          const title = (msg.title || '').trim();
          if (!title) return;
          const notes = (msg.notes || '').trim();
          const [row] = await query(
            'INSERT INTO shorts (title,notes,used,date,assignee,added_by,members) VALUES ($1,$2,FALSE,NULL,NULL,$3,$4) RETURNING id',
            [title, notes, user.name, '[]']
          );
          shortsLog.push({ id: row.id, title, notes, used: false, date: null, assignee: null, addedBy: user.name, members: [] });
          broadcast({ type: 'shorts_updated', shorts: shortsLog });
          break;
        }

        case 'toggle_short_used': {
          if (!user) return;
          const s = shortsLog.find(s => s.id === msg.id);
          if (!s) return;
          await query('UPDATE shorts SET used = NOT used WHERE id = $1', [msg.id]);
          s.used = !s.used;
          broadcast({ type: 'shorts_updated', shorts: shortsLog });
          break;
        }

        case 'update_short': {
          if (!user) return;
          const s = shortsLog.find(s => s.id === msg.id);
          if (!s) return;
          if (msg.title   !== undefined) s.title   = (msg.title || '').trim() || s.title;
          if (msg.notes   !== undefined) s.notes   = (msg.notes || '').trim();
          if (msg.date    !== undefined) s.date    = (msg.date && /^\d{4}-\d{2}-\d{2}$/.test(msg.date)) ? msg.date : null;
          if (Array.isArray(msg.members)) {
            s.members  = msg.members.filter(m => ALLOWED_USERS.includes(m));
            s.assignee = s.members[0] || null;
          }
          await query(
            'UPDATE shorts SET title=$1,notes=$2,date=$3,assignee=$4,members=$5 WHERE id=$6',
            [s.title, s.notes, s.date, s.assignee, JSON.stringify(s.members || []), msg.id]
          );
          broadcast({ type: 'shorts_updated', shorts: shortsLog });
          break;
        }

        case 'delete_short': {
          if (!user) return;
          await query('DELETE FROM shorts WHERE id = $1', [msg.id]);
          const idx = shortsLog.findIndex(s => s.id === msg.id);
          if (idx !== -1) shortsLog.splice(idx, 1);
          broadcast({ type: 'shorts_updated', shorts: shortsLog });
          break;
        }

        case 'add_long_form': {
          if (!user) return;
          const title = (msg.title || '').trim();
          if (!title) return;
          const notes = (msg.notes || '').trim();
          const [row] = await query(
            'INSERT INTO long_forms (title,notes,used,date,assignee,added_by,members) VALUES ($1,$2,FALSE,NULL,NULL,$3,$4) RETURNING id',
            [title, notes, user.name, '[]']
          );
          longFormsLog.push({ id: row.id, title, notes, used: false, date: null, assignee: null, addedBy: user.name, members: [] });
          broadcast({ type: 'long_forms_updated', longForms: longFormsLog });
          break;
        }

        case 'toggle_long_form_used': {
          if (!user) return;
          const lf = longFormsLog.find(lf => lf.id === msg.id);
          if (!lf) return;
          await query('UPDATE long_forms SET used = NOT used WHERE id = $1', [msg.id]);
          lf.used = !lf.used;
          broadcast({ type: 'long_forms_updated', longForms: longFormsLog });
          break;
        }

        case 'update_long_form': {
          if (!user) return;
          const lf = longFormsLog.find(lf => lf.id === msg.id);
          if (!lf) return;
          if (msg.title   !== undefined) lf.title   = (msg.title || '').trim() || lf.title;
          if (msg.notes   !== undefined) lf.notes   = (msg.notes || '').trim();
          if (msg.date    !== undefined) lf.date    = (msg.date && /^\d{4}-\d{2}-\d{2}$/.test(msg.date)) ? msg.date : null;
          if (Array.isArray(msg.members)) {
            lf.members  = msg.members.filter(m => ALLOWED_USERS.includes(m));
            lf.assignee = lf.members[0] || null;
          }
          await query(
            'UPDATE long_forms SET title=$1,notes=$2,date=$3,assignee=$4,members=$5 WHERE id=$6',
            [lf.title, lf.notes, lf.date, lf.assignee, JSON.stringify(lf.members || []), msg.id]
          );
          broadcast({ type: 'long_forms_updated', longForms: longFormsLog });
          break;
        }

        case 'delete_long_form': {
          if (!user) return;
          await query('DELETE FROM long_forms WHERE id = $1', [msg.id]);
          const idx = longFormsLog.findIndex(lf => lf.id === msg.id);
          if (idx !== -1) longFormsLog.splice(idx, 1);
          broadcast({ type: 'long_forms_updated', longForms: longFormsLog });
          break;
        }

        case 'add_goal': {
          if (!user) return;
          const text   = (msg.text || '').trim();
          const period = GOAL_PERIODS.includes(msg.period) ? msg.period : 'weekly';
          if (!text) return;
          const [row] = await query(
            'INSERT INTO goals (text,done,period,added_by) VALUES ($1,FALSE,$2,$3) RETURNING id',
            [text, period, user.name]
          );
          goals.push({ id: row.id, text, done: false, period, addedBy: user.name });
          broadcast({ type: 'goals_updated', goals });
          break;
        }

        case 'toggle_goal': {
          if (!user) return;
          const g = goals.find(g => g.id === msg.id);
          if (!g) return;
          await query('UPDATE goals SET done = NOT done WHERE id = $1', [msg.id]);
          g.done = !g.done;
          broadcast({ type: 'goals_updated', goals });
          break;
        }

        case 'delete_goal': {
          if (!user) return;
          await query('DELETE FROM goals WHERE id = $1', [msg.id]);
          const idx = goals.findIndex(g => g.id === msg.id);
          if (idx !== -1) goals.splice(idx, 1);
          broadcast({ type: 'goals_updated', goals });
          break;
        }

        case 'edit_recurring_schedule': {
          if (!user) return;
          const t = recurringSchedule.find(r => r.id === msg.id);
          if (!t) return;
          if (msg.text        !== undefined) t.text        = (msg.text || '').trim() || t.text;
          if (msg.type        !== undefined && TASK_TYPES.includes(msg.type)) t.type = msg.type;
          if (msg.time        !== undefined) t.time        = (msg.time || '').trim() || null;
          if (msg.description !== undefined) t.description = (msg.description || '').trim();
          if (Array.isArray(msg.members)) t.members = msg.members.filter(m => ALLOWED_USERS.includes(m));
          if (typeof msg.alternate === 'boolean') t.alternate = msg.alternate;
          await query(
            'UPDATE recurring_schedule SET text=$1,type=$2,time=$3,members=$4,alternate=$5,description=$6 WHERE id=$7',
            [t.text, t.type, t.time, JSON.stringify(t.members), t.alternate, t.description || null, msg.id]
          );
          broadcast({ type: 'recurring_schedule', items: recurringSchedule });
          break;
        }

        case 'delete_recurring_schedule': {
          if (!user) return;
          await query('DELETE FROM recurring_schedule_skips WHERE template_id = $1', [msg.id]);
          await query('DELETE FROM recurring_schedule WHERE id = $1', [msg.id]);
          const idx = recurringSchedule.findIndex(r => r.id === msg.id);
          if (idx !== -1) recurringSchedule.splice(idx, 1);
          for (let i = recurringSkips.length - 1; i >= 0; i--) {
            if (recurringSkips[i].templateId === msg.id) recurringSkips.splice(i, 1);
          }
          broadcast({ type: 'recurring_schedule', items: recurringSchedule });
          broadcast({ type: 'recurring_skips', skips: recurringSkips });
          break;
        }

        case 'skip_recurring_schedule': {
          if (!user) return;
          const date = (msg.date || '').trim();
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
          if (!recurringSchedule.find(r => r.id === msg.id)) return;
          await query(
            'INSERT INTO recurring_schedule_skips (template_id,date) VALUES ($1,$2) ON CONFLICT DO NOTHING',
            [msg.id, date]
          );
          if (!recurringSkips.find(s => s.templateId === msg.id && s.date === date)) {
            recurringSkips.push({ templateId: msg.id, date });
          }
          broadcast({ type: 'recurring_skips', skips: recurringSkips });
          break;
        }

        case 'toggle_recurring_team': {
          if (!user) return;
          const weekIso = (msg.weekIso || '').trim();
          if (!/^\d{4}-W\d{2}$/.test(weekIso)) return;
          if (!recurringTeamTasks.find(t => t.id === msg.id)) return;
          const existing = recurringTeamCompletions.findIndex(c => c.templateId === msg.id && c.weekIso === weekIso);
          if (existing !== -1) {
            await query('DELETE FROM recurring_team_completions WHERE template_id=$1 AND week_iso=$2', [msg.id, weekIso]);
            recurringTeamCompletions.splice(existing, 1);
          } else {
            await query(
              'INSERT INTO recurring_team_completions (template_id,week_iso,completed_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
              [msg.id, weekIso, user.name]
            );
            recurringTeamCompletions.push({ templateId: msg.id, weekIso, completedBy: user.name });
          }
          broadcast({ type: 'recurring_team_completions', completions: recurringTeamCompletions });
          break;
        }

        case 'add_idea': {
          if (!user) return;
          const title       = (msg.title || '').trim();
          const description = (msg.description || '').trim();
          const category    = IDEA_CATEGORIES.includes(msg.category) ? msg.category : 'Other';
          const status      = IDEA_STATUSES.includes(msg.status) ? msg.status : 'New';
          if (!title) return;
          const [row] = await query(
            'INSERT INTO idea_bank (title,description,category,status,submitted_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at',
            [title, description, category, status, user.name]
          );
          ideas.push({
            id: row.id, title, description, category, status,
            submittedBy: user.name, createdAt: row.created_at.toISOString()
          });
          broadcast({ type: 'ideas_updated', ideas });
          break;
        }

        case 'edit_idea': {
          if (!user) return;
          const idea = ideas.find(i => i.id === msg.id);
          if (!idea) return;
          if (msg.title       !== undefined) idea.title       = (msg.title || '').trim() || idea.title;
          if (msg.description !== undefined) idea.description = (msg.description || '').trim();
          if (msg.category    !== undefined && IDEA_CATEGORIES.includes(msg.category)) idea.category = msg.category;
          if (msg.status      !== undefined && IDEA_STATUSES.includes(msg.status))     idea.status   = msg.status;
          await query(
            'UPDATE idea_bank SET title=$1,description=$2,category=$3,status=$4 WHERE id=$5',
            [idea.title, idea.description, idea.category, idea.status, msg.id]
          );
          broadcast({ type: 'ideas_updated', ideas });
          break;
        }

        case 'delete_idea': {
          if (!user) return;
          await query('DELETE FROM idea_bank WHERE id = $1', [msg.id]);
          const idx = ideas.findIndex(i => i.id === msg.id);
          if (idx !== -1) ideas.splice(idx, 1);
          broadcast({ type: 'ideas_updated', ideas });
          break;
        }

        case 'add_ooo': {
          if (!user) return;
          if (!['Jack', 'Joe'].includes(user.name)) return;
          const startDate = (msg.startDate || '').trim();
          const endDate   = (msg.endDate   || '').trim();
          if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return;
          if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate))   return;
          if (endDate < startDate) return;
          const [row] = await query(
            'INSERT INTO out_of_office (person, start_date, end_date, added_by) VALUES ($1,$2,$3,$4) RETURNING id',
            [user.name, startDate, endDate, user.name]
          );
          oooEntries.push({ id: row.id, person: user.name, startDate, endDate });
          broadcast({ type: 'ooo_updated', entries: oooEntries });
          break;
        }

        case 'delete_ooo': {
          if (!user) return;
          const entry = oooEntries.find(e => e.id === msg.id);
          if (!entry) return;
          if (entry.person !== user.name) return;
          await query('DELETE FROM out_of_office WHERE id = $1', [msg.id]);
          const oooIdx = oooEntries.findIndex(e => e.id === msg.id);
          if (oooIdx !== -1) oooEntries.splice(oooIdx, 1);
          broadcast({ type: 'ooo_updated', entries: oooEntries });
          break;
        }
      }
    } catch (err) {
      console.error(`WS message error [${msg.type}]:`, err.message);
    }
  });

  ws.on('close', async () => {
    try {
      const user = clients.get(ws);
      clients.delete(ws);
      if (user) {
        console.log('WS: client disconnected:', user.name);
        // Time tracking: close session unless this user has another active connection
        const stillConnected = [...clients.values()].some(c => c.name === user.name);
        if (!stillConnected) {
          await closeOpenSessions(user.name);
          broadcast({ type: 'sessions_updated', sessions: userSessions });
        }
        broadcast({ type: 'presence', onlineUsers: onlineUsers(), left: user.name });
      }
    } catch (err) {
      console.error('WS close handler error:', err.message);
    }
  });
});

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

async function start() {
  await createTables();
  await seedRecurring();
  await recoverOrphanedSessions();
  await loadData();
  server.listen(PORT, () => console.log(`\n  Stadium Status Workplace → http://localhost:${PORT}\n`));
}

start().catch(err => { console.error('Failed to start:', err); process.exit(1); });
