const router = require('express').Router();
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const loginLimit = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, message: { error: 'Muitas tentativas. Tente novamente mais tarde.' } });

router.post('/register', async (req, res) => {
  const { name, email, phone, password } = req.body;
  if (!name || !email || !phone || !password || String(password).length < 10) return res.status(400).json({ error: 'Informe nome, e-mail, telefone e senha com pelo menos 10 caracteres.' });
  const db = req.app.locals.db;
  try {
    const hash = await bcrypt.hash(password, 12);
    const result = db.prepare('INSERT INTO users (name,email,phone,password_hash) VALUES (?,?,?,?)').run(name.trim(), email.trim().toLowerCase(), phone.trim(), hash);
    const user = db.prepare('SELECT id,name,email,phone,role FROM users WHERE id=?').get(result.lastInsertRowid);
    req.session.user = user;
    res.status(201).json({ user });
  } catch (err) {
    if (String(err.code).includes('SQLITE_CONSTRAINT_UNIQUE')) return res.status(409).json({ error: 'Este e-mail já está cadastrado.' });
    console.error('Cadastro:', err);
    res.status(500).json({ error: 'Não foi possível criar a conta. Verifique os dados e tente novamente.' });
  }
});
router.post('/login', loginLimit, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Informe e-mail e senha.' });
  const user = req.app.locals.db.prepare('SELECT * FROM users WHERE email=?').get(email.trim().toLowerCase());
  if (!user || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'Erro ao iniciar sessão.' });
    const safeUser = { id: user.id, name: user.name, email: user.email, phone: user.phone, role: user.role };
    req.session.user = safeUser;
    res.json({ user: safeUser });
  });
});
router.post('/logout', (req, res) => req.session.destroy(() => { res.clearCookie('connect.sid'); res.json({ ok: true }); }));
router.get('/me', (req, res) => res.json({ user: req.session.user || null }));
module.exports = router;
