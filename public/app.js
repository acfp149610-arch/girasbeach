

const $ = s => document.querySelector(s);

let currentUser = null;
let selectedSlot = null;
let selectedBooking = null;
let paymentCountdownTimer = null;
const paymentPollers = new Map();

function monitorPayment(bookingId) {
  const id = String(bookingId);

  if (paymentPollers.has(id)) return;

  const timer = setInterval(async () => {
    try {
      const result = await api(
        `/api/payments/status/${encodeURIComponent(id)}`
      );

      if (
        result.status === "confirmed" ||
        result.status === "expired" ||
        result.status === "cancelled"
      ) {
        clearInterval(timer);
        paymentPollers.delete(id);

        if (result.status === "confirmed") {
          toast("Pagamento aprovado! Reserva confirmada.");
        } else {
          toast("Sua reserva não está mais ativa. O horário foi liberado.");
        }

        await loadMine();

        if ($("#checkAvailability")) {
          $("#checkAvailability").click();
        }
      }
    } catch (error) {
      console.error("Erro ao consultar pagamento:", error.message);
    }
  }, 5000);

  paymentPollers.set(id, timer);
}



const money = cents =>
  (Number(cents || 0) / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL"
  });

const escapeHTML = value =>
  String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);

function toast(message) {
  const el = $("#toast");
  if (!el) return;
  el.textContent = message;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 3500);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    ...options
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "Ocorreu um erro.");
  }

  return data;
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function showUser() {
  const isAdmin = currentUser?.role === "admin";

  $("#authGrid")?.classList.add("hidden");

  $("#loginForm").parentElement.parentElement
    .classList.toggle("hidden", !!currentUser);

  $("#myAccount").classList.toggle("hidden", !currentUser);

  $("#adminPanel").classList.toggle("hidden", !isAdmin);

  $("#customerName").textContent = currentUser?.name || "";

  $("#navLogin").textContent = currentUser
    ? "Minha conta"
    : "Entrar";
}

async function refresh() {
  const data = await api("/api/auth/me");
  currentUser = data.user;
  showUser();

  if (currentUser) {
    await loadMine();

    if (currentUser.role === "admin") {
      await loadAdmin();
    }
  }
}

$("#navLogin").onclick = () => {
  location.hash = "#conta";
};

$("#loginForm").onsubmit = async event => {
  event.preventDefault();

  try {
    const result = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify(formData(event.target))
    });

    currentUser = result.user;
    showUser();
    await loadMine();

    if (currentUser.role === "admin") {
      await loadAdmin();
    }

    toast("Login realizado!");
    event.target.reset();
  } catch (error) {
    toast(error.message);
  }
};

$("#registerForm").onsubmit = async event => {
  event.preventDefault();

  try {
    const result = await api("/api/auth/register", {
      method: "POST",
      body: JSON.stringify(formData(event.target))
    });

    currentUser = result.user;
    showUser();
    await loadMine();

    toast("Cadastro realizado!");
    event.target.reset();
  } catch (error) {
    toast(error.message);
  }
};

$("#logout").onclick = async () => {
  try {
    await api("/api/auth/logout", { method: "POST" });
    currentUser = null;
    showUser();
    $("#myBookings").innerHTML = "";
    toast("Você saiu da sua conta.");
  } catch (error) {
    toast(error.message);
  }
};



async function loadMine() {
  const result = await api("/api/bookings/mine");

  result.bookings.forEach(booking => {
    if (booking.status === "pending_payment") {
      monitorPayment(booking.id);
    }
  });

  $("#myBookings").innerHTML = result.bookings.length
    ? result.bookings.map(booking => `
        <p>
          <b>${escapeHTML(booking.court_name)}</b>
          · ${new Date(booking.starts_at).toLocaleString("pt-BR")}
          · ${money(booking.amount_cents)}
          · ${escapeHTML(booking.status)}
        </p>
      `).join("")
    : "<p class='muted'>Você ainda não tem reservas.</p>";
}

$("#date").min = new Date().toISOString().slice(0, 10);
$("#date").value = $("#date").min;

