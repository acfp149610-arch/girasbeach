
const router = require("express").Router();
const { requireAuth } = require("../middleware/auth");

function localParts(iso) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(iso));

  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));

  const days = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3,
    Thu: 4, Fri: 5, Sat: 6
  };

  return {
    date: `${p.year}-${p.month}-${p.day}`,
    weekday: days[p.weekday],
    time: `${p.hour}:${p.minute}`
  };
}

function validDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) return false;

  const parsed = new Date(`${date}T12:00:00Z`);

  return Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === date;
}

function minutes(time) {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

function localISO(date, time) {
  return new Date(`${date}T${time}:00-03:00`).toISOString();
}

function expirePending(db) {
  db.prepare(`
    UPDATE bookings
    SET status = 'expired'
    WHERE status = 'pending_payment'
      AND expires_at IS NOT NULL
      AND expires_at <= ?
  `).run(new Date().toISOString());
}

// DISPONIBILIDADE
router.get("/availability", (req, res) => {
  const { date, courtId } = req.query;

  if (!validDate(date) || !courtId) {
    return res.status(400).json({
      error: "Informe uma data válida e uma quadra."
    });
  }

  const db = req.app.locals.db;

  try {
    expirePending(db);

    const court = db.prepare(`
      SELECT id FROM courts
      WHERE id = ? AND active = 1
    `).get(courtId);

    if (!court) {
      return res.status(404).json({
        error: "Quadra não encontrada ou inativa."
      });
    }

    const dayStart = localISO(date, "00:00");

    const nextDate = new Date(
      new Date(`${date}T12:00:00Z`).getTime() + 86400000
    ).toISOString().slice(0, 10);

    const dayEnd = localISO(nextDate, "00:00");

    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();

    const schedules = db.prepare(`
      SELECT start_time, end_time, slot_minutes, price_cents
      FROM opening_hours
      WHERE weekday = ? AND active = 1
      ORDER BY start_time
    `).all(weekday);

    const occupied = db.prepare(`
      SELECT starts_at, ends_at
      FROM bookings
      WHERE court_id = ?
        AND starts_at < ?
        AND ends_at > ?
        AND status = 'confirmed'

      UNION ALL

      SELECT starts_at, ends_at
      FROM blocked_slots
      WHERE court_id = ?
        AND starts_at < ?
        AND ends_at > ?
    `).all(courtId, dayEnd, dayStart, courtId, dayEnd, dayStart);

    const available = [];
    const now = Date.now();

    for (const schedule of schedules) {
      const opening = minutes(schedule.start_time);
      const closing = minutes(schedule.end_time);
      const duration = Number(schedule.slot_minutes);

      if (!Number.isInteger(duration) || duration < 30) continue;

      for (
        let startMinute = opening;
        startMinute + duration <= closing;
        startMinute += duration
      ) {
        const endMinute = startMinute + duration;

        const time =
          `${String(Math.floor(startMinute / 60)).padStart(2, "0")}:` +
          `${String(startMinute % 60).padStart(2, "0")}`;

        const endTime =
          `${String(Math.floor(endMinute / 60)).padStart(2, "0")}:` +
          `${String(endMinute % 60).padStart(2, "0")}`;

        const startsAt = localISO(date, time);
        const endsAt = localISO(date, endTime);

        if (new Date(startsAt).getTime() <= now) continue;

        const conflict = occupied.some(item =>
          new Date(startsAt) < new Date(item.ends_at) &&
          new Date(endsAt) > new Date(item.starts_at)
        );

        if (!conflict) {
          available.push({
            time,
            startsAt,
            endsAt,
            priceCents: schedule.price_cents,
            slotMinutes: duration
          });
        }
      }
    }

    res.json({ available });
  } catch (error) {
    console.error("Disponibilidade:", error);

    res.status(500).json({
      error: "Não foi possível consultar os horários."
    });
  }
});

// RESERVAS DO CLIENTE
router.get("/mine", requireAuth, (req, res) => {
  const db = req.app.locals.db;

  expirePending(db);

  const bookings = db.prepare(`
    SELECT
      b.id,
      b.starts_at,
      b.ends_at,
      b.amount_cents,
      b.status,
      c.name AS court_name
    FROM bookings b
    JOIN courts c ON c.id = b.court_id
    WHERE b.user_id = ?
    ORDER BY b.starts_at DESC
  `).all(req.session.user.id);

  res.json({ bookings });
});

// CRIAR RESERVA TEMPORÁRIA
router.post("/", requireAuth, (req, res) => {
  const { courtId, startsAt, endsAt } = req.body;

  const start = new Date(startsAt);
  const end = new Date(endsAt);

  if (
    !courtId ||
    !Number.isFinite(start.getTime()) ||
    !Number.isFinite(end.getTime()) ||
    end <= start ||
    start.getTime() <= Date.now()
  ) {
    return res.status(400).json({
      error: "Horário de reserva inválido ou passado."
    });
  }

  const db = req.app.locals.db;

  const startIso = start.toISOString();
  const endIso = end.toISOString();

  try {
    const create = db.transaction(() => {
      expirePending(db);

      const court = db.prepare(`
        SELECT id FROM courts
        WHERE id = ? AND active = 1
      `).get(courtId);

      if (!court) {
        throw Object.assign(
          new Error("Quadra indisponível."),
          { status: 404 }
        );
      }

      const startParts = localParts(startIso);
      const endParts = localParts(endIso);

      if (startParts.date !== endParts.date) {
        throw Object.assign(
          new Error("A reserva deve começar e terminar no mesmo dia."),
          { status: 400 }
        );
      }

      const duration = (end - start) / 60000;
      const startMinute = minutes(startParts.time);
      const endMinute = minutes(endParts.time);

      const schedules = db.prepare(`
        SELECT start_time, end_time, slot_minutes, price_cents
        FROM opening_hours
        WHERE weekday = ? AND active = 1
      `).all(startParts.weekday);

      const schedule = schedules.find(item => {
        const opening = minutes(item.start_time);
        const closing = minutes(item.end_time);
        const slot = Number(item.slot_minutes);

        return (
          duration === slot &&
          startMinute >= opening &&
          endMinute <= closing &&
          (startMinute - opening) % slot === 0
        );
      });

      if (!schedule) {
        throw Object.assign(
          new Error("Este horário não está na programação."),
          { status: 400 }
        );
      }

      const conflict = db.prepare(`
        SELECT id
        FROM bookings
        WHERE court_id = ?
          AND status = 'confirmed'
          AND starts_at < ?
          AND ends_at > ?
        LIMIT 1
      `).get(courtId, endIso, startIso);

      const blocked = db.prepare(`
        SELECT id
        FROM blocked_slots
        WHERE court_id = ?
          AND starts_at < ?
          AND ends_at > ?
        LIMIT 1
      `).get(courtId, endIso, startIso);

      if (conflict || blocked) {
        throw Object.assign(
          new Error("Este horário acabou de ficar indisponível."),
          { status: 409 }
        );
      }

      const expires = new Date(
        Date.now() + 15 * 60 * 1000
      ).toISOString();

      const result = db.prepare(`
        INSERT INTO bookings (
          user_id, court_id, starts_at, ends_at,
          amount_cents, status, expires_at
        )
        VALUES (?, ?, ?, ?, ?, 'pending_payment', ?)
      `).run(
        req.session.user.id,
        courtId,
        startIso,
        endIso,
        schedule.price_cents,
        expires
      );

      return db.prepare(`
        SELECT id, starts_at, ends_at, amount_cents, status, expires_at
        FROM bookings WHERE id = ?
      `).get(result.lastInsertRowid);
    });

    const booking = create.immediate();

    res.status(201).json({
      booking,
      message: "Finalize o pagamento em até 15 minutos."
    });
  } catch (error) {
    console.error("Criar reserva:", error);

    res.status(error.status || 500).json({
      error: error.status
        ? error.message
        : "Não foi possível criar a reserva."
    });
  }
});

// CANCELAR RESERVA DO CLIENTE
router.post("/:id/cancel", requireAuth, (req, res) => {
  const result = req.app.locals.db.prepare(`
    UPDATE bookings
    SET status = 'cancelled'
    WHERE id = ?
      AND user_id = ?
      AND status = 'pending_payment'
  `).run(req.params.id, req.session.user.id);

  if (!result.changes) {
    return res.status(400).json({
      error: "Reserva não encontrada ou não pode ser cancelada."
    });
  }

  res.json({ ok: true });
});

module.exports = router;
