"use strict";

const loginScreen = document.querySelector("#login-screen");
const accountScreen = document.querySelector("#account-screen");
const loginForm = document.querySelector("#login-form");
const message = document.querySelector("#login-message");
const loginButton = document.querySelector("#login-button");
let csrfToken = "";
let accountPermissions = new Set();
const canUseAdminArea = (role, permission) => role === "MAIN" || (role === "STAFF" && accountPermissions.has(permission));
const request = window.nhacHosted?.request ?? window.fetch.bind(window);
const registerForm = document.querySelector("#register-form");
const registerToggle = document.querySelector("#register-toggle");
const registerPrompt = document.querySelector("#register-prompt");
const accountMenu = document.querySelector("#account-menu");
const accountNavigation = document.querySelector("#account-navigation");
function switchAuth(form) {
  loginForm.hidden = form !== loginForm;
  registerForm.hidden = form !== registerForm;
  registerPrompt.hidden = !window.nhacHosted || form !== loginForm;
}

if (window.nhacHosted) {
  switchAuth(loginForm);
  document.querySelector('label[for="code"]').hidden = true;
  document.querySelector("#code").hidden = true;
}
registerToggle.addEventListener("click", () => {
  switchAuth(registerForm);
  document.querySelector("#register-name").focus();
});
document.querySelector("#register-back").addEventListener("click", () => {
  switchAuth(loginForm);
  registerToggle.focus();
});

function accountMenuIsOpen() {
  return accountMenu.getAttribute("aria-expanded") === "true";
}

accountMenu.addEventListener("click", () => {
  accountMenu.setAttribute("aria-expanded", String(!accountMenuIsOpen()));
});

function updateAccountNavigation() {
  const links = Array.from(accountNavigation.querySelectorAll("a:not([hidden])"));
  const active = links.find(link => link.hash === window.location.hash) ?? links[0];
  accountNavigation.querySelector("[aria-current]")?.removeAttribute("aria-current");
  active?.setAttribute("aria-current", "location");
}

accountNavigation.addEventListener("click", event => {
  const link = event.target.closest("a");
  if (accountScreen.classList.contains("admin-workspace") || !link || !accountMenuIsOpen() || accountMenu.offsetWidth === 0) return;
  const target = document.getElementById(link.hash.slice(1));
  target?.setAttribute("tabindex", "-1");
  target?.focus({ preventScroll: true });
  accountMenu.setAttribute("aria-expanded", "false");
});

document.querySelector(".sidebar").addEventListener("keydown", event => {
  if (event.key !== "Escape" || !accountMenuIsOpen() || accountMenu.offsetWidth === 0) return;
  accountMenu.setAttribute("aria-expanded", "false");
  accountMenu.focus();
});

window.addEventListener("hashchange", updateAccountNavigation);
registerForm.addEventListener("submit", async event => {
  event.preventDefault();
  const button = registerForm.querySelector('button[type="submit"]');
  const status = document.querySelector("#register-message");
  button.disabled = true;
  status.textContent = "";
  try {
    const data = Object.fromEntries(new FormData(registerForm));
    await window.nhacHosted.register(data);
    registerForm.reset();
    status.textContent = "Confira a caixa de entrada e confirme seu e-mail para acessar a loja.";
  } catch (error) {
    status.textContent = error.message;
  } finally { button.disabled = false; }
});

function showAccount(user) {
  accountPermissions = new Set(user.permissions || []);
  const staff = ["MAIN", "STAFF"].includes(user.role);
  switchAuth(loginForm);
  accountMenu.setAttribute("aria-expanded", "false");
  document.querySelector("#sidebar-label").textContent = staff ? "Painel de gestão" : "Minha conta";
  document.querySelector("#account-email").textContent = user.email;
  document.querySelector("#account-name").textContent = user.name || user.email.split("@")[0];
  document.querySelector("#account-role").textContent = staff ? user.roleName || "Administração principal" : "Conta ativa";
  loginScreen.hidden = true;
  accountScreen.hidden = false;
  const team = document.querySelector("#team");
  team.hidden = !canUseAdminArea(user.role, "clients");
  document.querySelector("#team-nav").hidden = team.hidden;
  if (!team.hidden) loadAccounts();
  document.dispatchEvent(new CustomEvent("nhac:session", { detail: user.role }));
  updateAccountNavigation();
}

async function loadAccounts() {
  const rows = document.querySelector("#team-rows");
  const status = document.querySelector("#team-message");
  rows.replaceChildren();
  status.textContent = "Carregando contas…";
  try {
    const response = await request("/api/admin/users", { credentials: "same-origin" });
    if (!response.ok) throw new Error("accounts");
    const data = await response.json();
    for (const account of data.users) {
      const row = document.createElement("tr");
      for (const value of [account.name, account.email, account.role === "MAIN" ? "MAIN" : account.roleName || "Cliente", account.active ? "Ativa" : "Inativa"]) {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.append(cell);
      }
      rows.append(row);
    }
    status.textContent = data.users.length ? "" : "Nenhuma conta cadastrada.";
  } catch {
    status.textContent = "Não foi possível carregar as contas.";
  }
}

async function refreshSession() {
  const response = await request("/api/auth/me", { credentials: "same-origin" });
  if (response.ok) {
    const data = await response.json();
    csrfToken = data.csrfToken;
    showAccount(data.user);
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginButton.disabled = true;
  message.textContent = "";
  try {
    const response = await request("/api/auth/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.fromEntries(new FormData(loginForm)))
    });
    if (!response.ok) {
      const detail = window.nhacHosted ? (await response.json()).error : null;
      message.textContent = detail || (response.status === 429
        ? "Muitas tentativas. Aguarde antes de tentar novamente."
        : response.status === 401
          ? "Confira o e-mail, a senha e o código de autenticação."
          : "Não foi possível entrar. Tente novamente.");
      return;
    }
    const data = await response.json();
    csrfToken = data.csrfToken;
    loginForm.reset();
    showAccount(data.user);
  } catch {
    message.textContent = "Não foi possível conectar. Tente novamente.";
  } finally {
    loginButton.disabled = false;
  }
});

document.querySelector("#logout-button").addEventListener("click", async () => {
  try {
    const response = await request("/api/auth/logout", { method: "POST", credentials: "same-origin", headers: { "X-CSRF-Token": csrfToken } });
    if (!response.ok) throw new Error("logout");
    csrfToken = "";
    accountPermissions.clear();
    document.dispatchEvent(new CustomEvent("nhac:session", { detail: null }));
    document.querySelector("#team").hidden = true;
    document.querySelector("#team-rows").replaceChildren();
    accountScreen.hidden = true;
    loginScreen.hidden = false;
    document.querySelector("#email").focus();
  } catch {
    window.alert("Não foi possível sair da conta. Tente novamente.");
  }
});

refreshSession().catch(() => { message.textContent = "Não foi possível conectar. Tente novamente."; });