$("#checkAvailability").onclick = async () => {
  if (!currentUser) {
    toast("Entre ou crie sua conta para consultar.");
    location.hash = "#conta";
    return;
  }

  const date = $("#date").value;
  const courtId = $("#court").value;

  if (!date) {
    toast("Escolha uma data.");
    return;
  }

  if (!courtId) {
    toast("Nenhuma quadra disponível.");
    return;
  }

  try {
    const result = await api(
      `/api/bookings/availability?date=${encodeURIComponent(date)}&courtId=${encodeURIComponent(courtId)}`
    );

    const wrap = $("#availability");
    wrap.innerHTML = "";

    if (!result.available.length) {
      wrap.innerHTML = `
        <p class="muted">
          Não há horários disponíveis nesta data.
        </p>
      `;
      return;
    }

    const title = document.createElement("p");
    title.textContent = "Escolha um horário disponível:";
    wrap.appendChild(title);

    result.available.forEach(slot => {
      const button = document.createElement("button");

      button.className = "slot";
      button.textContent =
        `${slot.time} · ${money(slot.priceCents)}`;

      button.onclick = () => {
        document.querySelectorAll(".slot").forEach(item => {
          item.classList.remove("selected");
        });

        button.classList.add("selected");

        selectedSlot = {
          date,
          time: slot.time,
          courtId,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt
        };

        createBooking();
      };

      wrap.appendChild(button);
    });
  } catch (error) {
    toast(error.message);
  }
};

