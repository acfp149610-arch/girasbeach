require('dotenv').config();
if (
  process.env.NODE_ENV === "production" &&
  !process.env.SESSION_SECRET
) {
  throw new Error("SESSION_SECRET não configurado.");
}
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const rateLimit = require('express-rate-limit');
const path = require('path');
const { db, initialize, dbPath } = require('./src/database/db');

initialize();
const authRoutes = require('./src/routes/auth');
const bookingRoutes = require('./src/routes/bookings');
const adminRoutes = require('./src/routes/admin');
const paymentRoutes = require('./src/routes/payments');
const app = express();
app.locals.db = db;
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '200kb' }));
app.use(express.urlencoded({ extended: false }));
app.use(session({
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data'), table: 'sessions' }),
  secret: process.env.SESSION_SECRET || 'development-only-change-this-secret-before-deploy',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 8 }
}));
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, limit: 250 }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/health', (req, res) => {
  try { db.prepare('SELECT 1').get(); res.json({ ok: true, database: 'connected', type: 'SQLite' }); }
  catch { res.status(503).json({ ok: false, database: 'unavailable' }); }
});
app.use('/api/auth', authRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/payments', paymentRoutes);
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Ocorreu um erro interno. Tente novamente.' });
});
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`GIRA'S BEACH rodando em http://localhost:${port}\nBanco SQLite: ${dbPath}`));
