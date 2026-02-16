const express = require('express');
const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'sbs.db');

let db;

async function initDB() {
  const SQL = await initSqlJs();
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }

  db.run(`
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
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      committee_id INTEGER NOT NULL,
      text TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (committee_id) REFERENCES committees(id) ON DELETE CASCADE
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL
    )
  `);

  const count = db.exec("SELECT COUNT(*) as c FROM committees")[0].values[0][0];
  if (count === 0) {
    const seed = require('./data/seed');
    for (const c of seed) {
      db.run("INSERT INTO committees (id,title,appendix,status,percent,start_date,end_date,notes) VALUES (?,?,?,?,?,?,?,?)",
        [c.id, c.title, c.appendix, c.status, c.percent, c.start_date, c.end_date, c.notes]);
      c.tasks.forEach((t, i) => {
        db.run("INSERT INTO tasks (committee_id,text,done,sort_order) VALUES (?,?,?,?)", [c.id, t.text, t.done ? 1 : 0, i]);
      });
    }
    const adminCount = db.exec("SELECT COUNT(*) FROM admin_users")[0].values[0][0];
    if (adminCount === 0) {
      db.run("INSERT INTO admin_users (username,password) VALUES (?,?)", ['admin', 'sbs2569']);
    }
    saveDB();
    console.log('Database seeded');
  }
}

function saveDB() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function queryAll(sql, params) {
  const stmt = db.prepare(sql);
  if (params) stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function queryOne(sql, params) {
  const rows = queryAll(sql, params);
  return rows[0] || null;
}

function runSql(sql, params) {
  db.run(sql, params);
  saveDB();
}

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) return res.status(401).json({ error: 'Unauthorized' });
  const decoded = Buffer.from(auth.split(' ')[1], 'base64').toString();
  const [username, password] = decoded.split(':');
  const user = queryOne('SELECT * FROM admin_users WHERE username=? AND password=?', [username, password]);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  next();
}

// PUBLIC API
app.get('/api/committees', (req, res) => {
  const committees = queryAll('SELECT * FROM committees ORDER BY id');
  const result = committees.map(c => ({
    ...c,
    tasks: queryAll('SELECT * FROM tasks WHERE committee_id=? ORDER BY sort_order', [c.id]).map(t => ({ ...t, done: !!t.done }))
  }));
  res.json(result);
});

app.get('/api/committees/:id', (req, res) => {
  const c = queryOne('SELECT * FROM committees WHERE id=?', [+req.params.id]);
  if (!c) return res.status(404).json({ error: 'Not found' });
  c.tasks = queryAll('SELECT * FROM tasks WHERE committee_id=? ORDER BY sort_order', [c.id]).map(t => ({ ...t, done: !!t.done }));
  res.json(c);
});

app.get('/api/summary', (req, res) => {
  const stats = queryAll('SELECT status, COUNT(*) as count FROM committees GROUP BY status');
  const avg = queryOne('SELECT ROUND(AVG(percent)) as avg_percent FROM committees');
  res.json({ stats, avg_percent: avg ? avg.avg_percent : 0, total: 10 });
});

// AUTH
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  const user = queryOne('SELECT id,username FROM admin_users WHERE username=? AND password=?', [username, password]);
  if (!user) return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
  res.json({ ok: true, user });
});

// ADMIN API
app.put('/api/admin/committees/:id', requireAuth, (req, res) => {
  const { title, appendix, status, percent, start_date, end_date, notes } = req.body;
  runSql("UPDATE committees SET title=?,appendix=?,status=?,percent=?,start_date=?,end_date=?,notes=?,updated_at=datetime('now','localtime') WHERE id=?",
    [title, appendix, status, percent, start_date, end_date, notes, +req.params.id]);
  res.json({ ok: true });
});

app.put('/api/admin/committees/:id/tasks', requireAuth, (req, res) => {
  const { tasks } = req.body;
  const cid = +req.params.id;
  db.run('DELETE FROM tasks WHERE committee_id=?', [cid]);
  tasks.forEach((t, i) => {
    db.run('INSERT INTO tasks (committee_id,text,done,sort_order) VALUES (?,?,?,?)', [cid, t.text, t.done ? 1 : 0, i]);
  });
  saveDB();
  res.json({ ok: true });
});

app.put('/api/admin/password', requireAuth, (req, res) => {
  const { username, newPassword } = req.body;
  runSql('UPDATE admin_users SET password=? WHERE username=?', [newPassword, username]);
  res.json({ ok: true });
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// START
initDB().then(() => {
  app.listen(PORT, () => {
    console.log('SBS Report running on http://localhost:' + PORT);
  });
}).catch(err => { console.error('DB init failed:', err); process.exit(1); });