function startPaymentCountdown(expiresAt) {
  if (paymentCountdownTimer) {
    clearInterval(paymentCountdownTimer);
  }

  const display = $("#paymentCountdown");

  if (!display) return;

  function updateCountdown() {
    const remaining = Math.max(
      0,
      Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000)
    );

    const minutes = Math.floor(remaining / 60);
    const seconds = remaining % 60;

    display.textContent =
      `Tempo restante para pagamento: ${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;

    if (remaining <= 0) {
      clearInterval(paymentCountdownTimer);
      paymentCountdownTimer = null;

      display.textContent = "Tempo esgotado! Sua reserva expirou.";
      display.style.color = "#dc2626";

      if ($("#checkAvailability")) {
        $("#checkAvailability").click();
      }
    }
  }

  updateCountdown();
  paymentCountdownTimer = setInterval(updateCountdown, 1000);
}


async function createBooking() {
  const { startsAt, endsAt, courtId } = selectedSlot;

  try {
    const result = await api("/api/bookings", {
      method: "POST",
      body: JSON.stringify({
        courtId,
        startsAt,
        endsAt
      })
    });

    selectedBooking = result.booking;
monitorPayment(result.booking.id);
    $("#availability").insertAdjacentHTML("beforeend", `
      <div class="panel">
        <p>
  Reserva temporária #${result.booking.id}
  · ${money(result.booking.amount_cents)}
</p>

<p
  id="paymentCountdown"
  style="font-size: 20px; font-weight: bold; color: #b8860b;"
>
  Calculando tempo restante...
</p>
        <button class="btn btn-yellow" id="payPix">
          Pagar com PIX
        </button>
        <button class="btn btn-dark" id="payCard">
          Pagar com cartão
        </button>
      </div>
    `);

    $("#payPix").onclick = () => checkout("pix");
    $("#payCard").onclick = () => checkout("card");
startPaymentCountdown(result.booking.expires_at);
    toast("Horário reservado temporariamente por 15 minutos.");
  } catch (error) {
    toast(error.message);
  }
}



async function checkout(method) {
  if (!selectedBooking) {
    toast("Nenhuma reserva selecionada.");
    return;
  }

  try {
    const result = await api("/api/payments/checkout", {
      method: "POST",
      body: JSON.stringify({
        bookingId: selectedBooking.id,
        method
      })
    });

    if (method === "card") {
      const url = result.checkoutUrl || result.sandboxCheckoutUrl;

      if (url) {
        location.href = url;
      } else {
        toast("Link de pagamento indisponível.");
      }

      return;
    }

    const wrap = $("#availability");

    if (result.qrCodeBase64) {
      wrap.insertAdjacentHTML("beforeend", `
        <div class="panel">
          <h3>PIX copia e cola</h3>
          <img
            style="width:220px;max-width:100%"
            src="data:image/png;base64,${result.qrCodeBase64}"
            alt="QR Code PIX"
          >
          <textarea
            id="pixCode"
            readonly
            style="width:100%;min-height:90px"
          ></textarea>
          <button class="btn btn-dark" id="copyPix">
            Copiar código PIX
          </button>
        </div>
      `);

      $("#pixCode").value = result.qrCode || "";

      $("#copyPix").onclick = () => {
        navigator.clipboard.writeText(result.qrCode || "")
          .then(() => toast("Código PIX copiado."))
          .catch(() => toast("Não foi possível copiar o código."));
      };
    } else {
      toast("PIX criado. Consulte o status no Mercado Pago.");
    }
  } catch (error) {
    toast(error.message);
  }
}

// ================================
// PAINEL ADMINISTRATIVO
// ================================

const weekdays = [
  "Domingo",
  "Segunda-feira",
  "Terça-feira",
  "Quarta-feira",
  "Quinta-feira",
  "Sexta-feira",
  "Sábado"
];

function getHourValue(hour, camel, snake) {
  return hour[camel] ?? hour[snake];
}

async function loadAdmin() {
  try {
    const dashboard = await api("/api/admin/dashboard");

    $("#adminStats").innerHTML = `
      <div class="stat">
        <span>Reservas confirmadas</span>
        <b>${dashboard.counts.confirmed}</b>
      </div>
      <div class="stat">
        <span>Pendentes</span>
        <b>${dashboard.counts.pending}</b>
      </div>
      <div class="stat">
        <span>Faturamento confirmado</span>
        <b>${money(dashboard.revenueCents)}</b>
      </div>
    `;

    const bookings = await api("/api/admin/bookings");

    $("#adminBookings").innerHTML = `
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Cliente</th>
              <th>Quadra</th>
              <th>Data</th>
              <th>Valor</th>
              <th>Status</th>
              <th>Ação</th>
            </tr>
          </thead>
          <tbody>
            ${bookings.bookings.map(booking => `
              <tr>
                <td>${escapeHTML(booking.customer)}</td>
                <td>${escapeHTML(booking.court)}</td>
                <td>${new Date(booking.starts_at).toLocaleString("pt-BR")}</td>
                <td>${money(booking.amount_cents)}</td>
                <td>${escapeHTML(booking.status)}</td>
                <td>
                  ${
                  "Confirmação automática pelo Mercado Pago"
                  }
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;

    const courtsResult = await api("/api/admin/courts");
    const courts = courtsResult.courts || [];

    renderAdminCourts(courts);

    const activeCourts = courts.filter(court => Number(court.active) === 1);

    $("#court").innerHTML = activeCourts.length
      ? activeCourts.map(court => `
          <option value="${court.id}">${escapeHTML(court.name)}</option>
        `).join("")
      : "<option value=''>Nenhuma quadra ativa</option>";

    const hoursResult = await api("/api/admin/opening-hours");
    const hours =
      hoursResult.openingHours ||
      hoursResult.hours ||
      hoursResult.items ||
      [];

    renderOpeningHours(hours);
  } catch (error) {
    toast(error.message);
  }
}

// Exibe quadras com controles de edição e exclusão.
function renderAdminCourts(courts) {
  const container = $("#adminCourts");

  if (!courts.length) {
    container.innerHTML = "<p class='muted'>Nenhuma quadra cadastrada.</p>";
    return;
  }

  container.innerHTML = courts.map(court => `
    <form class="court-edit panel" data-id="${court.id}">
      <label>
        Nome da quadra
        <input
          name="name"
          value="${escapeHTML(court.name)}"
          required
        >
      </label>

      <label>
        Descrição
        <input
          name="description"
          value="${escapeHTML(court.description || "")}"
        >
      </label>

      <p>Status: <b>${Number(court.active) === 1 ? "Ativa" : "Inativa"}</b></p>

      <button class="btn btn-yellow" type="submit">
        Salvar alterações
      </button>

      <button
        class="btn btn-outline toggle-court"
        type="button"
        data-id="${court.id}"
        data-active="${Number(court.active) === 1 ? 1 : 0}"
      >
        ${Number(court.active) === 1 ? "Desativar" : "Ativar"}
      </button>

      <button
        class="btn btn-outline delete-court"
        type="button"
        data-id="${court.id}"
      >
        Excluir quadra
      </button>
    </form>
  `).join("");
}

// Salva edição de quadra.
$("#adminCourts").addEventListener("submit", async event => {
  if (!event.target.matches(".court-edit")) return;

  event.preventDefault();

  const id = event.target.dataset.id;

  try {
    await api(`/api/admin/courts/${id}`, {
      method: "PATCH",
      body: JSON.stringify(formData(event.target))
    });

    toast("Quadra atualizada!");
    await loadAdmin();
  } catch (error) {
    toast(error.message);
  }
});

// Ativa ou desativa quadra.
$("#adminCourts").addEventListener("click", async event => {
  const button = event.target.closest(".toggle-court, .delete-court");

  if (!button) return;

  const id = button.dataset.id;

  if (button.classList.contains("toggle-court")) {
    const isActive = button.dataset.active === "1";

    try {
      await api(`/api/admin/courts/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ active: !isActive })
      });

      toast(isActive ? "Quadra desativada." : "Quadra ativada.");
      await loadAdmin();
    } catch (error) {
      toast(error.message);
    }
  }

  if (button.classList.contains("delete-court")) {
    const confirmed = confirm(
      "Tem certeza de que deseja excluir esta quadra? Essa ação não poderá ser desfeita."
    );

    if (!confirmed) return;

    try {
      await api(`/api/admin/courts/${id}`, {
        method: "DELETE"
      });

      toast("Quadra excluída.");
      await loadAdmin();
    } catch (error) {
      toast(error.message);
    }
  }
});

