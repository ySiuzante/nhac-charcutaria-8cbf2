"use strict";

const shop = document.querySelector("#store");
const shopChannel = document.querySelector("#shop-channel");
const shopSearch = document.querySelector("#shop-search");
const shopMessage = document.querySelector("#shop-message");
const productList = document.querySelector("#product-list");
const cartList = document.querySelector("#cart-items");
const checkoutButton = document.querySelector("#checkout");
const orderList = document.querySelector("#order-list");
const stockList = document.querySelector("#stock-list");
const wholesaleForm = document.querySelector("#wholesale-form");
const wholesaleList = document.querySelector("#wholesale-list");
const priceList = document.querySelector("#price-list");
const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const statuses = { received: "Recebido", preparing: "Em preparo", ready: "Pronto", cancelled: "Cancelado" };

let shopSession;
let catalog = [];
let cart = { items: [], total_cents: 0 };
let isDemo = false;
let busy = false;
let requestId;

function element(tag, value, className) {
  const node = document.createElement(tag);
  if (value !== undefined) node.textContent = value;
  if (className) node.className = className;
  return node;
}

async function shopApi(path, data) {
  const response = await request(path, {
    signal: shopSession.signal,
    ...(data && {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
      body: JSON.stringify(data),
    }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Não foi possível concluir a operação.");
  return result;
}

async function withFeedback(operation) {
  if (busy) return;
  const session = shopSession;
  busy = true;
  shopChannel.disabled = true;
  checkoutButton.disabled = true;
  shopMessage.textContent = "";
  try {
    await operation();
  } catch (error) {
    if (!session.signal.aborted) shopMessage.textContent = error.message;
  } finally {
    if (shopSession === session) {
      busy = false;
      shopChannel.disabled = false;
      renderCart();
    }
  }
}

function renderCatalog() {
  const wholesale = shopChannel.value === "wholesale";
  const search = shopSearch.value.trim().toLocaleLowerCase("pt-BR");
  productList.replaceChildren();
  for (const product of catalog) {
    if (!`${product.name} ${product.category}`.toLocaleLowerCase("pt-BR").includes(search)) continue;
    const minimum = wholesale ? product.wholesale_minimum : 1;
    const card = element("article", undefined, "shop-product");
    const image = element("img");
    image.src = product.image;
    image.alt = "";
    image.loading = "lazy";
    const copy = element("div");
    const price = money.format((wholesale ? product.wholesale_cents : product.retail_cents) / 100);
    const button = element("button", product.stock < minimum ? "Indisponível" : `Adicionar ${minimum}`, "shop-add");
    button.type = "button";
    button.disabled = product.stock < minimum;
    button.setAttribute("aria-label", `Adicionar ${minimum} de ${product.name}`);
    button.addEventListener("click", () => withFeedback(async () => {
      const inCart = cart.items.find(item => item.id === product.id)?.quantity || 0;
      await setQuantity(product.id, inCart + minimum);
      shopMessage.textContent = `${product.name} no carrinho.`;
    }));
    copy.append(element("small", `${product.category} · ${product.package}`), element("h3", product.name),
      element("p", product.description), element("strong", price), button);
    card.append(image, copy);
    productList.append(card);
  }
  if (!productList.childElementCount) productList.append(element("p", "Nenhum produto encontrado."));
}

async function setQuantity(productId, quantity) {
  cart = await shopApi("/api/shop/cart", { channel: shopChannel.value, productId, quantity });
  requestId = undefined;
}

function renderCart() {
  cartList.replaceChildren();
  if (!cart.items.length) cartList.append(element("li", "Carrinho vazio."));
  for (const item of cart.items) {
    const row = element("li");
    const quantity = element("input");
    const remove = element("button", "Remover", "text-button");
    quantity.type = "number";
    quantity.min = item.minimum;
    quantity.max = Math.max(item.stock, item.quantity);
    quantity.value = item.quantity;
    quantity.setAttribute("aria-label", `Quantidade de ${item.name}`);
    quantity.addEventListener("change", () => withFeedback(() => setQuantity(item.id, quantity.valueAsNumber)));
    remove.type = "button";
    remove.addEventListener("click", () => withFeedback(() => setQuantity(item.id, 0)));
    const controls = element("div", undefined, "cart-controls");
    controls.append(quantity, remove);
    row.append(element("strong", item.name), element("span", money.format(item.unit_cents * item.quantity / 100)), controls);
    cartList.append(row);
  }
  document.querySelector("#cart-total").textContent = money.format(cart.total_cents / 100);
  checkoutButton.disabled = busy || !isDemo || !cart.items.length;
}

async function loadOrders(role) {
  const isAdmin = role === "MAIN";
  const result = await shopApi(isAdmin ? "/api/admin/orders" : "/api/shop/orders");
  orderList.replaceChildren();
  if (!result.orders.length) orderList.append(element("p", "Nenhum pedido registrado."));
  for (const order of result.orders) {
    const row = element("article", undefined, "order-card");
    const header = element("div", undefined, "order-heading");
    header.append(element("strong", `Pedido ${order.id.slice(0, 8).toUpperCase()}`), element("span", statuses[order.status]));
    row.append(header, element("p", [isAdmin && order.customer, order.channel === "retail" ? "Varejo" : "Atacado", money.format(order.total_cents / 100)].filter(Boolean).join(" · ")));
    const items = element("ul");
    for (const item of order.items) items.append(element("li", `${item.quantity} × ${item.product_name}`));
    row.append(items);
    if (isAdmin && ["received", "preparing"].includes(order.status)) {
      const actions = element("div", undefined, "order-actions");
      const next = order.status === "received" ? "preparing" : "ready";
      for (const [status, label] of [[next, statuses[next]], ["cancelled", "Cancelar pedido"]]) {
        const button = element("button", label, "shop-add");
        button.type = "button";
        button.addEventListener("click", () => withFeedback(async () => {
          if (status === "cancelled" && !window.confirm("Cancelar o pedido e devolver as unidades ao estoque?")) return;
          await shopApi("/api/admin/orders", { id: order.id, status });
          await loadOrders(role);
          shopMessage.textContent = "Status atualizado.";
        }));
        actions.append(button);
      }
      row.append(actions);
    }
    orderList.append(row);
  }
  if (isAdmin) {
    renderPrices(result.products);
    stockList.replaceChildren();
    for (const product of result.products) stockList.append(element("li", `${product.name} · ${product.stock} un.`));
    wholesaleList.replaceChildren();
    if (!result.wholesale.length) wholesaleList.append(element("p", "Nenhuma solicitação."));
    for (const account of result.wholesale) {
      const row = element("article", undefined, "order-card");
      const approved = Boolean(account.approved);
      const button = element("button", approved ? "Revogar acesso" : "Aprovar acesso", "shop-add");
      button.type = "button";
      button.addEventListener("click", () => withFeedback(async () => {
        await shopApi("/api/admin/wholesale", { userId: account.user_id, approved: !approved });
        await loadOrders(role);
      }));
      row.append(element("strong", account.company), element("p", `${account.name} · ${approved ? "Aprovado" : "Pendente"}`), button);
      wholesaleList.append(row);
    }
  }
}

function renderPrices(products) {
  priceList.replaceChildren();
  for (const product of products) {
    const form = element("form", undefined, "order-card price-form");
    const save = element("button", "Salvar preços", "shop-add");
    const fields = ["retail_cents", "wholesale_cents"].map((key, index) => {
      const label = element("label", index === 0 ? "Varejo (R$)" : "Atacado (R$)");
      const input = element("input");
      input.type = "number";
      input.required = true;
      input.step = "0.01";
      input.min = "0.01";
      input.max = "999999.99";
      input.name = key;
      input.value = (product[key] / 100).toFixed(2);
      label.append(input);
      return label;
    });
    save.type = "submit";
    form.append(element("strong", product.name), ...fields, save);
    form.addEventListener("submit", event => {
      event.preventDefault();
      withFeedback(async () => {
        save.disabled = true;
        try {
          const prices = Object.fromEntries([...new FormData(form)].map(([key, value]) => [key, Math.round(Number(value) * 100)]));
          await shopApi("/api/admin/prices", { ...prices, productId: product.id });
          shopMessage.textContent = "Preços atualizados.";
        } finally { save.disabled = false; }
      });
    });
    priceList.append(form);
  }
}

async function loadStore() {
  const [result, wholesale] = await Promise.all([shopApi("/api/shop/products"), shopApi("/api/shop/wholesale")]);
  catalog = result.products;
  isDemo = result.demo;
  shopChannel.options[1].disabled = !result.wholesale;
  if (!result.wholesale && shopChannel.value === "wholesale") shopChannel.value = "retail";
  wholesaleForm.hidden = Boolean(wholesale.account);
  document.querySelector("#wholesale-status").hidden = !wholesale.account || result.wholesale;
  cart = await shopApi(`/api/shop/cart?channel=${shopChannel.value}`);
  renderCatalog();
}

shopSearch.addEventListener("input", renderCatalog);
wholesaleForm.addEventListener("submit", event => {
  event.preventDefault();
  withFeedback(async () => {
    await shopApi("/api/shop/wholesale", Object.fromEntries(new FormData(wholesaleForm)));
    wholesaleForm.reset();
    await loadStore();
  });
});
shopChannel.addEventListener("change", () => withFeedback(async () => {
  requestId = undefined;
  await loadStore();
}));
checkoutButton.addEventListener("click", () => withFeedback(async () => {
  requestId ||= crypto.randomUUID();
  const order = await shopApi("/api/shop/checkout", { channel: shopChannel.value, requestId });
  requestId = undefined;
  cart = { items: [], total_cents: 0 };
  shopMessage.textContent = `Pedido ${order.id.slice(0, 8).toUpperCase()} registrado sem cobrança.`;
  await Promise.all([loadStore(), loadOrders("CUSTOMER")]);
}));

document.addEventListener("nhac:session", event => {
  shopSession?.abort();
  const role = event.detail;
  busy = false;
  isDemo = false;
  requestId = undefined;
  cart = { items: [], total_cents: 0 };
  catalog = [];
  shopChannel.value = "retail";
  shopSearch.value = "";
  for (const node of [productList, cartList, orderList, stockList, wholesaleList, priceList, shopMessage]) node.replaceChildren();
  wholesaleForm.reset();
  wholesaleForm.hidden = true;
  document.querySelector("#wholesale-status").hidden = true;
  const isCustomer = role === "CUSTOMER";
  shop.hidden = !isCustomer;
  document.querySelector("#shop-nav").hidden = !isCustomer;
  document.querySelector("#stock-panel").hidden = role !== "MAIN";
  document.querySelector("#stock-nav").hidden = role !== "MAIN";
  document.querySelector("#prices-panel").hidden = role !== "MAIN";
  document.querySelector("#prices-nav").hidden = role !== "MAIN";
  document.querySelector("#wholesale-panel").hidden = role !== "MAIN";
  document.querySelector("#wholesale-nav").hidden = role !== "MAIN";
  const note = document.querySelector("#demo-note");
  note.hidden = true;
  if (!role) return;
  shopSession = new AbortController();
  withFeedback(async () => {
    if (isCustomer) await loadStore();
    else isDemo = (await shopApi("/api/shop/products")).demo;
    note.hidden = !isDemo;
    await loadOrders(role);
  });
});
