const express = require('express');
const session = require('express-session');
const path = require('path');
require('dotenv').config();
const db = require('./db');
const {
  hashPassword, verifyPassword, upgradePasswordIfNeeded,
  generateOtp, generateToken, isValidEmail,
  sendOtpEmail, verifyGoogleCredential, authConfig
} = require('./auth-utils');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'lms-secret-key-2024';
const isProd = process.env.NODE_ENV === 'production';

if (isProd) app.set('trust proxy', 1);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  name: 'lms.sid',
  cookie: {
    secure: isProd,
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// ===================== ROLE SYSTEM =====================

const ROLE_RULES = {
  student: { dailyLimit: 2, fineRate: 10, borrowDays: 7 },
  teacher: { dailyLimit: 3, fineRate: 20, borrowDays: 14 },
  staff:   { dailyLimit: 4, fineRate: 5, borrowDays: 14 },
  admin:   { dailyLimit: 0, fineRate: 0, borrowDays: 0 },
  premium: { dailyLimit: 5, fineRate: 10, borrowDays: 21 }
};

function getRoleRules(user) {
  if (user.type === 'premium') {
    if (user.membershipLevel === 'Diamond')
      return { dailyLimit: 10, fineRate: 5, borrowDays: 30 };

    if (user.membershipLevel === 'Gold')
      return { dailyLimit: 5, fineRate: 10, borrowDays: 21 };

    return { dailyLimit: 3, fineRate: 20, borrowDays: 14 };
  }

  return ROLE_RULES[user.type] || ROLE_RULES.student;
}

// ===================== HELPERS =====================

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.type !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function updateAvailabilityStatus(resourceID) {
  const r = db.prepare(
    'SELECT totalCopies, availableCopies FROM resources WHERE resourceID=?'
  ).get(resourceID);

  if (!r) return;

  let status = 'Available';
  if (r.availableCopies === 0) status = 'Borrowed';
  else if (r.availableCopies < r.totalCopies) status = 'Partially Available';

  db.prepare(
    'UPDATE resources SET availabilityStatus=? WHERE resourceID=?'
  ).run(status, resourceID);
}

function checkAndUpgradeUser(userID) {
  const user = db.prepare('SELECT * FROM users WHERE userID=?').get(userID);
  if (!user || user.type === 'admin' || user.type === 'premium') return null;

  if (user.balance >= 500) {
    const level = user.balance >= 1000 ? 'Diamond' : 'Gold';

    db.prepare(`
      UPDATE users
      SET type='premium', membershipLevel=?
      WHERE userID=?
    `).run(level, userID);

    return level;
  }
  return null;
}

// ===================== AUTH =====================

function createSession(req, user) {
  req.session.user = {
    userID: user.userID,
    username: user.username,
    type: user.type,
    name: user.name
  };
}

function findUserByLogin(login) {
  return db.prepare(`
    SELECT * FROM users
    WHERE isDeleted=0 AND (username=? OR (email=? AND email!=''))
  `).get(login, login);
}

app.get('/api/auth/config', (req, res) => {
  res.json(authConfig());
});

app.post('/api/auth/send-otp', async (req, res) => {
  try {
    const { email, purpose = 'register' } = req.body;
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Enter a valid Gmail / email address' });
    }

    if (purpose === 'register') {
      const taken = db.prepare(
        'SELECT userID FROM users WHERE email=? AND isDeleted=0'
      ).get(email);
      if (taken) return res.status(400).json({ error: 'Email already registered' });
    }

    const code = generateOtp();
    const expiresAt = Math.floor(Date.now() / 1000) + 600;

    db.prepare(`
      INSERT INTO otp_codes (email, code, purpose, expiresAt)
      VALUES (?,?,?,?)
    `).run(email, code, purpose, expiresAt);

    const mail = await sendOtpEmail(email, code, purpose);
    res.json({
      success: true,
      message: 'OTP sent to your email. Check your inbox (and spam folder).'
    });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Failed to send OTP' });
  }
});

