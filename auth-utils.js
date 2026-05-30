require('dotenv').config();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { OAuth2Client } = require('google-auth-library');

const SALT_ROUNDS = 12;

function hashPassword(plain) {
  return bcrypt.hashSync(plain, SALT_ROUNDS);
}

function isHashed(stored) {
  return typeof stored === 'string' && stored.startsWith('$2');
}

function verifyPassword(plain, stored) {
  if (isHashed(stored)) return bcrypt.compareSync(plain, stored);
  return plain === stored;
}

function upgradePasswordIfNeeded(db, userID, plain) {
  const user = db.prepare('SELECT password FROM users WHERE userID=?').get(userID);
  if (user && !isHashed(user.password)) {
    db.prepare('UPDATE users SET password=? WHERE userID=?').run(hashPassword(plain), userID);
  }
}

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isPlaceholder(val) {
  if (!val) return true;
  return /your@gmail|your-16-char|your-client-id|change-me/i.test(val);
}

function getMailer() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass || isPlaceholder(user) || isPlaceholder(pass)) return null;

  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass }
  });
}

async function sendOtpEmail(email, code, purpose) {
  const subject = purpose === 'register'
    ? 'LMS — Verify your email (OTP)'
    : 'LMS — Your verification code';

  const text = `Your LMS verification code is: ${code}\n\nThis code expires in 10 minutes. Do not share it with anyone.`;

  const transporter = getMailer();
  if (!transporter) {
    throw new Error(
      'Email is not configured on the server. Set GMAIL_USER and GMAIL_APP_PASSWORD in the .env file (use a Gmail App Password).'
    );
  }

  await transporter.sendMail({
    from: `"Library LMS" <${process.env.GMAIL_USER}>`,
    to: email,
    subject,
    text
  });
  return { sent: true };
}

async function verifyGoogleCredential(credential) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) throw new Error('Google Sign-In is not configured on the server');

  const client = new OAuth2Client(clientId);
  const ticket = await client.verifyIdToken({
    idToken: credential,
    audience: clientId
  });
  return ticket.getPayload();
}

function authConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID || '';
  const googleReady = Boolean(clientId) && !isPlaceholder(clientId);
  return {
    googleClientId: googleReady ? clientId : '',
    googleEnabled: googleReady,
    otpRequired: true,
    emailLoginEnabled: true
  };
}

module.exports = {
  hashPassword,
  isHashed,
  verifyPassword,
  upgradePasswordIfNeeded,
  generateOtp,
  generateToken,
  isValidEmail,
  sendOtpEmail,
  verifyGoogleCredential,
  authConfig
};
