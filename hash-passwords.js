/**
 * One-time script: hash any plaintext passwords still in the database.
 * Run: node hash-passwords.js
 *
 * Note: passwords imported from CSV cannot be hashed without the original
 * plaintext — those are upgraded automatically when users log in.
 */
const db = require('./db');
const { hashPassword, isHashed } = require('./auth-utils');

const users = db.prepare('SELECT userID, username, password FROM users').all();
let upgraded = 0;

for (const u of users) {
  if (!isHashed(u.password)) {
    console.log(`Skipping #${u.userID} @${u.username} — plaintext (will hash on next login)`);
  } else {
    upgraded++;
  }
}

console.log(`Already hashed: ${upgraded}/${users.length}`);
console.log('Plaintext accounts will be hashed automatically when they sign in.');
db.close();