// Exibe horários e preços cadastrados.
function renderOpeningHours(hours) {
  const container = $("#adminOpeningHours");

  if (!hours.length) {
    container.innerHTML = "<p class='muted'>Nenhum horário configurado.</p>";
    return;
  }

  container.innerHTML = hours.map(hour => {
    const weekday = Number(hour.weekday);
    const startTime = getHourValue(hour, "startTime", "start_time");
    const endTime = getHourValue(hour, "endTime", "end_time");
    const slotMinutes = getHourValue(hour, "slotMinutes", "slot_minutes");
    const priceCents = getHourValue(hour, "priceCents", "price_cents");

    return `
      <form class="hour-edit panel" data-id="${hour.id}">
        <h4>${escapeHTML(weekdays[weekday] || "Dia não identificado")}</h4>

        <label>
          Dia da semana
          <select name="weekday" required>
            ${weekdays.map((day, index) => `
              <option value="${index}" ${index === weekday ? "selected" : ""}>
                ${day}
              </option>
            `).join("")}
          </select>
        </label>

        <label>
          Início
          <input name="startTime" type="time" value="${escapeHTML(startTime)}" required>
        </label>

        <label>
          Fim
          <input name="endTime" type="time" value="${escapeHTML(endTime)}" required>
        </label>

        <label>
          Duração em minutos
          <input
            name="slotMinutes"
            type="number"
            min="30"
            max="240"
            value="${escapeHTML(slotMinutes)}"
            required
          >
        </label>

        <label>
          Preço em reais
          <input
            name="price"
            type="number"
            min="0"
            step="0.01"
            value="${(Number(priceCents) / 100).toFixed(2)}"
            required
          >
        </label>

        <button class="btn btn-yellow" type="submit">
          Salvar horário
        </button>

        <button
          class="btn btn-outline delete-hour"
          type="button"
          data-id="${hour.id}"
        >
          Excluir horário
        </button>
      </form>
    `;
  }).join("");
}

// Salva edição de horário.
$("#adminOpeningHours").addEventListener("submit", async event => {
  if (!event.target.matches(".hour-edit")) return;

  event.preventDefault();

  const id = event.target.dataset.id;
  const data = formData(event.target);

  try {
    await api(`/api/admin/opening-hours/${id}`, {
      method: "PATCH",
      body: JSON.stringify({
        weekday: Number(data.weekday),
        startTime: data.startTime,
        endTime: data.endTime,
        slotMinutes: Number(data.slotMinutes),
        priceCents: Math.round(Number(data.price) * 100)
      })
    });

    toast("Horário e preço atualizados!");
    await loadAdmin();
  } catch (error) {
    toast(error.message);
  }
});

// Exclui horário.
$("#adminOpeningHours").addEventListener("click", async event => {
  const button = event.target.closest(".delete-hour");

  if (!button) return;

  const confirmed = confirm(
    "Deseja realmente excluir esta configuração de horário?"
  );

  if (!confirmed) return;

  try {
    await api(`/api/admin/opening-hours/${button.dataset.id}`, {
      method: "DELETE"
    });

    toast("Horário excluído.");
    await loadAdmin();
  } catch (error) {
    toast(error.message);
  }
});

// Adiciona quadra.
$("#courtForm").onsubmit = async event => {
  event.preventDefault();

  try {
    await api("/api/admin/courts", {
      method: "POST",
      body: JSON.stringify(formData(event.target))
    });

    event.target.reset();
    await loadAdmin();
    toast("Quadra adicionada.");
  } catch (error) {
    toast(error.message);
  }
};

// Cadastra novo horário e preço.
$("#priceForm").onsubmit = async event => {
  event.preventDefault();

  const data = formData(event.target);

  try {
    await api("/api/admin/opening-hours", {
      method: "POST",
      body: JSON.stringify({
        weekday: Number(data.weekday),
        startTime: data.startTime,
        endTime: data.endTime,
        slotMinutes: Number(data.slotMinutes),
        priceCents: Math.round(Number(data.price) * 100)
      })
    });

    event.target.reset();
    await loadAdmin();
    toast("Preço configurado.");
  } catch (error) {
    toast(error.message);
  }
};

$("#year").textContent = new Date().getFullYear();

refresh().catch(error => {
  console.error("Erro ao carregar a conta:", error);
});
