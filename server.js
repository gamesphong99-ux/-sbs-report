const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Database setup ---
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'sbs.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS committees (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    appendix TEXT,
    status TEXT NOT NULL DEFAULT 'not-started',
    percent INTEGER NOT NULL DEFAULT 0,
    start_date TEXT,
    end_date TEXT,
    notes TEXT,
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    committee_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (committee_id) REFERENCES committees(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL
  );
`);

// Seed data if empty
const count = db.prepare('SELECT COUNT(*) as c FROM committees').get().c;
if (count === 0) {
  const seed = require('./data/seed');
  const insertCommittee = db.prepare(`
    INSERT INTO committees (id, title, appendix, status, percent, start_date, end_date, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertTask = db.prepare(`
    INSERT INTO tasks (committee_id, text, done, sort_order) VALUES (?, ?, ?, ?)
  `);
  const seedAll = db.transaction(() => {
    for (const c of seed) {
      insertCommittee.run(c.id, c.title, c.appendix, c.status, c.percent, c.start_date, c.end_date, c.notes);
      c.tasks.forEach((t, i) => insertTask.run(c.id, t.text, t.done ? 1 : 0, i));
    }
  });
  seedAll();
  console.log('✅ Database seeded with 10 committees');

  // Create default admin
  const adminExists = db.prepare('SELECT COUNT(*) as c FROM admin_users').get().c;
  if (adminExists === 0) {
    db.prepare('INSERT INTO admin_users (username, password) VALUES (?, ?)').run('admin', 'sbs2569');
    console.log('✅ Default admin created (admin / sbs2569)');
  }
}

// --- Middleware ---
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Simple auth middleware
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const decoded = Buffer.from(auth.split(' ')[1], 'base64').toString();
  const [username, password] = decoded.split(':');
  const user = db.prepare('SELECT * FROM admin_users WHERE username = ? AND password = ?').get(username, password);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  next();
}

// --- PUBLIC API ---

// Get all committees with tasks
app.get('/api/committees', (req, res) => {
  const committees = db.prepare('SELECT * FROM committees ORDER BY id').all();
  const taskStmt = db.prepare('SELECT * FROM tasks WHERE committee_id = ? ORDER BY sort_order');
  const result = committees.map(c => ({
    ...c,
    tasks: taskStmt.all(c.id).map(t => ({ ...t, done: !!t.done }))
  }));
  res.json(result);
});

// Get single committee
app.get('/api/committees/:id', (req, res) => {
  const c = db.prepare('SELECT * FROM committees WHERE id = ?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  c.tasks = db.prepare('SELECT * FROM tasks WHERE committee_id = ? ORDER BY sort_order').all(c.id)
    .map(t => ({ ...t, done: !!t.done }));
  res.json(c);
});

// Get summary stats
app.get('/api/summary', (req, res) => {
  const stats = db.prepare(`
    SELECT status, COUNT(*) as count FROM committees GROUP BY status
  `).all();
  const avg = db.prepare('SELECT ROUND(AVG(percent)) as avg_percent FROM committees').get();
  res.json({ stats, avg_percent: avg.avg_percent || 0, total: 10 });
});

// --- ADMIN API (requires auth) ---

// Login check
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT id, username FROM admin_users WHERE username = ? AND password = ?').get(username, password);
  if (!user) return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
  res.json({ ok: true, user });
});

// Update committee
app.put('/api/admin/committees/:id', requireAuth, (req, res) => {
  const { title, appendix, status, percent, start_date, end_date, notes } = req.body;
  const stmt = db.prepare(`
    UPDATE committees
    SET title = ?, appendix = ?, status = ?, percent = ?, start_date = ?, end_date = ?, notes = ?,
        updated_at = datetime('now','localtime')
    WHERE id = ?
  `);
  stmt.run(title, appendix, status, percent, start_date, end_date, notes, req.params.id);
  res.json({ ok: true });
});

// Update tasks for a committee
app.put('/api/admin/committees/:id/tasks', requireAuth, (req, res) => {
  const { tasks } = req.body; // [{text, done}, ...]
  const cid = req.params.id;
  const updateAll = db.transaction(() => {
    db.prepare('DELETE FROM tasks WHERE committee_id = ?').run(cid);
    const ins = db.prepare('INSERT INTO tasks (committee_id, text, done, sort_order) VALUES (?, ?, ?, ?)');
    tasks.forEach((t, i) => ins.run(cid, t.text, t.done ? 1 : 0, i));
  });
  updateAll();
  res.json({ ok: true });
});

// Change admin password
app.put('/api/admin/password', requireAuth, (req, res) => {
  const { username, newPassword } = req.body;
  db.prepare('UPDATE admin_users SET password = ? WHERE username = ?').run(newPassword, username);
  res.json({ ok: true });
});

// Serve admin page
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 SBS Report running on http://localhost:${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}`);
  console.log(`🔧 Admin:     http://localhost:${PORT}/admin`);
});