app.post('/api/auth/verify-otp', (req, res) => {
  const { email, otp, purpose = 'register' } = req.body;
  if (!isValidEmail(email) || !otp) {
    return res.status(400).json({ error: 'Email and OTP are required' });
  }

  const now = Math.floor(Date.now() / 1000);
  const row = db.prepare(`
    SELECT * FROM otp_codes
    WHERE email=? AND purpose=? AND used=0 AND expiresAt>?
    ORDER BY id DESC LIMIT 1
  `).get(email, purpose, now);

  if (!row || row.code !== String(otp).trim()) {
    return res.status(400).json({ error: 'Invalid or expired OTP' });
  }

  db.prepare('UPDATE otp_codes SET used=1 WHERE id=?').run(row.id);

  const token = generateToken();
  const expiresAt = now + 900;
  db.prepare(`
    INSERT INTO auth_tokens (token, email, purpose, expiresAt)
    VALUES (?,?,?,?)
  `).run(token, email, purpose, expiresAt);

  res.json({
    success: true,
    message: 'Email verified successfully',
    registrationToken: token
  });
});

app.post('/api/auth/google', async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) return res.status(400).json({ error: 'Missing Google credential' });

    const payload = await verifyGoogleCredential(credential);
    const email = payload.email;
    const googleId = payload.sub;
    const name = payload.name || email.split('@')[0];

    if (!email) return res.status(400).json({ error: 'Google account has no email' });

    let user = db.prepare(
      'SELECT * FROM users WHERE googleId=? OR email=? LIMIT 1'
    ).get(googleId, email);

    if (!user) {
      let baseUsername = email.split('@')[0].replace(/[^a-zA-Z0-9._-]/g, '');
      if (!baseUsername) baseUsername = 'user';
      let username = baseUsername;
      let n = 1;
      while (db.prepare('SELECT userID FROM users WHERE username=?').get(username)) {
        username = `${baseUsername}${n++}`;
      }

      const randomPass = hashPassword(generateToken());
      const result = db.prepare(`
        INSERT INTO users (
          type, username, password, name, email, googleId, emailVerified,
          address, balance, isDeleted, department, rollNo, designation, position, membershipLevel
        ) VALUES ('student',?,?,?,?,?,1,'',0,0,'',0,'','','')
      `).run(username, randomPass, name, email, googleId);

      user = db.prepare('SELECT * FROM users WHERE userID=?').get(result.lastInsertRowid);
    } else if (user.isDeleted) {
      return res.status(403).json({ error: 'Account is deactivated' });
    } else {
      db.prepare(`
        UPDATE users SET googleId=?, email=?, emailVerified=1
        WHERE userID=? AND (googleId='' OR googleId IS NULL)
      `).run(googleId, email, user.userID);
      user = db.prepare('SELECT * FROM users WHERE userID=?').get(user.userID);
    }

    createSession(req, user);
    const { password: _, ...safe } = user;
    res.json({ user: safe, message: 'Signed in with Google' });
  } catch (e) {
    res.status(401).json({ error: e.message || 'Google sign-in failed' });
  }
});

app.post('/api/login', (req, res) => {
  const login = (req.body.login || req.body.username || req.body.email || '').trim();
  const { password } = req.body;

  if (!login || !password) {
    return res.status(400).json({ error: 'Email/username and password required' });
  }

  const user = findUserByLogin(login);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  if (!verifyPassword(password, user.password)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  upgradePasswordIfNeeded(db, user.userID, password);
  createSession(req, user);

  const { password: _, ...safe } = user;
  res.json({ user: safe });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('lms.sid');
    res.json({ success: true });
  });
});

app.get('/api/me', requireAuth, (req, res) => {
  const user = db.prepare(
    'SELECT * FROM users WHERE userID=?'
  ).get(req.session.user.userID);

  const { password, ...safe } = user;
  res.json(safe);
});

// ===================== USERS =====================

