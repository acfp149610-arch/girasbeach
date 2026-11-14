
const router = require("express").Router();
const { requireAdmin } = require("../middleware/auth");

router.use(requireAdmin);

// PAINEL
router.get("/dashboard", (req, res) => {
  const db = req.app.locals.db;

  const counts = db.prepare(`
    SELECT
      SUM(CASE WHEN status='confirmed' THEN 1 ELSE 0 END) AS confirmed,
      SUM(CASE WHEN status='pending_payment' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) AS cancelled
    FROM bookings
  `).get();

  const revenue = db.prepare(`
    SELECT COALESCE(SUM(amount_cents),0) AS cents
    FROM bookings WHERE status='confirmed'
  `).get();

  res.json({
    counts,
    revenueCents: revenue.cents
  });
});

// QUADRAS
router.get("/courts", (req, res) => {
  const courts = req.app.locals.db.prepare(`
    SELECT * FROM courts ORDER BY id
  `).all();

  res.json({ courts });
});

router.post("/courts", (req, res) => {
  const { name, description = "" } = req.body;

  if (!name || !String(name).trim()) {
    return res.status(400).json({
      error: "Informe o nome da quadra."
    });
  }

  const db = req.app.locals.db;

  const result = db.prepare(`
    INSERT INTO courts (name, description)
    VALUES (?, ?)
  `).run(String(name).trim(), description);

  res.status(201).json({
    court: db.prepare("SELECT * FROM courts WHERE id=?")
      .get(result.lastInsertRowid)
  });
});

router.patch("/courts/:id", (req, res) => {
  const { name, description, active } = req.body;
  const db = req.app.locals.db;

  const current = db.prepare(`
    SELECT * FROM courts WHERE id=?
  `).get(req.params.id);

  if (!current) {
    return res.status(404).json({
      error: "Quadra não encontrada."
    });
  }

  if (name !== undefined && !String(name).trim()) {
    return res.status(400).json({
      error: "O nome não pode ficar vazio."
    });
  }

  db.prepare(`
    UPDATE courts
    SET name=?, description=?, active=?
    WHERE id=?
  `).run(
    name !== undefined ? String(name).trim() : current.name,
    description !== undefined ? description : current.description,
    typeof active === "boolean" ? (active ? 1 : 0) : current.active,
    req.params.id
  );

  res.json({
    court: db.prepare("SELECT * FROM courts WHERE id=?")
      .get(req.params.id)
  });
});

router.delete("/courts/:id", (req, res) => {
  const db = req.app.locals.db;

  const court = db.prepare(`
    SELECT id FROM courts WHERE id=?
  `).get(req.params.id);

  if (!court) {
    return res.status(404).json({
      error: "Quadra não encontrada."
    });
  }

  const bookings = db.prepare(`
    SELECT COUNT(*) AS total FROM bookings WHERE court_id=?
  `).get(req.params.id).total;

  const blocks = db.prepare(`
    SELECT COUNT(*) AS total FROM blocked_slots WHERE court_id=?
  `).get(req.params.id).total;

  if (bookings || blocks) {
    return res.status(409).json({
      error: "A quadra possui reservas ou bloqueios. Desative-a."
    });
  }

  db.prepare("DELETE FROM courts WHERE id=?").run(req.params.id);

  res.json({ message: "Quadra excluída." });
});

// RESERVAS
router.get("/bookings", (req, res) => {
  const bookings = req.app.locals.db.prepare(`
    SELECT
      b.*,
      u.name AS customer,
      u.email,
      u.phone,
      c.name AS court
    FROM bookings b
    JOIN users u ON u.id=b.user_id
    JOIN courts c ON c.id=b.court_id
    ORDER BY b.starts_at DESC
    LIMIT 300
  `).all();

  res.json({ bookings });
});

// O ADMINISTRADOR PODE CANCELAR, MAS NÃO CONFIRMAR.
router.patch("/bookings/:id", (req, res) => {
  if (req.body.status !== "cancelled") {
    return res.status(403).json({
      error: "Somente o Mercado Pago pode confirmar pagamentos."
    });
  }

  const result = req.app.locals.db.prepare(`
    UPDATE bookings
    SET status='cancelled'
    WHERE id=? AND status IN ('pending_payment','confirmed')
  `).run(req.params.id);

  if (!result.changes) {
    return res.status(404).json({
      error: "Reserva não encontrada ou não pode ser cancelada."
    });
  }

  res.json({ ok: true });
});

// HORÁRIOS
router.get("/opening-hours", (req, res) => {
  const openingHours = req.app.locals.db.prepare(`
    SELECT * FROM opening_hours
    ORDER BY weekday, start_time
  `).all();

  res.json({ openingHours });
});

