const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

const dbPath = process.env.DATABASE_PATH || path.join(__dirname, 'library.db');
const db = new Database(dbPath);
// ===================== CONFIG =====================
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ===================== HELPERS =====================
const now = () => Math.floor(Date.now() / 1000);
const hash = (p) => bcrypt.hashSync(p, 10);

// ===================== SCHEMA =====================
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    userID INTEGER PRIMARY KEY AUTOINCREMENT,
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
    membershipLevel TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS resources (
    resourceID INTEGER PRIMARY KEY AUTOINCREMENT,
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

  CREATE TABLE IF NOT EXISTS borrow_history (
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

  -- prevents duplicate active borrows (VERY IMPORTANT)
  CREATE UNIQUE INDEX IF NOT EXISTS idx_active_borrow
  ON borrow_history(userID, resourceID)
  WHERE returnDate = 0;
`);

// ===================== AUTH MIGRATIONS =====================
const userCols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
if (!userCols.includes('email')) {
  db.exec(`ALTER TABLE users ADD COLUMN email TEXT DEFAULT ''`);
}
if (!userCols.includes('googleId')) {
  db.exec(`ALTER TABLE users ADD COLUMN googleId TEXT DEFAULT ''`);
}
if (!userCols.includes('emailVerified')) {
  db.exec(`ALTER TABLE users ADD COLUMN emailVerified INTEGER DEFAULT 0`);
}

db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email
  ON users(email) WHERE email != '';

  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google
  ON users(googleId) WHERE googleId != '';

  CREATE TABLE IF NOT EXISTS otp_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    code TEXT NOT NULL,
    purpose TEXT NOT NULL DEFAULT 'register',
    expiresAt INTEGER NOT NULL,
    used INTEGER DEFAULT 0,
    createdAt INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS auth_tokens (
    token TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    purpose TEXT NOT NULL DEFAULT 'register',
    expiresAt INTEGER NOT NULL,
    used INTEGER DEFAULT 0
  );
`);

// ===================== SEED DATA =====================
const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;

if (userCount === 0) {
  const insertUser = db.prepare(`
    INSERT INTO users (
      type,username,password,name,address,balance,isDeleted,
      department,rollNo,designation,position,membershipLevel
    )
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  // Admin
  insertUser.run(
    'admin','admin',hash('admin123'),
    'System Administrator','Library HQ',0,0,
    '',0,'','',''
  );

  // Students
  insertUser.run(
    'student','ali.khan',hash('pass123'),
    'Ali Khan','Karachi Block A',150,0,
    'Computer Science',101,'','',''
  );

  insertUser.run(
    'student','sara.ahmed',hash('pass123'),
    'Sara Ahmed','Lahore Block B',80,0,
    'Electrical Engineering',102,'','',''
  );

  // Teacher
  insertUser.run(
    'teacher','dr.hassan',hash('pass123'),
    'Dr. Hassan Raza','Faculty Quarters',300,0,
    'Physics',0,'Professor','',''
  );

  // Staff
  insertUser.run(
    'staff','mr.usman',hash('pass123'),
    'Usman Tariq','Staff Block',200,0,
    '',0,'','Librarian',''
  );

  // Premium
  insertUser.run(
    'premium','vip.member',hash('pass123'),
    'Fatima Sheikh','VIP Residency',1200,0,
    '',0,'','','Diamond'
  );

  const insertRes = db.prepare(`
    INSERT INTO resources (
      type,title,authorCreator,category,totalCopies,availableCopies,availabilityStatus,isDeleted,
      ISBN,publisher,yearPublished,
      director,durationMinutes,genre,
      narrator,format,
      volumeNumber,issueNumber,publicationDate,editionDate,region
    )
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  // Books
  insertRes.run('book','Clean Code','Robert C. Martin','Programming',3,3,'Available',0,'978-0132350884','Prentice Hall',2008,'',0,'','','',0,0,'','','');
  insertRes.run('book','The Pragmatic Programmer','David Thomas','Programming',2,2,'Available',0,'978-0135957059','Addison-Wesley',2019,'',0,'','','',0,0,'','','');
  insertRes.run('book','Introduction to Algorithms','Thomas H. Cormen','Computer Science',4,4,'Available',0,'978-0262033848','MIT Press',2009,'',0,'','','',0,0,'','','');

  // DVDs
  insertRes.run('dvd','Interstellar','Christopher Nolan','Sci-Fi',2,2,'Available',0,'','',0,'Christopher Nolan',169,'Sci-Fi','','',0,0,'','','');

  // Audiobooks
  insertRes.run('audiobook','Thinking Fast and Slow','Daniel Kahneman','Psychology',3,3,'Available',0,'','',0,'',1140,'','Patrick Girard','MP3',0,0,'','','');

  // Magazine
  insertRes.run('magazine','National Geographic','National Geographic Society','Science',5,5,'Available',0,'','National Geographic Society',0,'',0,'','','',12,3,'March 2025','','');

  // Newspaper
  insertRes.run('newspaper','Dawn','Dawn Media Group','News',10,10,'Available',0,'','Dawn Media Group',0,'',0,'','','',0,0,'','29-05-2025','Pakistan');

  // Safe borrow seed (NO hardcoded IDs)
  const ali = db.prepare('SELECT userID FROM users WHERE username=?').get('ali.khan');
  const sara = db.prepare('SELECT userID FROM users WHERE username=?').get('sara.ahmed');

  const cleanCode = db.prepare('SELECT resourceID FROM resources WHERE title=?').get('Clean Code');
  const algo = db.prepare('SELECT resourceID FROM resources WHERE title=?').get('Introduction to Algorithms');

  const insertBorrow = db.prepare(`
    INSERT INTO borrow_history
    (userID,resourceID,borrowDate,dueDate,returnDate,fine,durationDays)
    VALUES (?,?,?,?,?,?,?)
  `);

  const t = now();

  insertBorrow.run(ali.userID, cleanCode.resourceID, t - 5*86400, t + 2*86400, 0, 0, 7);
  insertBorrow.run(sara.userID, algo.resourceID, t - 10*86400, t - 3*86400, 0, 0, 7);
}

module.exports = db;