app.get('/api/users', requireAdmin, (req, res) => {
  const users = db.prepare(
    'SELECT * FROM users WHERE type!="admin"'
  ).all().map(({ password, ...u }) => u);

  res.json(users);
});

app.get('/api/users/:id', requireAuth, (req, res) => {
  const requester = req.session.user;
  if (requester.type !== 'admin' && requester.userID != req.params.id) {
    return res.status(403).json({ error: 'Not allowed' });
  }

  const user = db.prepare(
    'SELECT * FROM users WHERE userID=?'
  ).get(req.params.id);

  if (!user) return res.status(404).json({ error: 'Not found' });

  const { password, ...safe } = user;
  res.json(safe);
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE userID=?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  if (user.type === 'admin') return res.status(400).json({ error: 'Cannot delete admin' });
  if (user.isDeleted) return res.status(400).json({ error: 'User already deleted' });

  db.prepare('UPDATE users SET isDeleted=1 WHERE userID=?').run(req.params.id);
  res.json({ success: true });
});

// ===== REGISTER (FIXED PASSWORD HASHING) =====

app.post('/api/users/register', (req, res) => {
  const {
    type, username, password, name, address, email,
    registrationToken, skipOtp,
    balance, department, rollNo, designation,
    position, membershipLevel
  } = req.body;

  if (!['student','teacher','staff','premium'].includes(type)) {
    return res.status(400).json({ error: 'Invalid type' });
  }

  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ error: 'Valid email is required' });
  }

  const isAdminRequest = req.session.user?.type === 'admin';

  if (!skipOtp && !isAdminRequest) {
    if (!registrationToken) {
      return res.status(403).json({ error: 'Email not authorized. Verify OTP first.' });
    }
    const now = Math.floor(Date.now() / 1000);
    const authToken = db.prepare(`
      SELECT * FROM auth_tokens
      WHERE token=? AND purpose='register' AND used=0 AND expiresAt>?
    `).get(registrationToken, now);

    if (!authToken || authToken.email !== email) {
      return res.status(403).json({ error: 'Invalid or expired authorization. Verify OTP again.' });
    }
    db.prepare('UPDATE auth_tokens SET used=1 WHERE token=?').run(registrationToken);
  }

  const existsUser = db.prepare('SELECT userID FROM users WHERE username=?').get(username);
  if (existsUser) return res.status(400).json({ error: 'Username taken' });

  const existsEmail = db.prepare(
    'SELECT userID FROM users WHERE email=? AND isDeleted=0'
  ).get(email);
  if (existsEmail) return res.status(400).json({ error: 'Email already registered' });

  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  const hashed = hashPassword(password);

  const result = db.prepare(`
    INSERT INTO users (
      type, username, password, name, address, email, emailVerified,
      balance, isDeleted, department, rollNo,
      designation, position, membershipLevel
    )
    VALUES (?,?,?,?,?,?,?, ?,0,?,?,?,?,?)
  `).run(
    type, username, hashed, name, address || '', email, 1,
    balance || 0, department || '', rollNo || 0,
    designation || '', position || '', membershipLevel || ''
  );

  res.json({ success: true, userID: result.lastInsertRowid });
});

// ===== PASSWORD CHANGE (FIXED AUTH BUG) =====

app.put('/api/users/:id/password', requireAuth, (req, res) => {
  const { oldPassword, newPassword } = req.body;

  const requester = req.session.user;

  if (requester.userID != req.params.id && requester.type !== 'admin') {
    return res.status(403).json({ error: 'Not allowed' });
  }

  const user = db.prepare(
    'SELECT * FROM users WHERE userID=?'
  ).get(req.params.id);

  if (!user) return res.status(404).json({ error: 'Not found' });

  if (!verifyPassword(oldPassword, user.password)) {
    return res.status(400).json({ error: 'Wrong password' });
  }

  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }

  const hashed = hashPassword(newPassword);

  db.prepare(
    'UPDATE users SET password=? WHERE userID=?'
  ).run(hashed, req.params.id);

  res.json({ success: true });
});

