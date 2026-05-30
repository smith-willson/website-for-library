// restore-db.js
// Run with: node restore-db.js
// Place this file in D:\lms\ alongside your other files

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = process.env.DATABASE_PATH || path.join(__dirname, 'library.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = OFF'); // OFF during import to avoid FK issues

function parseCSV(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.trim().split('\n');
  const headers = lines[0].split(',');
  return lines.slice(1).map(line => {
    // Handle commas inside quoted fields
    const values = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') {
        inQuotes = !inQuotes;
      } else if (line[i] === ',' && !inQuotes) {
        values.push(current.trim());
        current = '';
      } else {
        current += line[i];
      }
    }
    values.push(current.trim());
    const obj = {};
    headers.forEach((h, i) => obj[h.trim()] = values[i] ?? '');
    return obj;
  });
}

// ── USERS ──────────────────────────────────────────────
console.log('Importing users...');
const usersPath = path.join(__dirname, 'users.csv');
if (fs.existsSync(usersPath)) {
  const users = parseCSV(usersPath);
  const insertUser = db.prepare(`
    INSERT OR REPLACE INTO users 
    (userID,type,username,password,name,address,balance,isDeleted,department,rollNo,designation,position,membershipLevel)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const importUsers = db.transaction((rows) => {
    for (const u of rows) {
      insertUser.run(
        Number(u.userID), u.type, u.username, u.password, u.name,
        u.address, Number(u.balance), Number(u.isDeleted),
        u.department, Number(u.rollNo) || 0, u.designation, u.position, u.membershipLevel
      );
    }
  });
  importUsers(users);
  console.log(`✓ Imported ${users.length} users`);
} else {
  console.log('✗ users.csv not found — skipping');
}

// ── RESOURCES ──────────────────────────────────────────
console.log('Importing resources...');
const resourcesPath = path.join(__dirname, 'resources.csv');
if (fs.existsSync(resourcesPath)) {
  const resources = parseCSV(resourcesPath);
  const insertRes = db.prepare(`
    INSERT OR REPLACE INTO resources
    (resourceID,type,title,authorCreator,category,totalCopies,availableCopies,availabilityStatus,isDeleted,
     ISBN,publisher,yearPublished,director,durationMinutes,genre,narrator,format,
     volumeNumber,issueNumber,publicationDate,editionDate,region)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const importResources = db.transaction((rows) => {
    for (const r of rows) {
      insertRes.run(
        Number(r.resourceID), r.type, r.title, r.authorCreator, r.category,
        Number(r.totalCopies), Number(r.availableCopies), r.availabilityStatus, Number(r.isDeleted),
        r.ISBN, r.publisher, Number(r.yearPublished) || 0,
        r.director, Number(r.durationMinutes) || 0, r.genre,
        r.narrator, r.format,
        Number(r.volumeNumber) || 0, Number(r.issueNumber) || 0,
        r.publicationDate, r.editionDate, r.region
      );
    }
  });
  importResources(resources);
  console.log(`✓ Imported ${resources.length} resources`);
} else {
  console.log('✗ resources.csv not found — skipping');
}

// ── BORROW HISTORY ─────────────────────────────────────
console.log('Importing borrow history...');
const borrowPath = path.join(__dirname, 'borrowHistory.csv');
if (fs.existsSync(borrowPath)) {
  const borrows = parseCSV(borrowPath);
  const insertBorrow = db.prepare(`
    INSERT OR IGNORE INTO borrow_history
    (userID,resourceID,borrowDate,dueDate,returnDate,fine,durationDays)
    VALUES (?,?,?,?,?,?,?)
  `);
  const importBorrows = db.transaction((rows) => {
    for (const b of rows) {
      insertBorrow.run(
        Number(b.userID), Number(b.resourceID),
        Number(b.borrowDate), Number(b.dueDate),
        Number(b.returnDate), Number(b.fine),
        Number(b.durationDays)
      );
    }
  });
  importBorrows(borrows);
  console.log(`✓ Imported ${borrows.length} borrow records`);
} else {
  console.log('✗ borrowHistory.csv not found — skipping');
}

db.pragma('foreign_keys = ON');
db.close();
console.log('\nDone! Database restored successfully.');