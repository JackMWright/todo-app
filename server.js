const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

const userTasks     = {};
const teamTasks     = [];
const scheduleItems = [];
const shortsLog     = [];
const longFormsLog  = [];
const goals         = [];
const clients       = new Map();

let nextId = 1;

const ALLOWED_USERS   = ['Jack', 'Joe', 'Becca'];
const TASK_TYPES      = ['Shorts', 'Long Form', 'Graphics', 'Meetings', 'Shoots'];
const TASK_CATEGORIES = ['Create Short', 'Edit Short', 'Create Graphic', 'Edit Long Form'];
const GOAL_PERIODS    = ['weekly', 'monthly', 'yearly'];

function uid() { return nextId++; }
function onlineUsers() { return [...clients.values()].map(u => u.name); }
function send(ws, msg) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); }
function broadcast(msg) { for (const ws of wss.clients) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); } }
function broadcastAllPersonal() { broadcast({ type: 'all_personal_tasks', tasks: userTasks }); }

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
        userTasks[target].push({ id: uid(), text, done: false, category, urgent, addedBy: user.name, time, date });
        broadcastAllPersonal();
        break;
      }

      case 'toggle_personal': {
        if (!user) return;
        const t = (userTasks[user.name] || []).find(t => t.id === msg.id);
        if (t) t.done = !t.done;
        broadcastAllPersonal();
        break;
      }

      case 'delete_personal': {
        if (!user) return;
        const owner = ALLOWED_USERS.includes(msg.owner) ? msg.owner : user.name;
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
        broadcastAllPersonal();
        break;
      }

      case 'add_team': {
        if (!user) return;
        const text = (msg.text || '').trim();
        if (!text) return;
        const category = TASK_CATEGORIES.includes(msg.category) ? msg.category : null;
        const urgent   = !!msg.urgent;
        teamTasks.push({ id: uid(), text, done: false, by: user.name, category, urgent });
        broadcast({ type: 'team_tasks', tasks: teamTasks });
        break;
      }

      case 'toggle_team': {
        if (!user) return;
        const t = teamTasks.find(t => t.id === msg.id);
        if (t) t.done = !t.done;
        broadcast({ type: 'team_tasks', tasks: teamTasks });
        break;
      }

      case 'delete_team': {
        if (!user) return;
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
        scheduleItems.push({ id: uid(), date, text, type, by: user.name, members, time });
        broadcast({ type: 'schedule_items', items: scheduleItems });
        // Auto-add to each tagged member's personal task list
        let personalChanged = false;
        members.forEach(member => {
          if (!userTasks[member]) userTasks[member] = [];
          userTasks[member].push({ id: uid(), text, done: false, category: null, urgent: false, addedBy: user.name, date: null, time: null });
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
        broadcast({ type: 'schedule_items', items: scheduleItems });
        break;
      }

      case 'delete_schedule': {
        if (!user) return;
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
        shortsLog.push({ id: uid(), title, notes, used: false, date: null, assignee: null, addedBy: user.name });
        broadcast({ type: 'shorts_updated', shorts: shortsLog });
        break;
      }

      case 'toggle_short_used': {
        if (!user) return;
        const s = shortsLog.find(s => s.id === msg.id);
        if (s) s.used = !s.used;
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
        broadcast({ type: 'shorts_updated', shorts: shortsLog });
        break;
      }

      case 'delete_short': {
        if (!user) return;
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
        longFormsLog.push({ id: uid(), title, notes, used: false, date: null, assignee: null, addedBy: user.name });
        broadcast({ type: 'long_forms_updated', longForms: longFormsLog });
        break;
      }

      case 'toggle_long_form_used': {
        if (!user) return;
        const lf = longFormsLog.find(lf => lf.id === msg.id);
        if (lf) lf.used = !lf.used;
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
        broadcast({ type: 'long_forms_updated', longForms: longFormsLog });
        break;
      }

      case 'delete_long_form': {
        if (!user) return;
        const idx2 = longFormsLog.findIndex(lf => lf.id === msg.id);
        if (idx2 !== -1) longFormsLog.splice(idx2, 1);
        broadcast({ type: 'long_forms_updated', longForms: longFormsLog });
        break;
      }

      case 'add_goal': {
        if (!user) return;
        const text   = (msg.text || '').trim();
        const period = GOAL_PERIODS.includes(msg.period) ? msg.period : 'weekly';
        if (!text) return;
        goals.push({ id: uid(), text, done: false, period, addedBy: user.name });
        broadcast({ type: 'goals_updated', goals });
        break;
      }

      case 'toggle_goal': {
        if (!user) return;
        const g = goals.find(g => g.id === msg.id);
        if (g) g.done = !g.done;
        broadcast({ type: 'goals_updated', goals });
        break;
      }

      case 'delete_goal': {
        if (!user) return;
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
