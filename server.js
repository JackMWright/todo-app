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
const clients       = new Map();

let nextId = 1;

const ALLOWED_USERS   = ['Jack', 'Joe', 'Becca'];
const TASK_TYPES      = ['Shorts', 'Long Form', 'Graphics', 'Meetings', 'Shoots'];
const TASK_CATEGORIES = ['Create Short', 'Edit Short', 'Create Graphic', 'Edit Long Form'];

function uid() { return nextId++; }
function onlineUsers() { return [...clients.values()].map(u => u.name); }
function send(ws, msg) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); }
function broadcast(msg) { for (const ws of wss.clients) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); } }
function sendToUser(name, msg) { for (const [cws, cu] of clients) { if (cu.name === name) send(cws, msg); } }

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
        send(ws, { type: 'init', name, personalTasks: userTasks[name], teamTasks, scheduleItems, shortsLog, onlineUsers: onlineUsers() });
        broadcast({ type: 'presence', onlineUsers: onlineUsers(), joined: name });
        break;
      }

      case 'add_personal': {
        if (!user) return;
        const text = (msg.text || '').trim();
        if (!text) return;
        const category = TASK_CATEGORIES.includes(msg.category) ? msg.category : null;
        const urgent   = !!msg.urgent;
        const target   = ALLOWED_USERS.includes(msg.target) ? msg.target : user.name;
        if (target !== user.name && user.name !== 'Jack') return;
        if (!userTasks[target]) userTasks[target] = [];
        userTasks[target].push({ id: uid(), text, done: false, category, urgent, addedBy: user.name });
        sendToUser(target, { type: 'personal_tasks', tasks: userTasks[target] });
        break;
      }

      case 'toggle_personal': {
        if (!user) return;
        const t = userTasks[user.name].find(t => t.id === msg.id);
        if (t) t.done = !t.done;
        sendToUser(user.name, { type: 'personal_tasks', tasks: userTasks[user.name] });
        break;
      }

      case 'delete_personal': {
        if (!user) return;
        userTasks[user.name] = userTasks[user.name].filter(t => t.id !== msg.id);
        sendToUser(user.name, { type: 'personal_tasks', tasks: userTasks[user.name] });
        break;
      }

      case 'edit_personal': {
        if (!user) return;
        const t = userTasks[user.name].find(t => t.id === msg.id);
        if (!t) return;
        if (msg.text     !== undefined) t.text     = (msg.text || '').trim() || t.text;
        if (msg.urgent   !== undefined) t.urgent   = !!msg.urgent;
        if (msg.category !== undefined && TASK_CATEGORIES.includes(msg.category)) t.category = msg.category;
        sendToUser(user.name, { type: 'personal_tasks', tasks: userTasks[user.name] });
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
        if (!text || !date || !TASK_TYPES.includes(type)) return;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
        const members = Array.isArray(msg.members)
          ? msg.members.filter(m => ALLOWED_USERS.includes(m))
          : [];
        scheduleItems.push({ id: uid(), date, text, type, by: user.name, members });
        broadcast({ type: 'schedule_items', items: scheduleItems });
        // Auto-add to each tagged member's personal task list
        members.forEach(member => {
          if (!userTasks[member]) userTasks[member] = [];
          userTasks[member].push({ id: uid(), text, done: false, category: null, urgent: false, addedBy: user.name });
          sendToUser(member, { type: 'personal_tasks', tasks: userTasks[member] });
        });
        break;
      }

      case 'edit_schedule': {
        if (!user) return;
        const item = scheduleItems.find(i => i.id === msg.id);
        if (!item) return;
        if (msg.text     !== undefined) item.text    = (msg.text || '').trim() || item.text;
        if (msg.taskType !== undefined && TASK_TYPES.includes(msg.taskType)) item.type = msg.taskType;
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
    }
  });

  ws.on('close', () => {
    const user = clients.get(ws);
    if (user) { clients.delete(ws); broadcast({ type: 'presence', onlineUsers: onlineUsers(), left: user.name }); }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`\n  Stadium Status Workplace → http://localhost:${PORT}\n`));