// ===== DEPOSIT =====

app.post('/api/users/:id/deposit', requireAuth, (req, res) => {
  const requester = req.session.user;
  if (requester.type !== 'admin' && requester.userID != req.params.id) {
    return res.status(403).json({ error: 'Not allowed' });
  }

  const { amount } = req.body;

  if (amount <= 0) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  db.prepare(
    'UPDATE users SET balance = balance + ? WHERE userID=?'
  ).run(amount, req.params.id);

  const upgraded = checkAndUpgradeUser(req.params.id);

  const updated = db.prepare(
    'SELECT * FROM users WHERE userID=?'
  ).get(req.params.id);

  res.json({
    success: true,
    newBalance: updated.balance,
    upgraded,
    level: updated.membershipLevel
  });
});

// ===================== RESOURCES =====================

app.get('/api/resources', requireAuth, (req, res) => {
  let sql = 'SELECT * FROM resources WHERE isDeleted=0';
  const params = [];

  if (req.query.type) {
    sql += ' AND type=?';
    params.push(req.query.type);
  }

  sql += ' ORDER BY resourceID ASC';
  res.json(db.prepare(sql).all(...params));
});

app.get('/api/resources/:id', requireAuth, (req, res) => {
  const resource = db.prepare(
    'SELECT * FROM resources WHERE resourceID=? AND isDeleted=0'
  ).get(req.params.id);

  if (!resource) return res.status(404).json({ error: 'Not found' });
  res.json(resource);
});

