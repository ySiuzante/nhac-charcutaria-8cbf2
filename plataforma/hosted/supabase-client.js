"use strict";

const authConfig = window.nhacSupabaseConfig;
const nhacAuth = window.supabase?.createClient(authConfig.url, authConfig.publishableKey);

function result(status, data) {
  return Response.json(data, { status });
}

function checked(response) {
  if (response.error) throw response.error;
  return response.data;
}

const apiOperations = {
  "GET /api/admin/users": "admin_users",
  "GET /api/admin/orders": "admin_orders",
  "GET /api/admin/me": "admin_my_account",
  "POST /api/admin/me": "admin_my_account_save",
  "GET /api/admin/access": "admin_access",
  "POST /api/admin/access/levels": "admin_access_level",
  "POST /api/admin/access/assign": "admin_access_assign",
  "POST /api/admin/payment": "admin_order_payment",
  "GET /api/admin/metrics": "admin_metrics",
  "GET /api/admin/marketing": "admin_marketing",
  "GET /api/shop/marketing": "shop_marketing",
  "POST /api/shop/marketing": "shop_marketing",
  "POST /api/admin/orders": "admin_order_status",
  "POST /api/admin/wholesale": "admin_wholesale",
  "POST /api/admin/prices": "admin_prices",
  "GET /api/shop/products": "shop_products",
  "GET /api/shop/orders": "shop_orders",
  "GET /api/shop/cart": "shop_cart",
  "POST /api/shop/cart": "shop_cart_change",
  "POST /api/shop/checkout": "shop_checkout",
  "GET /api/shop/wholesale": "shop_wholesale",
  "POST /api/shop/wholesale": "shop_wholesale_request",
};

function requireAuthClient() {
  if (!nhacAuth) throw new Error("O serviço de acesso está temporariamente indisponível.");
  return nhacAuth;
}

async function sessionProfile() {
  const auth = requireAuthClient();
  const { session } = checked(await auth.auth.getSession());
  if (!session) return result(401, { error: "Entre na sua conta." });
  const profile = checked(await auth.rpc("nhac_api", { operation: "profile" }));
  return result(200, profile);
}

function authError(error) {
  if (error.code === "email_not_confirmed") return "Confirme seu e-mail antes de entrar.";
  if (error.code === "invalid_credentials") return "Confira seu e-mail e senha.";
  if (error.status === 429) return "Muitas tentativas. Aguarde antes de tentar novamente.";
  if (error.code === "email_address_not_authorized") return "O envio de confirmações está restrito à equipe neste ambiente.";
  if (error.code === "weak_password") return "Escolha uma senha mais forte.";
  return "Não foi possível concluir o acesso. Tente novamente.";
}

window.nhacHosted = {
  async request(path, options = {}) {
    const url = new URL(path, location.origin);
    const method = options.method || "GET";
    const payload = options.body ? JSON.parse(options.body) : Object.fromEntries(url.searchParams);
    try {
      const auth = requireAuthClient();
      if (url.pathname === "/api/auth/login") {
        checked(await auth.auth.signInWithPassword({ email: payload.email.trim(), password: payload.password }));
        return await sessionProfile();
      }
      if (url.pathname === "/api/auth/me") return await sessionProfile();
      if (url.pathname === "/api/auth/logout") {
        await window.nhacHosted.signOut();
        return result(200, { ok: true });
      }
      const operation = apiOperations[`${method} ${url.pathname}`];
      if (!operation) return result(404, { error: "Recurso indisponível." });
      let query = auth.rpc("nhac_api", { operation, payload });
      if (options.signal) query = query.abortSignal(options.signal);
      const { data, error } = await query;
      if (error) {
        const status = error.code === "42501" ? 403 : (error.code === "P0001" ? 409 : 400);
        const errorMessage = ["42501", "P0001"].includes(error.code) ? error.message : "Não foi possível concluir a operação.";
        return result(status, { error: errorMessage });
      }
      return result(200, data);
    } catch (error) {
      return result(error.status === 429 ? 429 : 401, { error: authError(error) });
    }
  },
  async sendMarketing(payload) {
    const { session } = checked(await requireAuthClient().auth.getSession());
    if (!session) throw new Error("Entre novamente na sua conta.");
    const response = await fetch("/.netlify/functions/marketing", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Não foi possível verificar o envio. Tente novamente.");
    return data;
  },
  async register({ name, email, password }) {
    if (name.trim().length < 2 || new TextEncoder().encode(password).length > 72) {
      throw new Error("Informe seu nome e use uma senha de 12 a 72 bytes.");
    }
    const auth = requireAuthClient();
    const { error } = await auth.auth.signUp({
      email: email.trim(),
      password,
      options: { data: { name: name.trim() }, emailRedirectTo: location.origin + "/plataforma/" },
    });
    if (error) throw new Error(authError(error));
  },
  async signOut() {
    checked(await requireAuthClient().auth.signOut({ scope: "local" }));
  },
};

window.nhacHosted.request = window.nhacHosted.request.bind(window.nhacHosted);
