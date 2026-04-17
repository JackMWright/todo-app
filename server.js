const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const { Pool } = require('pg');

console.log('DATABASE_URL:', process.env.DATABASE_URL ? 'SET' : 'NOT SET');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

// ── Database ───────────────────────────────────────────────────────────────
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function query(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  return rows;
}

// ── Schema ─────────────────────────────────────────────────────────────────
async function createTables() {
  await pool.query(`
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
    );
    CREATE TABLE IF NOT EXISTS team_tasks (
      id       SERIAL PRIMARY KEY,
      text     TEXT NOT NULL,
      done     BOOLEAN NOT NULL DEFAULT FALSE,
      by       TEXT NOT NULL,
      category TEXT,
      urgent   BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE TABLE IF NOT EXISTS schedule_items (
      id      SERIAL PRIMARY KEY,
      date    TEXT NOT NULL,
      text    TEXT NOT NULL,
      type    TEXT NOT NULL,
      by      TEXT NOT NULL,
      members TEXT NOT NULL DEFAULT '[]',
      time    TEXT
    );
    CREATE TABLE IF NOT EXISTS shorts (
      id       SERIAL PRIMARY KEY,
      title    TEXT NOT NULL,
      notes    TEXT NOT NULL DEFAULT '',
      used     BOOLEAN NOT NULL DEFAULT FALSE,
      date     TEXT,
      assignee TEXT,
      added_by TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS long_forms (
      id       SERIAL PRIMARY KEY,
      title    TEXT NOT NULL,
      notes    TEXT NOT NULL DEFAULT '',
      used     BOOLEAN NOT NULL DEFAULT FALSE,
      date     TEXT,
      assignee TEXT,
      added_by TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS goals (
      id       SERIAL PRIMARY KEY,
      text     TEXT NOT NULL,
      done     BOOLEAN NOT NULL DEFAULT FALSE,
      period   TEXT NOT NULL,
      added_by TEXT NOT NULL
    );
  `);
}

// ── In-memory state ────────────────────────────────────────────────────────
const userTasks     = {};
const teamTasks     = [];
const scheduleItems = [];
const shortsLog     = [];
const longFormsLog  = [];
const goals         = [];
const clients       = new Map();

async function loadData() {
  (await query('SELECT * FROM personal_tasks ORDER BY id')).forEach(r => {
    if (!userTasks[r.owner]) userTasks[r.owner] = [];
    userTasks[r.owner].push({ id: r.id, text: r.text, done: r.done, category: r.category, urgent: r.urgent, addedBy: r.added_by, time: r.time, date: r.date });
  });

  (await query('SELECT * FROM team_tasks ORDER BY id')).forEach(r => {
    teamTasks.push({ id: r.id, text: r.text, done: r.done, by: r.by, category: r.category, urgent: r.urgent });
  });

  (await query('SELECT * FROM schedule_items ORDER BY id')).forEach(r => {
    scheduleItems.push({ id: r.id, date: r.date, text: r.text, type: r.type, by: r.by, members: JSON.parse(r.members), time: r.time });
  });

  (await query('SELECT * FROM shorts ORDER BY id')).forEach(r => {
    shortsLog.push({ id: r.id, title: r.title, notes: r.notes, used: r.used, date: r.date, assignee: r.assignee, addedBy: r.added_by });
  });

  (await query('SELECT * FROM long_forms ORDER BY id')).forEach(r => {
    longFormsLog.push({ id: r.id, title: r.title, notes: r.notes, used: r.used, date: r.date, assignee: r.assignee, addedBy: r.added_by });
  });

  (await query('SELECT * FROM goals ORDER BY id')).forEach(r => {
    goals.push({ id: r.id, text: r.text, done: r.done, period: r.period, addedBy: r.added_by });
  });
}

// ── Constants & helpers ────────────────────────────────────────────────────
const ALLOWED_USERS   = ['Jack', 'Joe', 'Becca'];
const TASK_TYPES      = ['Shorts', 'Long Form', 'Graphics', 'Meetings', 'Shoots'];
const TASK_CATEGORIES = ['Create Short', 'Edit Short', 'Create Graphic', 'Edit Long Form'];
const GOAL_PERIODS    = ['weekly', 'monthly', 'yearly'];

function onlineUsers() { return [...clients.values()].map(u => u.name); }
function send(ws, msg) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); }
function broadcast(msg) { for (const ws of wss.clients) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); } }
function broadcastAllPersonal() { broadcast({ type: 'all_personal_tasks', tasks: userTasks }); }

