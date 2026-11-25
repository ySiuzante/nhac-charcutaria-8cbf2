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
  const formatter = new Intl.NumberFormat("pt-BR");
  const dates = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short", timeZone: "UTC" });
  const panels = ["sales-dashboard", "order-panel", "catalog-panel", "wholesale-panel", "team", "marketing-panel"];
  const adminLinks = ["catalog-nav", "wholesale-nav", "team-nav", "marketing-nav"];
  let role;
  let daily = [];
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
  const isAdmin = () => role === "MAIN";

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
    const active = panels.includes(target) ? target : "sales-dashboard";
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
    if (active === "sales-dashboard") loadMetrics();
    if (active === "marketing-panel") loadContacts();
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

  function drawChart() {
    if (chart.closest("section").hidden || chart.hidden || !daily.length) return;
    const width = chart.clientWidth;
    const height = chart.clientHeight;
    if (!width || !height) return;
    const dpr = window.devicePixelRatio || 1;
    chart.width = Math.round(width * dpr);
    chart.height = Math.round(height * dpr);
    const ctx = chart.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    const theme = getComputedStyle(workspace);
    const color = key => theme.getPropertyValue("--dash-" + key).trim();
    const left = width < 350 ? 66 : 82;
    const right = width - 14;
    const base = height - 30;
    const top = 14;
    const maximum = Math.max(...daily.map(day => Number(day.cents)), 100);
    const axisUnit = 10 ** Math.floor(Math.log10(maximum));
    const ceiling = Math.ceil(maximum / axisUnit) * axisUnit;
    const x = i => left + (right - left) * (daily.length === 1 ? .5 : i / (daily.length - 1));
    const y = cents => base - (base - top) * (Number(cents) / ceiling);
    ctx.font = "11px Segoe UI, sans-serif";
    ctx.fillStyle = color("muted");
    ctx.strokeStyle = color("line");
    ctx.textBaseline = "middle";
    ctx.textAlign = "right";
    const compact = new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 });
    for (let i = 0; i <= 4; i++) {
      const value = ceiling * i / 4;
      const row = y(value);
      ctx.beginPath(); ctx.moveTo(left, row); ctx.lineTo(right, row); ctx.stroke();
      ctx.fillText("R$ " + compact.format(value / 100), left - 8, row);
    }
    const points = daily.map((day, i) => [x(i), y(day.cents)]);
    const line = () => points.forEach(([px, py], i) => i ? ctx.lineTo(px, py) : ctx.moveTo(px, py));
    ctx.beginPath();
    line();
    ctx.lineTo(points.at(-1)[0], base); ctx.lineTo(points[0][0], base); ctx.closePath();
    const gradient = ctx.createLinearGradient(0, top, 0, base);
    gradient.addColorStop(0, color("chart-fill")); gradient.addColorStop(1, "transparent");
    ctx.fillStyle = gradient; ctx.fill();
    ctx.beginPath(); line(); ctx.strokeStyle = color("accent"); ctx.lineWidth = 2.5; ctx.stroke();
    ctx.fillStyle = color("accent");
    if (points.length <= 8) for (const [px, py] of points) {
      ctx.beginPath(); ctx.arc(px, py, 3, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = color("muted");
    const ticks = width < 380 ? 3 : 5;
    for (let i = 0; i < ticks; i++) {
      const index = Math.round((daily.length - 1) * i / (ticks - 1));
      ctx.textAlign = i === 0 ? "left" : i === ticks - 1 ? "right" : "center";
      ctx.fillText(formatDay(daily[index].day), x(index), height - 12);
    }
  }

  new ResizeObserver(drawChart).observe(chart);

  function breakdown(id, rows, key, labels, empty) {
    const list = get(id);
    list.replaceChildren();
    if (rows.length === 0) list.append(element("li", empty, "dash-empty"));
    for (const row of rows) {
      const item = element("li");
      const detail = element("div");
      detail.append(element("strong", labels[row[key]] ?? row[key]), element("small", formatter.format(row.count) + " " + (row.count === 1 ? "pedido" : "pedidos")));
      item.append(detail, element("strong", amount(row.cents)));
      list.append(item);
    }
  }

  async function loadMetrics() {
    if (!isAdmin() || get("sales-dashboard").hidden) return;
    metricsFetch?.abort();
    const current = metricsFetch = new AbortController();
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
      chart.hidden = false;
      drawChart();
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
    const templates = {
      news: ["Novidades no catálogo da Nhac!", "Olá! Tem novidades no catálogo da Nhac!. Visite a loja ou responda a este e-mail para saber mais."],
      returning: ["Que tal voltar à Nhac!?", "Olá! Estamos com saudade de ter você por aqui. Se quiser ajuda para escolher o próximo pedido, responda a este e-mail."]
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
    for (const id of adminLinks) get(id).hidden = !admin;
    const overviewLink = get("overview-nav");
    overviewLink.href = admin ? "#sales-dashboard" : "#account-name";
    for (const id of ["account-greeting", "account-status-card"]) get(id).hidden = admin;
    get("order-search-label").hidden = !admin;
    get("preferences-nav").hidden = role !== "CUSTOMER";
    get("preferences-panel").hidden = role !== "CUSTOMER";
    get("marketing-consent").checked = false;
    text("marketing-consent-status", "");
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