function validOpeningHour(data) {
  const weekday = Number(data.weekday);
  const slotMinutes = Number(data.slotMinutes);
  const priceCents = Number(data.priceCents);

  return (
    Number.isInteger(weekday) &&
    weekday >= 0 && weekday <= 6 &&
    /^([01]\d|2[0-3]):[0-5]\d$/.test(data.startTime || "") &&
    /^([01]\d|2[0-3]):[0-5]\d$/.test(data.endTime || "") &&
    data.startTime < data.endTime &&
    Number.isInteger(slotMinutes) &&
    slotMinutes >= 30 && slotMinutes <= 240 &&
    Number.isInteger(priceCents) &&
    priceCents >= 0
  );
}

router.post("/opening-hours", (req, res) => {
  const data = req.body;

  if (!validOpeningHour(data)) {
    return res.status(400).json({
      error: "Confira dia, horários, duração e preço."
    });
  }

  const db = req.app.locals.db;

  const result = db.prepare(`
    INSERT INTO opening_hours
    (weekday, start_time, end_time, slot_minutes, price_cents)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    Number(data.weekday),
    data.startTime,
    data.endTime,
    Number(data.slotMinutes),
    Number(data.priceCents)
  );

  res.status(201).json({
    openingHour: db.prepare(`
      SELECT * FROM opening_hours WHERE id=?
    `).get(result.lastInsertRowid)
  });
});

// EDITAR HORÁRIO E PREÇO
router.patch("/opening-hours/:id", (req, res) => {
  const db = req.app.locals.db;

  const current = db.prepare(`
    SELECT * FROM opening_hours WHERE id=?
  `).get(req.params.id);

  if (!current) {
    return res.status(404).json({
      error: "Configuração não encontrada."
    });
  }

  const data = {
    weekday: req.body.weekday ?? current.weekday,
    startTime: req.body.startTime ?? current.start_time,
    endTime: req.body.endTime ?? current.end_time,
    slotMinutes: req.body.slotMinutes ?? current.slot_minutes,
    priceCents: req.body.priceCents ?? current.price_cents
  };

  if (!validOpeningHour(data)) {
    return res.status(400).json({
      error: "Confira os dados do horário."
    });
  }

  db.prepare(`
    UPDATE opening_hours
    SET weekday=?, start_time=?, end_time=?,
        slot_minutes=?, price_cents=?
    WHERE id=?
  `).run(
    Number(data.weekday),
    data.startTime,
    data.endTime,
    Number(data.slotMinutes),
    Number(data.priceCents),
    req.params.id
  );

  res.json({
    openingHour: db.prepare(`
      SELECT * FROM opening_hours WHERE id=?
    `).get(req.params.id)
  });
});

router.delete("/opening-hours/:id", (req, res) => {
  const result = req.app.locals.db.prepare(`
    DELETE FROM opening_hours WHERE id=?
  `).run(req.params.id);

  if (!result.changes) {
    return res.status(404).json({
      error: "Horário não encontrado."
    });
  }

  res.json({ message: "Horário excluído." });
});

// BLOQUEAR HORÁRIOS
router.post("/blocks", (req, res) => {
  const { courtId, startsAt, endsAt, reason = "" } = req.body;

  const start = new Date(startsAt);
  const end = new Date(endsAt);

  if (
    !courtId ||
    !Number.isFinite(start.getTime()) ||
    !Number.isFinite(end.getTime()) ||
    end <= start
  ) {
    return res.status(400).json({
      error: "Dados inválidos."
    });
  }

  const db = req.app.locals.db;

  const court = db.prepare(`
    SELECT id FROM courts WHERE id=? AND active=1
  `).get(courtId);

  if (!court) {
    return res.status(404).json({
      error: "Quadra não encontrada."
    });
  }

  const conflict = db.prepare(`
    SELECT id FROM bookings
    WHERE court_id=?
      AND status='confirmed'
      AND starts_at<?
      AND ends_at>?
    LIMIT 1
  `).get(courtId, end.toISOString(), start.toISOString());

  if (conflict) {
    return res.status(409).json({
      error: "Já existe uma reserva confirmada nesse horário."
    });
  }

  const result = db.prepare(`
    INSERT INTO blocked_slots
    (court_id, starts_at, ends_at, reason)
    VALUES (?, ?, ?, ?)
  `).run(
    courtId,
    start.toISOString(),
    end.toISOString(),
    reason
  );

  res.status(201).json({
    block: db.prepare(`
      SELECT * FROM blocked_slots WHERE id=?
    `).get(result.lastInsertRowid)
  });
});

module.exports = router;