// ── WebSocket handlers ─────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    (async () => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      const user = clients.get(ws);

      switch (msg.type) {

        case 'login': {
          const name = (msg.name || '').trim();
          if (!ALLOWED_USERS.includes(name)) return;
          if (!userTasks[name]) userTasks[name] = [];
          clients.set(ws, { name });
          send(ws, { type: 'init', name, teamTasks, scheduleItems, shortsLog, longFormsLog, onlineUsers: onlineUsers(), allPersonalTasks: userTasks, goals });
          broadcast({ type: 'presence', onlineUsers: onlineUsers(), joined: name });
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
          break;
        }

        case 'delete_personal': {
          if (!user) return;
          const owner = ALLOWED_USERS.includes(msg.owner) ? msg.owner : user.name;
          await query('DELETE FROM personal_tasks WHERE id = $1 AND owner = $2', [msg.id, owner]);
          userTasks[owner] = (userTasks[owner] || []).filter(t => t.id !== msg.id);
          broadcastAllPersonal();
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
          const text    = (msg.text || '').trim();
          const date    = (msg.date || '').trim();
          const type    = msg.taskType;
          const time    = (msg.time || '').trim() || null;
          if (!text || !date || !TASK_TYPES.includes(type)) return;
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
          const members = Array.isArray(msg.members)
            ? msg.members.filter(m => ALLOWED_USERS.includes(m))
            : [];
          const [row] = await query(
            'INSERT INTO schedule_items (date,text,type,by,members,time) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
            [date, text, type, user.name, JSON.stringify(members), time]
          );
          scheduleItems.push({ id: row.id, date, text, type, by: user.name, members, time });
          broadcast({ type: 'schedule_items', items: scheduleItems });
          let personalChanged = false;
          for (const member of members) {
            if (!userTasks[member]) userTasks[member] = [];
            const [pr] = await query(
              'INSERT INTO personal_tasks (owner,text,done,category,urgent,added_by,time,date) VALUES ($1,$2,FALSE,NULL,FALSE,$3,NULL,NULL) RETURNING id',
              [member, text, user.name]
            );
            userTasks[member].push({ id: pr.id, text, done: false, category: null, urgent: false, addedBy: user.name, date: null, time: null });
            personalChanged = true;
          }
          if (personalChanged) broadcastAllPersonal();
          break;
        }

        case 'edit_schedule': {
          if (!user) return;
          const item = scheduleItems.find(i => i.id === msg.id);
          if (!item) return;
          if (msg.text     !== undefined) item.text    = (msg.text || '').trim() || item.text;
          if (msg.taskType !== undefined && TASK_TYPES.includes(msg.taskType)) item.type = msg.taskType;
          if (msg.time     !== undefined) item.time    = (msg.time || '').trim() || null;
          if (Array.isArray(msg.members)) item.members = msg.members.filter(m => ALLOWED_USERS.includes(m));
          await query(
            'UPDATE schedule_items SET text=$1,type=$2,time=$3,members=$4 WHERE id=$5',
            [item.text, item.type, item.time, JSON.stringify(item.members), msg.id]
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
            'INSERT INTO shorts (title,notes,used,date,assignee,added_by) VALUES ($1,$2,FALSE,NULL,NULL,$3) RETURNING id',
            [title, notes, user.name]
          );
          shortsLog.push({ id: row.id, title, notes, used: false, date: null, assignee: null, addedBy: user.name });
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
          if (msg.title    !== undefined) s.title    = (msg.title || '').trim() || s.title;
          if (msg.notes    !== undefined) s.notes    = (msg.notes || '').trim();
          if (msg.date     !== undefined) s.date     = (msg.date && /^\d{4}-\d{2}-\d{2}$/.test(msg.date)) ? msg.date : null;
          if (msg.assignee !== undefined) s.assignee = ALLOWED_USERS.includes(msg.assignee) ? msg.assignee : null;
          await query(
            'UPDATE shorts SET title=$1,notes=$2,date=$3,assignee=$4 WHERE id=$5',
            [s.title, s.notes, s.date, s.assignee, msg.id]
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
            'INSERT INTO long_forms (title,notes,used,date,assignee,added_by) VALUES ($1,$2,FALSE,NULL,NULL,$3) RETURNING id',
            [title, notes, user.name]
          );
          longFormsLog.push({ id: row.id, title, notes, used: false, date: null, assignee: null, addedBy: user.name });
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
          if (msg.title    !== undefined) lf.title    = (msg.title || '').trim() || lf.title;
          if (msg.notes    !== undefined) lf.notes    = (msg.notes || '').trim();
          if (msg.date     !== undefined) lf.date     = (msg.date && /^\d{4}-\d{2}-\d{2}$/.test(msg.date)) ? msg.date : null;
          if (msg.assignee !== undefined) lf.assignee = ALLOWED_USERS.includes(msg.assignee) ? msg.assignee : null;
          await query(
            'UPDATE long_forms SET title=$1,notes=$2,date=$3,assignee=$4 WHERE id=$5',
            [lf.title, lf.notes, lf.date, lf.assignee, msg.id]
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
      }
    })().catch(err => console.error('WS handler error:', err));
  });

  ws.on('close', () => {
    const user = clients.get(ws);
    if (user) { clients.delete(ws); broadcast({ type: 'presence', onlineUsers: onlineUsers(), left: user.name }); }
  });
});

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

async function start() {
  await createTables();
  await loadData();
  server.listen(PORT, () => console.log(`\n  Stadium Status Workplace → http://localhost:${PORT}\n`));
}

start().catch(err => { console.error('Failed to start:', err); process.exit(1); });