app.post('/api/resources', requireAdmin, (req, res) => {
  const {
    type, title, authorCreator, category, totalCopies,
    ISBN, publisher, yearPublished,
    director, durationMinutes, genre,
    narrator, format,
    volumeNumber, issueNumber, publicationDate, editionDate, region
  } = req.body;

  if (!['book','dvd','audiobook','magazine','newspaper'].includes(type)) {
    return res.status(400).json({ error: 'Invalid type' });
  }

  const copies = totalCopies || 1;

  const result = db.prepare(`
    INSERT INTO resources (
      type, title, authorCreator, category, totalCopies, availableCopies,
      availabilityStatus, isDeleted, ISBN, publisher, yearPublished,
      director, durationMinutes, genre, narrator, format,
      volumeNumber, issueNumber, publicationDate, editionDate, region
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    type, title, authorCreator || '', category || '', copies, copies,
    'Available', 0, ISBN || '', publisher || '', yearPublished || 0,
    director || '', durationMinutes || 0, genre || '',
    narrator || '', format || '',
    volumeNumber || 0, issueNumber || 0,
    publicationDate || '', editionDate || '', region || ''
  );

  res.json({ success: true, resourceID: result.lastInsertRowid });
});

app.put('/api/resources/:id', requireAdmin, (req, res) => {
  const existing = db.prepare(
    'SELECT * FROM resources WHERE resourceID=? AND isDeleted=0'
  ).get(req.params.id);

  if (!existing) return res.status(404).json({ error: 'Not found' });

  const {
    type, title, authorCreator, category, totalCopies,
    ISBN, publisher, yearPublished,
    director, durationMinutes, genre,
    narrator, format,
    volumeNumber, issueNumber, publicationDate, editionDate, region
  } = req.body;

  const borrowed = existing.totalCopies - existing.availableCopies;
  const newTotal = totalCopies || existing.totalCopies;
  const newAvailable = Math.max(0, newTotal - borrowed);

  db.prepare(`
    UPDATE resources SET
      type=?, title=?, authorCreator=?, category=?,
      totalCopies=?, availableCopies=?,
      ISBN=?, publisher=?, yearPublished=?,
      director=?, durationMinutes=?, genre=?,
      narrator=?, format=?,
      volumeNumber=?, issueNumber=?, publicationDate=?, editionDate=?, region=?
    WHERE resourceID=?
  `).run(
    type || existing.type, title, authorCreator || '', category || '',
    newTotal, newAvailable,
    ISBN || '', publisher || '', yearPublished || 0,
    director || '', durationMinutes || 0, genre || '',
    narrator || '', format || '',
    volumeNumber || 0, issueNumber || 0,
    publicationDate || '', editionDate || '', region || '',
    req.params.id
  );

  updateAvailabilityStatus(req.params.id);
  res.json({ success: true });
});

app.delete('/api/resources/:id', requireAdmin, (req, res) => {
  const result = db.prepare(
    'UPDATE resources SET isDeleted=1 WHERE resourceID=?'
  ).run(req.params.id);

  if (!result.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true });
});

// ===================== BORROW =====================

app.post('/api/borrow', requireAuth, (req, res) => {
  const userID = req.session.user.userID;
  const { resourceID } = req.body;

  const user = db.prepare(
    'SELECT * FROM users WHERE userID=?'
  ).get(userID);

  const resource = db.prepare(
    'SELECT * FROM resources WHERE resourceID=? AND isDeleted=0'
  ).get(resourceID);

  if (!user || !resource) {
    return res.status(404).json({ error: 'Not found' });
  }

  if (user.type === 'admin') {
    return res.status(400).json({ error: 'Admins cannot borrow' });
  }

  if (resource.availableCopies <= 0) {
    return res.status(400).json({ error: 'No copies' });
  }

  const rules = getRoleRules(user);

  const startOfDay = new Date();
  startOfDay.setHours(0,0,0,0);
  const ts = Math.floor(startOfDay.getTime()/1000);

  const count = db.prepare(`
    SELECT COUNT(*) as c FROM borrow_history
    WHERE userID=? AND borrowDate >= ?
  `).get(userID, ts).c;

  if (count >= rules.dailyLimit) {
    return res.status(400).json({ error: 'Daily limit reached' });
  }

  const exists = db.prepare(`
    SELECT id FROM borrow_history
    WHERE userID=? AND resourceID=? AND returnDate=0
  `).get(userID, resourceID);

  if (exists) {
    return res.status(400).json({ error: 'Already borrowed' });
  }

  const now = Math.floor(Date.now()/1000);
  const due = now + rules.borrowDays * 86400;

  db.prepare(
    'UPDATE resources SET availableCopies=availableCopies-1 WHERE resourceID=?'
  ).run(resourceID);

  updateAvailabilityStatus(resourceID);

  db.prepare(`
    INSERT INTO borrow_history
    (userID,resourceID,borrowDate,dueDate,returnDate,fine,durationDays)
    VALUES (?,?,?,?,0,0,?)
  `).run(userID, resourceID, now, due, rules.borrowDays);

  res.json({ success: true, dueDate: due });
});

// ===================== RETURN =====================

app.post('/api/return', requireAuth, (req, res) => {
  const userID = req.session.user.userID;
  const { resourceID } = req.body;

  const record = db.prepare(`
    SELECT * FROM borrow_history
    WHERE userID=? AND resourceID=? AND returnDate=0
  `).get(userID, resourceID);

  if (!record) {
    return res.status(400).json({ error: 'No borrow record' });
  }

  const user = db.prepare(
    'SELECT * FROM users WHERE userID=?'
  ).get(userID);

  const rules = getRoleRules(user);

  const now = Math.floor(Date.now()/1000);

  let fine = 0;

  if (now > record.dueDate) {
    const daysLate = Math.ceil((now - record.dueDate)/86400);
    fine = daysLate * rules.fineRate;

    const newBalance = Math.max(0, user.balance - fine);

    db.prepare(
      'UPDATE users SET balance=? WHERE userID=?'
    ).run(newBalance, userID);
  }

  db.prepare(`
    UPDATE borrow_history
    SET returnDate=?, fine=?
    WHERE id=?
  `).run(now, fine, record.id);

  db.prepare(`
    UPDATE resources
    SET availableCopies=availableCopies+1
    WHERE resourceID=?
  `).run(resourceID);

  updateAvailabilityStatus(resourceID);

  res.json({ success: true, fine });
});

// ===================== HISTORY =====================

app.get('/api/history', requireAuth, (req, res) => {
  const me = req.session.user;

  let sql = `
    SELECT bh.*, r.title AS resourceTitle, r.type AS resourceType, u.name AS userName
    FROM borrow_history bh
    JOIN resources r ON r.resourceID=bh.resourceID
    JOIN users u ON u.userID=bh.userID
  `;
  const params = [];

  if (me.type === 'admin') {
    if (req.query.userID) {
      sql += ' WHERE bh.userID=?';
      params.push(req.query.userID);
    }
  } else {
    sql += ' WHERE bh.userID=?';
    params.push(me.userID);
  }

  sql += ' ORDER BY bh.id DESC';
  res.json(db.prepare(sql).all(...params));
});

app.get('/api/reports/export', requireAdmin, (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  let out = 'Library Management System — Report\n';
  out += `Generated: ${new Date().toISOString()}\n\n`;

  out += '--- Issued Resources ---\n';
  const issued = db.prepare(`
    SELECT resourceID, title, type, totalCopies, availableCopies
    FROM resources WHERE isDeleted=0 AND availableCopies < totalCopies
    ORDER BY resourceID
  `).all();
  if (!issued.length) {
    out += 'No resources are currently issued.\n';
  } else {
    issued.forEach(r => {
      out += `#${r.resourceID} | ${r.title} | ${r.type} | issued: ${r.totalCopies - r.availableCopies}\n`;
    });
  }

  out += '\n--- Overdue Resources ---\n';
  const overdue = db.prepare(`
    SELECT bh.userID, u.name, r.title, bh.dueDate
    FROM borrow_history bh
    JOIN users u ON u.userID=bh.userID
    JOIN resources r ON r.resourceID=bh.resourceID
    WHERE bh.returnDate=0 AND bh.dueDate < ?
    ORDER BY bh.dueDate
  `).all(now);
  if (!overdue.length) {
    out += 'No overdue resources.\n';
  } else {
    overdue.forEach(r => {
      const daysLate = Math.ceil((now - r.dueDate) / 86400);
      out += `User #${r.userID} (${r.name}) | ${r.title} | ${daysLate} days overdue\n`;
    });
  }

  out += '\n--- Members Summary ---\n';
  const members = db.prepare(`
    SELECT userID, name, type, username, balance, isDeleted
    FROM users WHERE type!='admin' ORDER BY userID
  `).all();
  members.forEach(u => {
    out += `#${u.userID} | ${u.name} | ${u.type} | @${u.username} | Rs.${u.balance} | ${u.isDeleted ? 'Deleted' : 'Active'}\n`;
  });

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="library-report.txt"');
  res.send(out);
});

