const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

// ── Database setup ─────────────────────────────────────────────────────────
fs.mkdirSync('./data', { recursive: true });
const db = new Database('./data/app.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS personal_tasks (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    owner    TEXT NOT NULL,
    text     TEXT NOT NULL,
    done     INTEGER NOT NULL DEFAULT 0,
    category TEXT,
    urgent   INTEGER NOT NULL DEFAULT 0,
    added_by TEXT NOT NULL,
    time     TEXT,
    date     TEXT
  );
  CREATE TABLE IF NOT EXISTS team_tasks (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    text     TEXT NOT NULL,
    done     INTEGER NOT NULL DEFAULT 0,
    by       TEXT NOT NULL,
    category TEXT,
    urgent   INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS schedule_items (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    date    TEXT NOT NULL,
    text    TEXT NOT NULL,
    type    TEXT NOT NULL,
    by      TEXT NOT NULL,
    members TEXT NOT NULL DEFAULT '[]',
    time    TEXT
  );
  CREATE TABLE IF NOT EXISTS shorts (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    title    TEXT NOT NULL,
    notes    TEXT NOT NULL DEFAULT '',
    used     INTEGER NOT NULL DEFAULT 0,
    date     TEXT,
    assignee TEXT,
    added_by TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS long_forms (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    title    TEXT NOT NULL,
    notes    TEXT NOT NULL DEFAULT '',
    used     INTEGER NOT NULL DEFAULT 0,
    date     TEXT,
    assignee TEXT,
    added_by TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS goals (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    text     TEXT NOT NULL,
    done     INTEGER NOT NULL DEFAULT 0,
    period   TEXT NOT NULL,
    added_by TEXT NOT NULL
  );
`);

// ── Prepared statements ────────────────────────────────────────────────────
const stmt = {
  // personal tasks
  insertPersonal:  db.prepare('INSERT INTO personal_tasks (owner,text,done,category,urgent,added_by,time,date) VALUES (?,?,0,?,?,?,?,?)'),
  togglePersonal:  db.prepare('UPDATE personal_tasks SET done = 1 - done WHERE id = ?'),
  deletePersonal:  db.prepare('DELETE FROM personal_tasks WHERE id = ? AND owner = ?'),
  editPersonal:    db.prepare('UPDATE personal_tasks SET text=?,urgent=?,time=?,date=?,category=? WHERE id = ? AND owner = ?'),
  // team tasks
  insertTeam:      db.prepare('INSERT INTO team_tasks (text,done,by,category,urgent) VALUES (?,0,?,?,?)'),
  toggleTeam:      db.prepare('UPDATE team_tasks SET done = 1 - done WHERE id = ?'),
  deleteTeam:      db.prepare('DELETE FROM team_tasks WHERE id = ?'),
  editTeam:        db.prepare('UPDATE team_tasks SET text=?,urgent=?,category=? WHERE id = ?'),
  // schedule items
  insertSchedule:  db.prepare('INSERT INTO schedule_items (date,text,type,by,members,time) VALUES (?,?,?,?,?,?)'),
  editSchedule:    db.prepare('UPDATE schedule_items SET text=?,type=?,time=?,members=? WHERE id = ?'),
  deleteSchedule:  db.prepare('DELETE FROM schedule_items WHERE id = ?'),
  // shorts
  insertShort:     db.prepare('INSERT INTO shorts (title,notes,used,date,assignee,added_by) VALUES (?,?,0,NULL,NULL,?)'),
  toggleShortUsed: db.prepare('UPDATE shorts SET used = 1 - used WHERE id = ?'),
  updateShort:     db.prepare('UPDATE shorts SET title=?,notes=?,date=?,assignee=? WHERE id = ?'),
  deleteShort:     db.prepare('DELETE FROM shorts WHERE id = ?'),
  // long forms
  insertLongForm:     db.prepare('INSERT INTO long_forms (title,notes,used,date,assignee,added_by) VALUES (?,?,0,NULL,NULL,?)'),
  toggleLongFormUsed: db.prepare('UPDATE long_forms SET used = 1 - used WHERE id = ?'),
  updateLongForm:     db.prepare('UPDATE long_forms SET title=?,notes=?,date=?,assignee=? WHERE id = ?'),
  deleteLongForm:     db.prepare('DELETE FROM long_forms WHERE id = ?'),
  // goals
  insertGoal:      db.prepare('INSERT INTO goals (text,done,period,added_by) VALUES (?,0,?,?)'),
  toggleGoal:      db.prepare('UPDATE goals SET done = 1 - done WHERE id = ?'),
  deleteGoal:      db.prepare('DELETE FROM goals WHERE id = ?'),
};

// ── Load data from DB into memory ──────────────────────────────────────────
const userTasks     = {};
const teamTasks     = [];
const scheduleItems = [];
const shortsLog     = [];
const longFormsLog  = [];
const goals         = [];
const clients       = new Map();

db.prepare('SELECT * FROM personal_tasks ORDER BY id').all().forEach(r => {
  if (!userTasks[r.owner]) userTasks[r.owner] = [];
  userTasks[r.owner].push({ id: r.id, text: r.text, done: !!r.done, category: r.category, urgent: !!r.urgent, addedBy: r.added_by, time: r.time, date: r.date });
});

db.prepare('SELECT * FROM team_tasks ORDER BY id').all().forEach(r => {
  teamTasks.push({ id: r.id, text: r.text, done: !!r.done, by: r.by, category: r.category, urgent: !!r.urgent });
});

db.prepare('SELECT * FROM schedule_items ORDER BY id').all().forEach(r => {
  scheduleItems.push({ id: r.id, date: r.date, text: r.text, type: r.type, by: r.by, members: JSON.parse(r.members), time: r.time });
});

db.prepare('SELECT * FROM shorts ORDER BY id').all().forEach(r => {
  shortsLog.push({ id: r.id, title: r.title, notes: r.notes, used: !!r.used, date: r.date, assignee: r.assignee, addedBy: r.added_by });
});

db.prepare('SELECT * FROM long_forms ORDER BY id').all().forEach(r => {
  longFormsLog.push({ id: r.id, title: r.title, notes: r.notes, used: !!r.used, date: r.date, assignee: r.assignee, addedBy: r.added_by });
});

db.prepare('SELECT * FROM goals ORDER BY id').all().forEach(r => {
  goals.push({ id: r.id, text: r.text, done: !!r.done, period: r.period, addedBy: r.added_by });
});

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
        const text = (msg.text || '').trim();
        if (!text) return;
        const category = TASK_CATEGORIES.includes(msg.category) ? msg.category : null;
        const urgent   = !!msg.urgent;
        const time     = (msg.time || '').trim() || null;
        const date     = (msg.date || '').trim() || null;
        const target   = ALLOWED_USERS.includes(msg.target) ? msg.target : user.name;
        if (target !== user.name && user.name !== 'Jack') return;
        if (!userTasks[target]) userTasks[target] = [];
        const id = Number(stmt.insertPersonal.run(target, text, category, urgent ? 1 : 0, user.name, time, date).lastInsertRowid);
        userTasks[target].push({ id, text, done: false, category, urgent, addedBy: user.name, time, date });
        broadcastAllPersonal();
        break;
      }

      case 'toggle_personal': {
        if (!user) return;
        const t = (userTasks[user.name] || []).find(t => t.id === msg.id);
        if (!t) return;
        stmt.togglePersonal.run(msg.id);
        t.done = !t.done;
        broadcastAllPersonal();
        break;
      }

      case 'delete_personal': {
        if (!user) return;
        const owner = ALLOWED_USERS.includes(msg.owner) ? msg.owner : user.name;
        stmt.deletePersonal.run(msg.id, owner);
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
        stmt.editPersonal.run(t.text, t.urgent ? 1 : 0, t.time, t.date, t.category, msg.id, user.name);
        broadcastAllPersonal();
        break;
      }

      case 'add_team': {
        if (!user) return;
        const text = (msg.text || '').trim();
        if (!text) return;
        const category = TASK_CATEGORIES.includes(msg.category) ? msg.category : null;
        const urgent   = !!msg.urgent;
        const id = Number(stmt.insertTeam.run(text, user.name, category, urgent ? 1 : 0).lastInsertRowid);
        teamTasks.push({ id, text, done: false, by: user.name, category, urgent });
        broadcast({ type: 'team_tasks', tasks: teamTasks });
        break;
      }

      case 'toggle_team': {
        if (!user) return;
        const t = teamTasks.find(t => t.id === msg.id);
        if (!t) return;
        stmt.toggleTeam.run(msg.id);
        t.done = !t.done;
        broadcast({ type: 'team_tasks', tasks: teamTasks });
        break;
      }

      case 'delete_team': {
        if (!user) return;
        stmt.deleteTeam.run(msg.id);
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
        stmt.editTeam.run(t.text, t.urgent ? 1 : 0, t.category, msg.id);
        broadcast({ type: 'team_tasks', tasks: teamTasks });
        break;
      }

      case 'add_schedule': {
        if (!user) return;
        const text = (msg.text || '').trim();
        const date = (msg.date || '').trim();
        const type = msg.taskType;
        const time = (msg.time || '').trim() || null;
        if (!text || !date || !TASK_TYPES.includes(type)) return;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
        const members = Array.isArray(msg.members)
          ? msg.members.filter(m => ALLOWED_USERS.includes(m))
          : [];
        const id = Number(stmt.insertSchedule.run(date, text, type, user.name, JSON.stringify(members), time).lastInsertRowid);
        scheduleItems.push({ id, date, text, type, by: user.name, members, time });
        broadcast({ type: 'schedule_items', items: scheduleItems });
        // Auto-add to each tagged member's personal task list
        let personalChanged = false;
        members.forEach(member => {
          if (!userTasks[member]) userTasks[member] = [];
          const pid = Number(stmt.insertPersonal.run(member, text, null, 0, user.name, null, null).lastInsertRowid);
          userTasks[member].push({ id: pid, text, done: false, category: null, urgent: false, addedBy: user.name, date: null, time: null });
          personalChanged = true;
        });
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
        stmt.editSchedule.run(item.text, item.type, item.time, JSON.stringify(item.members), msg.id);
        broadcast({ type: 'schedule_items', items: scheduleItems });
        break;
      }

      case 'delete_schedule': {
        if (!user) return;
        stmt.deleteSchedule.run(msg.id);
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
        const id = Number(stmt.insertShort.run(title, notes, user.name).lastInsertRowid);
        shortsLog.push({ id, title, notes, used: false, date: null, assignee: null, addedBy: user.name });
        broadcast({ type: 'shorts_updated', shorts: shortsLog });
        break;
      }

      case 'toggle_short_used': {
        if (!user) return;
        const s = shortsLog.find(s => s.id === msg.id);
        if (!s) return;
        stmt.toggleShortUsed.run(msg.id);
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
        stmt.updateShort.run(s.title, s.notes, s.date, s.assignee, msg.id);
        broadcast({ type: 'shorts_updated', shorts: shortsLog });
        break;
      }

      case 'delete_short': {
        if (!user) return;
        stmt.deleteShort.run(msg.id);
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
        const id = Number(stmt.insertLongForm.run(title, notes, user.name).lastInsertRowid);
        longFormsLog.push({ id, title, notes, used: false, date: null, assignee: null, addedBy: user.name });
        broadcast({ type: 'long_forms_updated', longForms: longFormsLog });
        break;
      }

      case 'toggle_long_form_used': {
        if (!user) return;
        const lf = longFormsLog.find(lf => lf.id === msg.id);
        if (!lf) return;
        stmt.toggleLongFormUsed.run(msg.id);
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
        stmt.updateLongForm.run(lf.title, lf.notes, lf.date, lf.assignee, msg.id);
        broadcast({ type: 'long_forms_updated', longForms: longFormsLog });
        break;
      }

      case 'delete_long_form': {
        if (!user) return;
        stmt.deleteLongForm.run(msg.id);
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
        const id = Number(stmt.insertGoal.run(text, period, user.name).lastInsertRowid);
        goals.push({ id, text, done: false, period, addedBy: user.name });
        broadcast({ type: 'goals_updated', goals });
        break;
      }

      case 'toggle_goal': {
        if (!user) return;
        const g = goals.find(g => g.id === msg.id);
        if (!g) return;
        stmt.toggleGoal.run(msg.id);
        g.done = !g.done;
        broadcast({ type: 'goals_updated', goals });
        break;
      }

      case 'delete_goal': {
        if (!user) return;
        stmt.deleteGoal.run(msg.id);
        const idx = goals.findIndex(g => g.id === msg.id);
        if (idx !== -1) goals.splice(idx, 1);
        broadcast({ type: 'goals_updated', goals });
        break;
      }
    }
  });

  ws.on('close', () => {
    const user = clients.get(ws);
    if (user) { clients.delete(ws); broadcast({ type: 'presence', onlineUsers: onlineUsers(), left: user.name }); }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`\n  Stadium Status Workplace → http://localhost:${PORT}\n`));
