/**
 * Import C++ LMS CSV files into SQLite for the web app.
 * Usage: node import-csv.js [path-to-database-folder]
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { hashPassword } = require('./auth-utils');

const CSV_DIR = process.argv[2]
  || path.join('D:', 'website', 'Library-Resource-Management-Software', 'database');

const DB_PATH = path.join(__dirname, 'library.db');

function parseCsvLine(line) {
  const cols = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      cols.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  cols.push(cur);
  return cols;
}

function readCsv(file) {
  const full = path.join(CSV_DIR, file);
  if (!fs.existsSync(full)) {
    throw new Error(`Missing file: ${full}`);
  }
  const lines = fs.readFileSync(full, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  const header = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map(line => {
    const cols = parseCsvLine(line);
    const row = {};
    header.forEach((h, i) => { row[h] = cols[i] ?? ''; });
    return row;
  });
  return rows;
}

function num(v, fallback = 0) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function flt(v, fallback = 0) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

// Close WAL files and recreate database
for (const ext of ['', '-wal', '-shm']) {
  const f = DB_PATH + ext;
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE users (
    userID INTEGER PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('student','teacher','staff','premium','admin')),
    username TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    name TEXT NOT NULL,
    address TEXT DEFAULT '',
    balance REAL DEFAULT 0,
    isDeleted INTEGER DEFAULT 0,
    department TEXT DEFAULT '',
    rollNo INTEGER DEFAULT 0,
    designation TEXT DEFAULT '',
    position TEXT DEFAULT '',
    membershipLevel TEXT DEFAULT '',
    email TEXT DEFAULT '',
    googleId TEXT DEFAULT '',
    emailVerified INTEGER DEFAULT 0
  );

  CREATE TABLE resources (
    resourceID INTEGER PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('book','dvd','audiobook','magazine','newspaper')),
    title TEXT NOT NULL,
    authorCreator TEXT DEFAULT '',
    category TEXT DEFAULT '',
    totalCopies INTEGER DEFAULT 1,
    availableCopies INTEGER DEFAULT 1,
    availabilityStatus TEXT DEFAULT 'Available',
    isDeleted INTEGER DEFAULT 0,
    ISBN TEXT DEFAULT '',
    publisher TEXT DEFAULT '',
    yearPublished INTEGER DEFAULT 0,
    director TEXT DEFAULT '',
    durationMinutes INTEGER DEFAULT 0,
    genre TEXT DEFAULT '',
    narrator TEXT DEFAULT '',
    format TEXT DEFAULT '',
    volumeNumber INTEGER DEFAULT 0,
    issueNumber INTEGER DEFAULT 0,
    publicationDate TEXT DEFAULT '',
    editionDate TEXT DEFAULT '',
    region TEXT DEFAULT ''
  );

  CREATE TABLE borrow_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userID INTEGER NOT NULL,
    resourceID INTEGER NOT NULL,
    borrowDate INTEGER NOT NULL,
    dueDate INTEGER NOT NULL,
    returnDate INTEGER DEFAULT 0,
    fine REAL DEFAULT 0,
    durationDays INTEGER NOT NULL,
    FOREIGN KEY(userID) REFERENCES users(userID),
    FOREIGN KEY(resourceID) REFERENCES resources(resourceID)
  );

  CREATE UNIQUE INDEX idx_active_borrow
  ON borrow_history(userID, resourceID)
  WHERE returnDate = 0;
`);

const insertUser = db.prepare(`
  INSERT INTO users (
    userID,type,username,password,name,address,balance,isDeleted,
    department,rollNo,designation,position,membershipLevel,email,emailVerified
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);

const insertResource = db.prepare(`
  INSERT OR REPLACE INTO resources (
    resourceID,type,title,authorCreator,category,totalCopies,availableCopies,
    availabilityStatus,isDeleted,ISBN,publisher,yearPublished,director,
    durationMinutes,genre,narrator,format,volumeNumber,issueNumber,
    publicationDate,editionDate,region
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);

const insertBorrow = db.prepare(`
  INSERT INTO borrow_history
  (userID,resourceID,borrowDate,dueDate,returnDate,fine,durationDays)
  VALUES (?,?,?,?,?,?,?)
`);

const importAll = db.transaction(() => {
  const users = readCsv('users.csv');
  for (const u of users) {
    const syntheticEmail = `${u.username}@library.local`;
    insertUser.run(
      num(u.userID), u.type, u.username, hashPassword(u.password), u.name, u.address,
      flt(u.balance), num(u.isDeleted), u.department || '', num(u.rollNo),
      u.designation || '', u.position || '', u.membershipLevel || '',
      syntheticEmail, 0
    );
  }

  const resources = readCsv('resources.csv');
  const seenIds = new Set();
  for (const r of resources) {
    const id = num(r.resourceID);
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    insertResource.run(
      id, r.type, r.title, r.authorCreator || '', r.category || '',
      num(r.totalCopies, 1), num(r.availableCopies, 1),
      r.availabilityStatus || 'Available', num(r.isDeleted),
      r.ISBN || '', r.publisher || '', num(r.yearPublished),
      r.director || '', num(r.durationMinutes), r.genre || '',
      r.narrator || '', r.format || '', num(r.volumeNumber),
      num(r.issueNumber), r.publicationDate || '', r.editionDate || '',
      r.region || ''
    );
  }

  const borrows = readCsv('borrowHistory.csv');
  for (const b of borrows) {
    insertBorrow.run(
      num(b.userID), num(b.resourceID), num(b.borrowDate),
      num(b.dueDate), num(b.returnDate), flt(b.fine), num(b.durationDays)
    );
  }

  db.prepare(`DELETE FROM sqlite_sequence WHERE name IN ('users','resources','borrow_history')`).run();
  const maxUser = db.prepare('SELECT MAX(userID) as m FROM users').get().m || 0;
  const maxRes = db.prepare('SELECT MAX(resourceID) as m FROM resources').get().m || 0;
  const maxBorrow = db.prepare('SELECT MAX(id) as m FROM borrow_history').get().m || 0;
  if (maxUser) db.prepare(`INSERT INTO sqlite_sequence (name, seq) VALUES ('users', ?)`).run(maxUser);
  if (maxRes) db.prepare(`INSERT INTO sqlite_sequence (name, seq) VALUES ('resources', ?)`).run(maxRes);
  if (maxBorrow) db.prepare(`INSERT INTO sqlite_sequence (name, seq) VALUES ('borrow_history', ?)`).run(maxBorrow);
});

importAll();

const stats = {
  users: db.prepare('SELECT COUNT(*) as c FROM users').get().c,
  resources: db.prepare('SELECT COUNT(*) as c FROM resources').get().c,
  borrows: db.prepare('SELECT COUNT(*) as c FROM borrow_history').get().c,
};

db.close();

console.log(`Imported from: ${CSV_DIR}`);
console.log(`  Users:     ${stats.users}`);
console.log(`  Resources: ${stats.resources}`);
console.log(`  Borrows:   ${stats.borrows}`);
console.log('Done. Restart the server and open http://localhost:3000');