app.post('/api/donations', requireAdmin, (req, res) => {
  const {
    userID, type, title, authorCreator, category, totalCopies,
    ISBN, publisher, yearPublished,
    director, durationMinutes, genre,
    narrator, format,
    volumeNumber, issueNumber, publicationDate, editionDate, region
  } = req.body;

  const user = db.prepare('SELECT * FROM users WHERE userID=? AND isDeleted=0').get(userID);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!['book','dvd','audiobook','magazine','newspaper'].includes(type)) {
    return res.status(400).json({ error: 'Invalid resource type' });
  }

  const copies = totalCopies || 1;
  const reward = 100;

  const tx = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO resources (
        type, title, authorCreator, category, totalCopies, availableCopies,
        availabilityStatus, isDeleted, ISBN, publisher, yearPublished,
        director, durationMinutes, genre, narrator, format,
        volumeNumber, issueNumber, publicationDate, editionDate, region
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      type, title, authorCreator || '', category || '', copies, copies,
      'Available', 0, ISBN || '', publisher || '', yearPublished || 0,
      director || '', durationMinutes || 0, genre || '',
      narrator || '', format || '',
      volumeNumber || 0, issueNumber || 0,
      publicationDate || '', editionDate || '', region || ''
    );

    db.prepare('UPDATE users SET balance = balance + ? WHERE userID=?').run(reward, userID);
    checkAndUpgradeUser(userID);

    return result.lastInsertRowid;
  });

  const resourceID = tx();
  const updated = db.prepare('SELECT balance FROM users WHERE userID=?').get(userID);

  res.json({
    success: true,
    resourceID,
    reward,
    newBalance: updated.balance
  });
});

