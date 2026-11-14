
const router = require("express").Router();
const crypto = require("crypto");
const { requireAuth } = require("../middleware/auth");

const {
  MercadoPagoConfig,
  Payment,
  Preference
} = require("mercadopago");

function mpClient() {
  if (!process.env.MP_ACCESS_TOKEN) {
    throw new Error("Mercado Pago não configurado.");
  }

  return new MercadoPagoConfig({
    accessToken: process.env.MP_ACCESS_TOKEN
  });
}

function expirePending(db) {
  db.prepare(`
    UPDATE bookings
    SET status = 'expired'
    WHERE status = 'pending_payment'
      AND expires_at <= ?
  `).run(new Date().toISOString());
}

function validSignature(signature, requestId, dataId, secret) {
  if (!signature || !requestId || !dataId || !secret) return false;

  const parts = {};

  for (const item of signature.split(",")) {
    const [key, value] = item.trim().split("=", 2);
    if (key && value) parts[key] = value;
  }

  if (!parts.ts || !parts.v1) return false;

  const timestamp = Number(parts.ts);
  if (!Number.isFinite(timestamp)) return false;

  const timestampMs = timestamp < 1e12
    ? timestamp * 1000
    : timestamp;

  if (Math.abs(Date.now() - timestampMs) > 5 * 60 * 1000) {
    return false;
  }

  const manifest =
    `id:${String(dataId).toLowerCase()};` +
    `request-id:${requestId};` +
    `ts:${parts.ts};`;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(manifest)
    .digest("hex");

  const receivedBuffer = Buffer.from(parts.v1, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");

  return (
    receivedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(receivedBuffer, expectedBuffer)
  );
}

// CRIAR CHECKOUT
router.post("/checkout", requireAuth, async (req, res) => {
  const { bookingId, method } = req.body;

  if (!bookingId || !["pix", "card"].includes(method)) {
    return res.status(400).json({
      error: "Informe a reserva e a forma de pagamento."
    });
  }

  if (!process.env.BASE_URL) {
    return res.status(503).json({
      error: "Endereço público do site não configurado."
    });
  }

  const db = req.app.locals.db;

  expirePending(db);

  const booking = db.prepare(`
    SELECT b.*, u.email, u.name
    FROM bookings b
    JOIN users u ON u.id = b.user_id
    WHERE b.id = ?
      AND b.user_id = ?
      AND b.status = 'pending_payment'
      AND b.expires_at > ?
  `).get(
    bookingId,
    req.session.user.id,
    new Date().toISOString()
  );

  if (!booking) {
    return res.status(404).json({
      error: "Reserva não encontrada ou expirada."
    });
  }

  try {
    const client = mpClient();
    const amount = Number(booking.amount_cents) / 100;

    if (method === "pix") {
      const result = await new Payment(client).create({
        body: {
          transaction_amount: amount,
          description: `GIRA'S BEACH - Reserva #${booking.id}`,
          payment_method_id: "pix",
          external_reference: String(booking.id),
          notification_url:
            `${process.env.BASE_URL}/api/payments/webhook`,
          payer: {
            email: booking.email,
            first_name: booking.name
          }
        }
      });

      if (!result.id) {
        throw new Error("Mercado Pago não retornou o identificador.");
      }

      db.prepare(`
        INSERT INTO payments (
          booking_id, provider, provider_payment_id,
          status, amount_cents, raw_status
        )
        VALUES (?, 'mercado_pago', ?, ?, ?, ?)
        ON CONFLICT(booking_id)
        DO UPDATE SET
          provider_payment_id = excluded.provider_payment_id,
          status = excluded.status,
          amount_cents = excluded.amount_cents,
          raw_status = excluded.raw_status,
          updated_at = datetime('now')
      `).run(
        booking.id,
        String(result.id),
        result.status || "pending",
        booking.amount_cents,
        result.status_detail || ""
      );

      return res.json({
        paymentId: result.id,
        status: result.status,
        qrCode:
          result.point_of_interaction?.transaction_data?.qr_code || null,
        qrCodeBase64:
          result.point_of_interaction?.transaction_data?.qr_code_base64 || null,
        ticketUrl:
          result.point_of_interaction?.transaction_data?.ticket_url || null
      });
    }

    const preference = await new Preference(client).create({
      body: {
        items: [{
          id: String(booking.id),
          title: `GIRA'S BEACH - Reserva #${booking.id}`,
          quantity: 1,
          unit_price: amount,
          currency_id: "BRL"
        }],
        payer: {
          email: booking.email,
          name: booking.name
        },
        external_reference: String(booking.id),
        back_urls: {
          success: `${process.env.BASE_URL}/?payment=success`,
          failure: `${process.env.BASE_URL}/?payment=failure`,
          pending: `${process.env.BASE_URL}/?payment=pending`
        },
        auto_return: "approved",
        notification_url:
          `${process.env.BASE_URL}/api/payments/webhook`
      }
    });

    if (!preference.id || !preference.init_point) {
      throw new Error("Checkout não retornado pelo Mercado Pago.");
    }

    db.prepare(`
      INSERT INTO payments (
        booking_id, provider, provider_payment_id,
        status, amount_cents
      )
      VALUES (?, 'mercado_pago', ?, 'preference_created', ?)
      ON CONFLICT(booking_id)
      DO UPDATE SET
        provider_payment_id = excluded.provider_payment_id,
        status = 'preference_created',
        amount_cents = excluded.amount_cents,
        updated_at = datetime('now')
    `).run(
      booking.id,
      String(preference.id),
      booking.amount_cents
    );

    return res.json({
      checkoutUrl: preference.init_point,
      sandboxCheckoutUrl: preference.sandbox_init_point
    });

  } catch (error) {
    console.error("Checkout Mercado Pago:", error.message);

    return res.status(503).json({
      error: "Não foi possível iniciar o pagamento."
    });
  }
});

// CONSULTAR STATUS DA RESERVA
router.get("/status/:bookingId", requireAuth, (req, res) => {
  const db = req.app.locals.db;

  expirePending(db);

  const booking = db.prepare(`
    SELECT id, status, expires_at
    FROM bookings
    WHERE id = ? AND user_id = ?
  `).get(req.params.bookingId, req.session.user.id);

  if (!booking) {
    return res.status(404).json({
      error: "Reserva não encontrada."
    });
  }

  res.json({
    bookingId: booking.id,
    status: booking.status,
    expiresAt: booking.expires_at
  });
});

// WEBHOOK
router.post("/webhook", async (req, res) => {
  try {
    const secret = process.env.MP_WEBHOOK_SECRET;

    if (!secret || !process.env.MP_ACCESS_TOKEN) {
      console.error("Credenciais do webhook ausentes.");
      return res.sendStatus(503);
    }

    const paymentId = req.query["data.id"];

    if (!paymentId || typeof paymentId !== "string") {
      return res.sendStatus(400);
    }

    const valid = validSignature(
      req.headers["x-signature"],
      req.headers["x-request-id"],
      paymentId,
      secret
    );

    if (!valid) {
      console.error("Assinatura do webhook inválida.");
      return res.sendStatus(401);
    }

    const details = await new Payment(mpClient()).get({
      id: paymentId
    });

    const bookingId = Number(details.external_reference);

    if (!Number.isSafeInteger(bookingId) || bookingId <= 0) {
      return res.sendStatus(200);
    }

    const db = req.app.locals.db;

    const process = db.transaction(() => {
      const booking = db.prepare(`
        SELECT * FROM bookings WHERE id = ?
      `).get(bookingId);

      const payment = db.prepare(`
        SELECT * FROM payments
        WHERE booking_id = ?
          AND provider = 'mercado_pago'
      `).get(bookingId);

      if (!booking || !payment) return "not_found";

      const amountCents = Math.round(
        Number(details.transaction_amount) * 100
      );

      if (
        details.currency_id !== "BRL" ||
        amountCents !== Number(booking.amount_cents) ||
        amountCents !== Number(payment.amount_cents)
      ) {
        return "invalid_amount";
      }

      // Pagamento já processado: não repetir confirmação.
      if (
        booking.status === "confirmed" &&
        booking.payment_provider_id === String(paymentId)
      ) {
        return "already_processed";
      }

      db.prepare(`
        UPDATE payments
        SET provider_payment_id = ?,
            status = ?,
            raw_status = ?,
            updated_at = datetime('now')
        WHERE booking_id = ?
      `).run(
        String(paymentId),
        details.status || "unknown",
        details.status_detail || "",
        bookingId
      );

      if (details.status !== "approved") {
        if (
          ["rejected", "cancelled"].includes(details.status) &&
          booking.status === "pending_payment"
        ) {
          db.prepare(`
            UPDATE bookings
            SET status = 'expired'
            WHERE id = ? AND status = 'pending_payment'
          `).run(bookingId);
        }

        return "not_approved";
      }

      // Nunca confirmar reserva expirada ou cancelada.
      if (booking.status !== "pending_payment") {
        db.prepare(`
          UPDATE payments
          SET status = 'approved_needs_review',
              raw_status = 'Pagamento aprovado após expiração ou cancelamento',
              updated_at = datetime('now')
          WHERE booking_id = ?
        `).run(bookingId);

        return "approved_after_expiration";
      }

      const conflict = db.prepare(`
        SELECT id
        FROM bookings
        WHERE court_id = ?
          AND id <> ?
          AND status = 'confirmed'
          AND starts_at < ?
          AND ends_at > ?
        LIMIT 1
      `).get(
        booking.court_id,
        booking.id,
        booking.ends_at,
        booking.starts_at
      );

      if (conflict) {
        db.prepare(`
          UPDATE payments
          SET status = 'approved_schedule_conflict',
              raw_status = 'Pagamento aprovado, mas o horário já foi ocupado. Requer análise e possível reembolso.',
              updated_at = datetime('now')
          WHERE booking_id = ?
        `).run(bookingId);

        db.prepare(`
          UPDATE bookings
          SET status = 'expired'
          WHERE id = ?
        `).run(bookingId);

        return "schedule_conflict";
      }

      db.prepare(`
        UPDATE bookings
        SET status = 'confirmed',
            payment_provider_id = ?,
            payment_method = ?
        WHERE id = ?
          AND status = 'pending_payment'
      `).run(
        String(paymentId),
        details.payment_method_id || "unknown",
        bookingId
      );

      return "confirmed";
    });

    const result = process.immediate();

    if (
      result === "invalid_amount" ||
      result === "schedule_conflict" ||
      result === "approved_after_expiration"
    ) {
      console.error("Pagamento requer análise:", bookingId, result);
    }

    return res.sendStatus(200);

  } catch (error) {
    console.error("Webhook Mercado Pago:", error.message);
    return res.sendStatus(500);
  }
});

module.exports = router;
