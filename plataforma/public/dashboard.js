"use strict";

(() => {
  if (!window.nhacHosted) return;
  const get = id => document.getElementById(id);
  const workspace = get("account-screen");
  const themeButton = get("dash-theme");
  const menu = get("account-menu");
  const navigation = get("account-navigation");
  const salesPeriod = get("sales-period");
  const chart = get("sales-chart");
  const chartMode = get("sales-chart-mode");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const compact = new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 });
  const formatter = new Intl.NumberFormat("pt-BR");
  const dates = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short", timeZone: "UTC" });
  const areas = {
    "sales-dashboard": ["overview-nav", "overview"],
    "order-panel": ["orders-nav", "orders"],
    "catalog-panel": ["catalog-nav", "catalog"],
    "wholesale-panel": ["wholesale-nav", "wholesale"],
    "team": ["team-nav", "clients"],
    "marketing-panel": ["marketing-nav", "marketing"],
    "access-panel": ["access-nav", "main"],
    "my-account-panel": ["my-account-nav", null]
  };
  const panels = Object.keys(areas);
  let role;
  let daily = [];
  let chartFrame;
  let chartPlot;
  let activeDay = -1;
  let visiblePanel;
  let panelAnimation;
  let metricsFetch;
  let contactsFetch;
  let session;
  let contacts = [];
  let selectedContact;
  let sendAttempt;
  let sendInFlight = false;

  const text = (id, content) => { get(id).textContent = content; };
  const amount = cents => money.format(Number(cents) / 100);
  const formatDay = day => dates.format(new Date(day + "T12:00:00Z"));
  const isAdmin = () => role === "MAIN" || role === "STAFF";
  const permitted = permission => permission === null ? isAdmin() : canUseAdminArea(role, permission);

  async function api(path, data, signal = session?.signal) {
    const response = await window.nhacHosted.request(path, {
      signal,
      ...(data && { method: "POST", body: JSON.stringify(data) })
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error);
    return value;
  }

  function setTheme(theme) {
    workspace.dataset.theme = theme;
    themeButton.setAttribute("aria-pressed", String(theme === "light"));
    themeButton.textContent = theme === "dark" ? "Tema claro" : "Tema escuro";
    drawChart();
  }

  themeButton.addEventListener("click", () => {
    const theme = workspace.dataset.theme === "dark" ? "light" : "dark";
    setTheme(theme);
    try { localStorage.setItem("nhac-admin-theme", theme); } catch {}
  });

  function showPanel(focus = false) {
    if (!isAdmin()) return;
    const target = window.location.hash.slice(1);
    const available = panels.filter(id => permitted(areas[id][1]));
    const active = available.includes(target) ? target : available[0];
    for (const id of panels) get(id).hidden = active !== id;
    for (const link of navigation.querySelectorAll("a:not([hidden])")) {
      if (link.hash === "#" + active) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    }
    const heading = get(active).querySelector("h1,h2");
    text("workspace-heading", heading.textContent);
    if (focus) {
      menu.setAttribute("aria-expanded", "false");
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
      window.scrollTo(0, 0);
    }
    if (active === visiblePanel) return;
    visiblePanel = active;
    panelAnimation?.cancel();
    if (active !== "sales-dashboard") {
      metricsFetch?.abort();
      stopChart();
    }
    if (!reducedMotion.matches && focus) {
      panelAnimation = get(active).animate(
        [{ opacity: .5, transform: "translateY(5px)" }, { opacity: 1, transform: "translateY(0)" }],
        { duration: 160, easing: "ease-out" }
      );
    }
    if (active === "sales-dashboard") loadMetrics();
    if (active === "marketing-panel") loadContacts();
    if (active === "access-panel" || active === "my-account-panel") {
      document.dispatchEvent(new CustomEvent("nhac:staff-panel", { detail: active }));
    }
  }

  function showPreferences(focus = false) {
    if (role !== "CUSTOMER") return;
    const active = window.location.hash === "#preferences-panel";
    get("preferences-panel").hidden = !active;
    for (const id of ["account-greeting", "account-status-card", "store", "order-panel"]) get(id).hidden = active;
    text("workspace-heading", active ? "Preferências" : "Minha conta");
    if (!active || !focus) return;
    const title = get("preferences-title");
    title.tabIndex = -1;
    title.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }
  window.addEventListener("hashchange", () => {
    if (isAdmin()) showPanel(true);
    else showPreferences(true);
  });
  navigation.addEventListener("click", event => {
    const link = event.target.closest("a");
    if (link?.hash === window.location.hash && isAdmin()) showPanel(true);
  });

  function stopChart() {
    cancelAnimationFrame(chartFrame);
    chartFrame = undefined;
  }

  function drawChart() {
    stopChart();
    chartPlot = null;
    if (!chart.clientWidth || chart.hidden || !daily.length) return;
    const width = chart.clientWidth;
    const height = chart.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    chart.width = Math.round(width * dpr);
    chart.height = Math.round(height * dpr);
    const ctx = chart.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    const theme = getComputedStyle(workspace);
    const color = key => theme.getPropertyValue("--dash-" + key).trim();
    const bars = chartMode.value === "orders";
    const values = daily.map(day => Number(day[bars ? "orders" : "cents"]));
    const top = 14;
    const bottom = height - 29;
    const left = bars ? 32 : width < 360 ? 57 : 65;
    const right = width - 12;
    const plotWidth = right - left;
    const stepX = plotWidth / (bars ? values.length : Math.max(values.length - 1, 1));
    const x = index => values.length === 1 ? (left + right) / 2 : left + stepX * (index + (bars ? .5 : 0));
    const peak = Math.max(...values, bars ? 4 : 100) / 4;
    const magnitude = 10 ** Math.floor(Math.log10(peak));
    const stepY = ([1, 2, 2.5, 5, 10].find(n => n * magnitude >= peak) || 10) * magnitude;
    const steps = Math.ceil(Math.max(...values, bars ? 4 : 100) / stepY);
    const ceiling = steps * stepY;
    const y = (value, progress = 1) => bottom - (bottom - top) * (value / ceiling) * progress;
    const accent = color(bars ? "success" : "accent");
    const area = ctx.createLinearGradient(0, top, 0, bottom);
    area.addColorStop(0, color("chart-fill"));
    area.addColorStop(1, "transparent");
    const lineColor = color("line");
    const muted = color("muted");
    const surface = color("surface");

    function paint(progress) {
      ctx.clearRect(0, 0, width, height);
      ctx.font = "11px Segoe UI, sans-serif";
      ctx.textBaseline = "middle";
      ctx.textAlign = "right";
      ctx.fillStyle = muted;
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = 1;
      for (let tick = 0; tick <= steps; tick++) {
        const value = tick * stepY;
        const row = y(value);
        ctx.beginPath(); ctx.moveTo(left, row); ctx.lineTo(right, row); ctx.stroke();
        ctx.fillText(bars ? compact.format(value) : "R$ " + compact.format(value / 100), left - 7, row);
      }
      const ticks = Math.min(daily.length, width < 380 ? 3 : 5);
      for (let tick = 0; tick < ticks; tick++) {
        const index = Math.round((daily.length - 1) * tick / Math.max(ticks - 1, 1));
        ctx.textAlign = tick === 0 ? "left" : tick === ticks - 1 ? "right" : "center";
        ctx.fillText(formatDay(daily[index].day), x(index), height - 11);
      }
      if (bars) {
        const barWidth = Math.min(24, stepX * .7);
        ctx.fillStyle = accent;
        values.forEach((value, index) => {
          if (!value) return;
          ctx.globalAlpha = index === activeDay ? 1 : .55;
          const barHeight = bottom - y(value, progress);
          ctx.beginPath();
          ctx.roundRect(x(index) - barWidth / 2, bottom - barHeight, barWidth, barHeight, Math.min(4, barHeight / 2, barWidth / 2));
          ctx.fill();
        });
        ctx.globalAlpha = 1;
      } else {
        const line = () => values.forEach((value, index) => {
          if (index === 0) ctx.moveTo(x(index), y(value, progress));
          else ctx.lineTo(x(index), y(value, progress));
        });
        ctx.beginPath(); line(); ctx.lineTo(x(values.length - 1), bottom); ctx.lineTo(x(0), bottom); ctx.closePath();
        ctx.fillStyle = area; ctx.fill();
        ctx.beginPath(); line(); ctx.strokeStyle = accent; ctx.lineWidth = 2.4; ctx.lineJoin = "round"; ctx.stroke();
      }
      if (activeDay < 0) return;
      const mark = x(activeDay);
      ctx.strokeStyle = muted;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.beginPath(); ctx.moveTo(mark, top); ctx.lineTo(mark, bottom); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(mark, y(values[activeDay], progress), 4, 0, Math.PI * 2);
      ctx.fillStyle = surface; ctx.fill();
      ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.stroke();
    }
    chartPlot = { paint, closest(clientX) {
      const relative = clientX - chart.getBoundingClientRect().left;
      return Math.round((relative - x(0)) / Math.max(stepX, 1));
    }};
    paint(1);
  }

  function revealChart() {
    drawChart();
    if (!chartPlot || reducedMotion.matches) return;
    const plot = chartPlot;
    const started = performance.now();
    plot.paint(0);
    const frame = now => {
      const progress = Math.min(1, Math.max(0, (now - started) / 400));
      plot.paint(1 - (1 - progress) ** 3);
      chartFrame = progress < 1 ? requestAnimationFrame(frame) : undefined;
    };
    chartFrame = requestAnimationFrame(frame);
  }

  function selectDay(index, announce = false) {
    if (!daily.length) return;
    const next = Math.max(0, Math.min(daily.length - 1, index));
    if (next === activeDay && !announce) return;
    activeDay = next;
    const day = daily[next];
    const date = formatDay(day.day);
    const summary = amount(day.cents) + " · " + formatter.format(day.orders) + (day.orders === 1 ? " pedido" : " pedidos");
    text("chart-day", date);
    text("chart-value", summary);
    get("chart-prev").setAttribute("aria-disabled", String(next === 0));
    get("chart-next").setAttribute("aria-disabled", String(next === daily.length - 1));
    if (announce) text("chart-announcement", date + ", " + summary);
    if (chartFrame === undefined) chartPlot?.paint(1);
  }

  new ResizeObserver(() => {
    if (chartFrame === undefined) drawChart();
  }).observe(chart);
  chart.addEventListener("pointermove", event => {
    if (event.pointerType === "mouse" && chartPlot) selectDay(chartPlot.closest(event.clientX));
  });
  chart.addEventListener("click", event => {
    if (chartPlot) selectDay(chartPlot.closest(event.clientX), true);
  });
  get("chart-prev").addEventListener("click", () => selectDay(activeDay - 1, true));
  get("chart-next").addEventListener("click", () => selectDay(activeDay + 1, true));
  reducedMotion.addEventListener("change", () => {
    panelAnimation?.cancel();
    drawChart();
  });
  chartMode.addEventListener("change", () => {
    text("chart-description", chartMode.value === "orders" ? "Quantidade de pedidos por dia" : "Valor dos pedidos por dia");
    revealChart();
  });

  function breakdown(id, rows, key, labels, empty) {
    const list = get(id);
    const total = rows.reduce((sum, row) => sum + Number(row.cents), 0);
    list.replaceChildren();
    if (rows.length === 0) list.append(element("li", empty, "dash-empty"));
    for (const row of rows) {
      const item = element("li");
      const detail = element("div");
      detail.append(element("strong", labels[row[key]] ?? row[key]), element("small", formatter.format(row.count) + " " + (row.count === 1 ? "pedido" : "pedidos")));
      const summary = element("div", null, "dash-breakdown-summary");
      summary.append(detail, element("strong", amount(row.cents)));
      item.append(summary);
      if (total > 0) {
        const share = Number(row.cents) / total;
        const track = element("div", null, "dash-breakdown-track");
        const fill = element("span");
        track.setAttribute("aria-hidden", "true");
        track.append(fill);
        item.append(track);
        fill.style.transform = `scaleX(${share})`;
        if (!reducedMotion.matches) {
          fill.animate([{ transform: "scaleX(0)" }, { transform: fill.style.transform }],
            { duration: 420, easing: "cubic-bezier(.22, 1, .36, 1)" });
        }
      }
      list.append(item);
    }
  }

  async function loadMetrics() {
    if (!isAdmin() || get("sales-dashboard").hidden) return;
    metricsFetch?.abort();
    const current = metricsFetch = new AbortController();
    stopChart();
    chartPlot = null;
    activeDay = -1;
    get("chart-inspector").hidden = true;
    text("chart-announcement", "");
    chartMode.disabled = true;
    text("metrics-status", "Carregando indicadores…");
    for (const id of ["metric-revenue", "metric-count", "metric-average", "metric-received", "metric-pending", "chart-period"]) text(id, "—");
    chart.hidden = true;
    for (const id of ["chart-empty", "chart-table-wrap"]) get(id).hidden = true;
    for (const id of ["payment-breakdown", "channel-breakdown"]) get(id).replaceChildren();
    try {
      const stats = await api("/api/admin/metrics?days=" + salesPeriod.value, undefined, current.signal);
      if (current.signal.aborted) return;
      daily = stats.daily;
      text("metric-revenue", amount(stats.total));
      text("metric-count", formatter.format(stats.count));
      text("metric-average", amount(stats.average));
      text("metric-received", amount(stats.received));
      text("metric-pending", formatter.format(stats.pending) + (stats.pending === 1 ? " aguarda pagamento" : " aguardam pagamento"));
      text("chart-period", formatDay(daily[0].day) + " a " + formatDay(daily.at(-1).day));
      breakdown("payment-breakdown", stats.methods, "method", paymentLabels, "Nenhum recebimento confirmado.");
      breakdown("channel-breakdown", stats.channels, "channel", {retail:"Varejo",wholesale:"Atacado"}, "Nenhum pedido no período.");
      const rows = get("chart-table");
      rows.replaceChildren();
      for (const day of daily) {
        const row = element("tr");
        row.append(element("td", formatDay(day.day)), element("td", formatter.format(day.orders)), element("td", amount(day.cents)));
        rows.append(row);
      }
      get("chart-empty").hidden = stats.count > 0;
      get("chart-table-wrap").hidden = stats.count === 0;
      chart.hidden = stats.count === 0;
      chartMode.disabled = chart.hidden;
      get("chart-inspector").hidden = chart.hidden;
      const lastOrderDay = daily.findLastIndex(day => Number(day.orders) > 0);
      selectDay(lastOrderDay < 0 ? daily.length - 1 : lastOrderDay);
      revealChart();
      text("metrics-status", "");
    } catch (error) {
      if (!current.signal.aborted) text("metrics-status", "Não foi possível carregar os indicadores. Altere o período para tentar novamente.");
    }
  }

  salesPeriod.addEventListener("change", loadMetrics);
  document.addEventListener("nhac:orders-changed", loadMetrics);

  function selectContact(contact) {
    selectedContact = contact;
    get("marketing-send").disabled = sendInFlight || !contact;
    text("marketing-recipient", contact ? contact.name + " · " + contact.email : "Selecione um contato para começar.");
    renderContacts();
  }

  function renderContacts() {
    const list = get("marketing-contacts");
    const search = get("marketing-search").value.trim().toLocaleLowerCase("pt-BR");
    list.replaceChildren();
    const available = contacts.filter(contact => (contact.name + " " + contact.email).toLocaleLowerCase("pt-BR").includes(search));
    const count = available.length;
    text("marketing-count", count === 0 ? "Nenhum contato encontrado." : formatter.format(count) + (count === 1 ? " contato encontrado" : " contatos encontrados"));
    for (const contact of available) {
      const item = element("li");
      const button = element("button", undefined, "marketing-contact");
      button.type = "button";
      button.setAttribute("aria-pressed", String(selectedContact?.id === contact.id));
      button.append(element("strong", contact.name), element("small", contact.email));
      button.addEventListener("click", () => { selectContact(contact); get("marketing-subject").focus(); });
      item.append(button);
      list.append(item);
    }
  }

  async function loadContacts() {
    if (!isAdmin()) return;
    contactsFetch?.abort();
    const current = contactsFetch = new AbortController();
    text("marketing-count", "Carregando contatos…");
    try {
      const result = await api("/api/admin/marketing", undefined, current.signal);
      if (current.signal.aborted) return;
      contacts = result.contacts;
      selectContact(contacts.find(contact => contact.id === selectedContact?.id));
    } catch (error) {
      if (!current.signal.aborted) {
        contacts = [];
        selectContact(undefined);
        text("marketing-count", error.message || "Falha ao carregar os contatos.");
      }
    }
  }

  get("marketing-refresh").addEventListener("click", loadContacts);
  get("marketing-search").addEventListener("input", renderContacts);
  get("marketing-template").addEventListener("change", event => {
    const storeLink = new URL("/plataforma/", window.location.origin).href;
    const templates = {
      news: ["Escolha seus cortes na loja Nhac!", "Olá! Você pode conferir as variedades e escolher a apresentação disponível para cada produto.\n\nVeja o catálogo da Nhac!\n" + storeLink],
      returning: ["Uma tábua de petiscos para o fim de semana", "Olá! Uma ideia para reunir a turma é combinar salame fatiado, pão crocante e picles. Gosta de fatias mais grossas? Veja as opções de salame inteiro na loja.\n\nVer o catálogo da Nhac!\n" + storeLink]
    };
    const template = templates[event.target.value];
    if (!template) return;
    get("marketing-subject").value = template[0];
    get("marketing-message").value = template[1];
  });

  get("marketing-form").addEventListener("submit", async event => {
    event.preventDefault();
    const contact = selectedContact;
    if (!isAdmin() || !contact || get("marketing-send").disabled) return;
    const subject = get("marketing-subject").value.trim();
    const message = get("marketing-message").value.trim();
    if (!subject || !message) { text("marketing-feedback", "Preencha o assunto e a mensagem."); return; }
    if (!window.confirm("Enviar esta mensagem para " + contact.email + "?")) return;
    const normalized = JSON.stringify([contact.id,subject,message]);
    if (sendAttempt?.normalized !== normalized) sendAttempt = { normalized, requestId:crypto.randomUUID() };
    sendInFlight = true;
    get("marketing-send").disabled = true;
    const current = session;
    text("marketing-feedback", "Enviando…");
    try {
      await window.nhacHosted.sendMarketing({ contactId:contact.id, subject, message, requestId:sendAttempt.requestId });
      if (current !== session) return;
      get("marketing-form").reset();
      sendAttempt = undefined;
      text("marketing-feedback", "O serviço de e-mail aceitou a mensagem para entrega.");
    } catch (error) {
      if (current === session) text("marketing-feedback", error.message);
    } finally {
      if (current === session) {
        sendInFlight = false;
        get("marketing-send").disabled = !selectedContact;
      }
    }
  });

  async function loadPreference() {
    const current = session;
    const checkbox = get("marketing-consent");
    checkbox.disabled = true;
    get("marketing-consent-form").querySelector("button").disabled = true;
    try {
      const value = await api("/api/shop/marketing");
      if (current !== session) return;
      checkbox.checked = value.optIn;
      checkbox.disabled = false;
      get("marketing-consent-form").querySelector("button").disabled = false;
      text("marketing-consent-status", "");
    } catch (error) {
      if (current === session) text("marketing-consent-status", error.message);
    }
  }
  get("marketing-consent-form").addEventListener("submit", async event => {
    event.preventDefault();
    const current = session;
    const button = event.currentTarget.querySelector("button");
    button.disabled = true;
    try {
      await api("/api/shop/marketing", {optIn:get("marketing-consent").checked});
      if (current === session) text("marketing-consent-status", "Preferência salva.");
    } catch (error) {
      if (current === session) text("marketing-consent-status", error.message);
    } finally {
      if (current === session) button.disabled = false;
    }
  });

  document.addEventListener("nhac:session", event => {
    metricsFetch?.abort();
    contactsFetch?.abort();
    session?.abort();
    session = new AbortController();
    role = event.detail;
    const admin = isAdmin();
    workspace.classList.toggle("admin-workspace", admin);
    document.body.classList.toggle("admin-mode", admin);
    themeButton.hidden = !admin;
    workspace.querySelector(".dash-brand").hidden = !admin;
    get("sidebar-label").hidden = admin;
    for (const [id, permission] of Object.values(areas)) {
      get(id).hidden = admin ? !permitted(permission) : !["overview-nav", "orders-nav"].includes(id);
    }
    const overviewLink = get("overview-nav");
    overviewLink.href = admin ? "#sales-dashboard" : "#account-name";
    for (const id of ["account-greeting", "account-status-card"]) get(id).hidden = admin;
    get("order-search-label").hidden = !canUseAdminArea(role, "orders");
    get("preferences-nav").hidden = role !== "CUSTOMER";
    get("preferences-panel").hidden = role !== "CUSTOMER";
    get("marketing-consent").checked = false;
    text("marketing-consent-status", "");
    stopChart();
    chartPlot = null;
    panelAnimation?.cancel();
    visiblePanel = undefined;
    daily = [];
    contacts = [];
    sendAttempt = undefined;
    sendInFlight = false;
    get("marketing-search").value = "";
    selectContact(undefined);
    get("marketing-form").reset();
    text("marketing-feedback", "");
    if (!admin) {
      for (const id of panels) get(id).hidden = id !== "order-panel";
      text("workspace-heading", "Minha conta");
      if (role === "CUSTOMER") {
        showPreferences();
        loadPreference();
      }
      return;
    }
    let theme = "dark";
    try { if (localStorage.getItem("nhac-admin-theme") === "light") theme = "light"; } catch {}
    setTheme(theme);
    showPanel();
  });
})();