// ===================== ISSUED & FINES =====================

app.get('/api/issued', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT resourceID, title, type, totalCopies, availableCopies,
           (totalCopies - availableCopies) AS issuedCopies
    FROM resources
    WHERE isDeleted=0 AND availableCopies < totalCopies
    ORDER BY issuedCopies DESC
  `).all();
  res.json(rows);
});

app.get('/api/fines', requireAdmin, (req, res) => {
  const now = Math.floor(Date.now() / 1000);

  const rows = db.prepare(`
    SELECT bh.*, u.name AS userName, u.type AS userType, u.membershipLevel,
           r.title AS resourceTitle
    FROM borrow_history bh
    JOIN users u ON u.userID = bh.userID
    JOIN resources r ON r.resourceID = bh.resourceID
    WHERE bh.returnDate = 0 AND bh.dueDate < ?
    ORDER BY bh.dueDate ASC
  `).all(now);

  res.json(rows.map(row => {
    const rules = getRoleRules(row);
    const daysLate = Math.ceil((now - row.dueDate) / 86400);
    return {
      userID: row.userID,
      userName: row.userName,
      resourceTitle: row.resourceTitle,
      borrowDate: row.borrowDate,
      dueDate: row.dueDate,
      daysLate,
      pendingFine: daysLate * rules.fineRate
    };
  }));
});

// ===================== STATS =====================

app.get('/api/stats', requireAdmin, (req, res) => {
  const now = Math.floor(Date.now()/1000);

  const totalUsers = db.prepare(
    'SELECT COUNT(*) as c FROM users WHERE isDeleted=0 AND type!="admin"'
  ).get().c;

  const totalResources = db.prepare(
    'SELECT COUNT(*) as c FROM resources WHERE isDeleted=0'
  ).get().c;

  const totalBorrows = db.prepare(
    'SELECT COUNT(*) as c FROM borrow_history'
  ).get().c;

  const activeBorrows = db.prepare(
    'SELECT COUNT(*) as c FROM borrow_history WHERE returnDate=0'
  ).get().c;

  const overdue = db.prepare(
    'SELECT COUNT(*) as c FROM borrow_history WHERE returnDate=0 AND dueDate<?'
  ).get(now).c;

  const totalFines = db.prepare(
    'SELECT COALESCE(SUM(fine),0) as s FROM borrow_history'
  ).get().s;

  const byType = db.prepare(`
    SELECT type, COUNT(*) as count FROM resources
    WHERE isDeleted=0 GROUP BY type ORDER BY count DESC
  `).all();

  const usersByType = db.prepare(`
    SELECT type, COUNT(*) as count FROM users
    WHERE isDeleted=0 AND type!='admin' GROUP BY type ORDER BY count DESC
  `).all();

  const mostBorrowed = db.prepare(`
    SELECT r.title, COUNT(*) as cnt
    FROM borrow_history bh
    JOIN resources r ON r.resourceID = bh.resourceID
    GROUP BY bh.resourceID
    ORDER BY cnt DESC LIMIT 1
  `).get();

  res.json({
    totalUsers,
    totalResources,
    totalBorrows,
    activeBorrows,
    overdue: overdue,
    overdueCount: overdue,
    totalFines,
    byType,
    usersByType,
    mostBorrowed: mostBorrowed || null
  });
});

// ===================== SPA =====================

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`📚 LMS running on http://localhost:${PORT}`);
});