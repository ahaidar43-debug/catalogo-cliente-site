const DATA = window.CATALOG_DATA ?? {
  store: { name: "Catalogo de Pecas", whatsapp: "", deliveryFee: 0 },
  categories: [],
  brands: [],
  products: [],
};

const KEYS = {
  cart: "catalogo.cart.v1",
  config: "catalogo.config.v1",
  checkout: "catalogo.checkout.v1",
  orders: "catalogo.orders.v1",
  auth: "catalogo.auth.v1",
};

const storedConfig = readJson(KEYS.config, {});
const officialConfig = {
  ...DATA.store,
  ...(window.STORE_CONFIG ?? {}),
};

const money = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});

const state = {
  query: "",
  category: "",
  brand: "",
  visible: 72,
  currentOrderCode: "",
  activeSellerOrderCode: "",
  pendingSellerLink: null,
  sellerEvents: [],
  sellerUsers: [],
  auth: readJson(KEYS.auth, null),
  cart: readJson(KEYS.cart, {}),
  checkout: readJson(KEYS.checkout, {
    name: "",
    phone: "",
    mode: "retirada",
    address: "",
    payment: "Pix",
    notes: "",
  }),
  config: {
    ...officialConfig,
    ...storedConfig,
    whatsapp: String(storedConfig.whatsapp || officialConfig.whatsapp || "").replace(/\D/g, ""),
  },
};

const ownerMode = new URLSearchParams(window.location.search).has("dono")
  || new URLSearchParams(window.location.search).has("admin");

const refs = {
  storeName: document.querySelector("#storeName"),
  storeSubtitle: document.querySelector("#storeSubtitle"),
  ownerNotice: document.querySelector("#ownerNotice"),
  sellerDashboard: document.querySelector("#sellerDashboard"),
  sellerOrders: document.querySelector("#sellerOrders"),
  sellerDetail: document.querySelector("#sellerDetail"),
  mainLayout: document.querySelector("#mainLayout"),
  searchInput: document.querySelector("#searchInput"),
  brandSelect: document.querySelector("#brandSelect"),
  categoryStrip: document.querySelector("#categoryStrip"),
  resultCount: document.querySelector("#resultCount"),
  activeFilterLabel: document.querySelector("#activeFilterLabel"),
  clearFiltersButton: document.querySelector("#clearFiltersButton"),
  productGrid: document.querySelector("#productGrid"),
  loadMoreButton: document.querySelector("#loadMoreButton"),
  cartCount: document.querySelector("#cartCount"),
  desktopCart: document.querySelector("#desktopCart"),
  mobileCart: document.querySelector("#mobileCart"),
  cartBackdrop: document.querySelector("#cartBackdrop"),
  openCartButton: document.querySelector("#openCartButton"),
  mobileOrderBar: document.querySelector("#mobileOrderBar"),
  mobileOrderButton: document.querySelector("#mobileOrderButton"),
  mobileOrderSummary: document.querySelector("#mobileOrderSummary"),
  mobileOrderTotal: document.querySelector("#mobileOrderTotal"),
  configButton: document.querySelector("#configButton"),
  configDialog: document.querySelector("#configDialog"),
  configForm: document.querySelector("#configForm"),
  configStoreName: document.querySelector("#configStoreName"),
  configWhatsapp: document.querySelector("#configWhatsapp"),
  configDeliveryFee: document.querySelector("#configDeliveryFee"),
  historyButton: document.querySelector("#historyButton"),
  historyDialog: document.querySelector("#historyDialog"),
  historyList: document.querySelector("#historyList"),
  toast: document.querySelector("#toast"),
};

const activeProducts = DATA.products.filter((product) => product.active);
const productsById = new Map(DATA.products.map((product) => [product.id, product]));
const categoryCounts = activeProducts.reduce((map, product) => {
  map.set(product.type, (map.get(product.type) ?? 0) + 1);
  return map;
}, new Map());

init();

async function init() {
  document.body.classList.toggle("owner-mode", ownerMode);
  refs.mainLayout.hidden = ownerMode;
  refs.sellerDashboard.hidden = !ownerMode;
  refs.openCartButton.hidden = ownerMode;
  refs.historyButton.hidden = true;
  refs.configButton.hidden = true;
  refs.ownerNotice.hidden = !ownerMode;
  renderStore();
  bindEvents();
  if (ownerMode) {
    state.pendingSellerLink = getSellerLinkParams();
    await renderSellerDashboard(state.pendingSellerLink?.code || importSharedOrderFromUrl());
    if (state.pendingSellerLink?.code) showToast("Entre para abrir o pedido recebido");
    return;
  }
  renderBrandOptions();
  renderCategoryChips();
  renderProducts();
  renderCart();
}

function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

async function apiRequest(path, options = {}) {
  const headers = {
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(options.headers || {}),
  };
  if (state.auth?.token) headers.Authorization = `Bearer ${state.auth.token}`;

  const response = await fetch(path, {
    ...options,
    headers,
  });

  if (!response.ok) {
    let message = "Nao foi possivel conectar com a base";
    try {
      message = (await response.json()).error || message;
    } catch {}
    throw new Error(message);
  }

  if (options.raw) return response;
  return response.json();
}

function saveAuth(auth) {
  state.auth = auth;
  writeJson(KEYS.auth, auth);
}

function clearAuth() {
  state.auth = null;
  localStorage.removeItem(KEYS.auth);
}

function normalize(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function renderStore() {
  refs.storeName.textContent = state.config.name || DATA.store.name || "Catalogo de Pecas";
  refs.storeSubtitle.textContent = ownerMode ? "Modo vendedora" : "Pedido online";
  refs.configStoreName.value = state.config.name || "";
  refs.configWhatsapp.value = state.config.whatsapp || "";
  refs.configDeliveryFee.value = Number(state.config.deliveryFee || 0).toFixed(2);
}

function renderBrandOptions() {
  const brands = DATA.brands.filter(Boolean);
  refs.brandSelect.innerHTML = [
    '<option value="">Todas as marcas</option>',
    ...brands.map((brand) => `<option value="${escapeHtml(brand)}">${escapeHtml(brand)}</option>`),
  ].join("");
}

function renderCategoryChips() {
  const categories = DATA.categories
    .filter((category) => category.active && categoryCounts.has(category.name))
    .map((category) => ({
      ...category,
      count: categoryCounts.get(category.name) ?? category.count,
    }));

  refs.categoryStrip.innerHTML = [
    categoryButton("", "Todos", activeProducts.length),
    ...categories.map((category) => categoryButton(category.name, category.name, category.count)),
  ].join("");
}

function categoryButton(value, label, count) {
  const active = state.category === value ? " is-active" : "";
  return `
    <button class="category-chip${active}" type="button" data-category="${escapeHtml(value)}">
      ${escapeHtml(label)}
      <span>${count}</span>
    </button>
  `;
}

function bindEvents() {
  refs.searchInput.addEventListener("input", (event) => {
    state.query = event.target.value;
    state.visible = 72;
    renderProducts();
  });

  refs.brandSelect.addEventListener("change", (event) => {
    state.brand = event.target.value;
    state.visible = 72;
    renderProducts();
  });

  refs.categoryStrip.addEventListener("click", (event) => {
    const button = event.target.closest("[data-category]");
    if (!button) return;
    state.category = button.dataset.category;
    state.visible = 72;
    renderCategoryChips();
    renderProducts();
  });

  refs.clearFiltersButton.addEventListener("click", () => {
    state.query = "";
    state.category = "";
    state.brand = "";
    state.visible = 72;
    refs.searchInput.value = "";
    refs.brandSelect.value = "";
    renderCategoryChips();
    renderProducts();
  });

  refs.loadMoreButton.addEventListener("click", () => {
    state.visible += 72;
    renderProducts();
  });

  refs.productGrid.addEventListener("click", (event) => {
    const addButton = event.target.closest("[data-add-product]");
    if (addButton) {
      addProduct(addButton.dataset.addProduct);
      return;
    }

    const increaseButton = event.target.closest("[data-increase]");
    if (increaseButton) {
      increaseProduct(increaseButton.dataset.increase);
      return;
    }

    const decreaseButton = event.target.closest("[data-decrease]");
    if (decreaseButton) {
      decreaseProduct(decreaseButton.dataset.decrease);
      return;
    }

    if (event.target.closest("[data-open-cart-mini]")) {
      openMobileCart();
    }
  });

  refs.desktopCart.addEventListener("click", handleCartClick);
  refs.mobileCart.addEventListener("click", handleCartClick);

  refs.openCartButton.addEventListener("click", openMobileCart);
  refs.mobileOrderButton.addEventListener("click", openMobileCart);
  refs.cartBackdrop.addEventListener("click", closeMobileCart);

  refs.configButton.addEventListener("click", () => {
    renderStore();
    refs.configDialog.showModal();
  });

  refs.configForm.addEventListener("submit", (event) => {
    event.preventDefault();
    state.config = {
      name: refs.configStoreName.value.trim() || "Catalogo de Pecas",
      whatsapp: refs.configWhatsapp.value.replace(/\D/g, ""),
      deliveryFee: Number(refs.configDeliveryFee.value || 0),
    };
    writeJson(KEYS.config, state.config);
    renderStore();
    renderCart();
    refs.configDialog.close();
    showToast("Configuracoes salvas");
  });

  refs.historyButton.addEventListener("click", () => {
    renderHistory();
    refs.historyDialog.showModal();
  });

  refs.historyList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-download-history]");
    if (!button) return;
    const orders = readJson(KEYS.orders, []);
    const order = orders.find((item) => item.code === button.dataset.downloadHistory);
    if (order) downloadQuote(order);
  });

  refs.sellerDashboard.addEventListener("click", handleSellerDashboardClick);
  refs.sellerDashboard.addEventListener("submit", handleSellerDashboardSubmit);
}

function getFilteredProducts() {
  const query = normalize(state.query);
  const queryParts = query.split(/\s+/).filter(Boolean);

  return activeProducts.filter((product) => {
    if (state.category && product.type !== state.category) return false;
    if (state.brand && product.brand !== state.brand) return false;
    if (!queryParts.length) return true;

    const haystack = normalize(`${product.name} ${product.brand} ${product.type} ${product.section} ${product.id}`);
    return queryParts.every((part) => haystack.includes(part));
  });
}

function renderProducts() {
  const filtered = getFilteredProducts();
  const visible = filtered.slice(0, state.visible);

  refs.resultCount.textContent = `${filtered.length} ${filtered.length === 1 ? "produto" : "produtos"}`;
  refs.activeFilterLabel.textContent = currentFilterLabel();
  refs.loadMoreButton.hidden = filtered.length <= state.visible;

  refs.productGrid.innerHTML = visible.length
    ? visible.map(renderProductCard).join("")
    : `<div class="empty-cart">Nenhum produto encontrado</div>`;
}

function currentFilterLabel() {
  const labels = [];
  if (state.category) labels.push(state.category);
  if (state.brand) labels.push(state.brand);
  if (state.query.trim()) labels.push(`Busca: ${state.query.trim()}`);
  return labels.length ? labels.join(" / ") : "Todos os itens ativos";
}

function renderProductCard(product) {
  const quantityInCart = state.cart[product.id] ?? 0;
  const tiers = formatTiers(product);
  const minQty = getInitialQty(product);
  const photoUrl = getProductPhotoUrl(product);
  const actions = quantityInCart
    ? `
        <div class="card-cart-actions">
          <div class="qty-control">
            <button type="button" data-decrease="${escapeHtml(product.id)}" aria-label="Diminuir quantidade">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 11h14v2H5z" /></svg>
            </button>
            <output>${quantityInCart}</output>
            <button type="button" data-increase="${escapeHtml(product.id)}" aria-label="Aumentar quantidade">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5h2v14h-2zM5 11h14v2H5z" /></svg>
            </button>
          </div>
          <button class="primary-outline" type="button" data-open-cart-mini="true">Ver pedido</button>
        </div>
      `
    : `<button class="add-button" type="button" data-add-product="${escapeHtml(product.id)}">Adicionar</button>`;

  return `
    <article class="product-card">
      <div class="product-visual${photoUrl ? " has-photo" : " no-photo"}">
        ${
          photoUrl
            ? `<img class="product-photo" src="${escapeHtml(photoUrl)}" alt="${escapeHtml(product.name)}" loading="lazy" onerror="this.closest('.product-visual').classList.add('no-photo'); this.remove();" />`
            : ""
        }
        <span class="type-badge">${escapeHtml(product.type)}</span>
        <span class="part-symbol" aria-hidden="true">${escapeHtml(symbolFor(product.type))}</span>
      </div>
      <div class="product-body">
        <h2>${escapeHtml(product.name)}</h2>
        <div class="product-meta">
          <span class="meta-pill">${escapeHtml(product.brand || "GERAL")}</span>
          <span class="meta-pill">${escapeHtml(product.id)}</span>
        </div>
        <div class="price-line">
          <strong>${money.format(product.price || bestVisiblePrice(product))}</strong>
          <span>min. ${minQty} peca${minQty > 1 ? "s" : ""}</span>
        </div>
        <div class="tier-line">${escapeHtml(tiers)}</div>
      </div>
      <div class="product-actions">
        ${actions}
      </div>
    </article>
  `;
}

function getProductPhotoUrl(product) {
  if (product.imageUrl) return product.imageUrl;
  const mappedPhoto = window.PRODUCT_PHOTOS?.[product.id];
  if (mappedPhoto) return mappedPhoto.startsWith("http") || mappedPhoto.startsWith("./")
    ? mappedPhoto
    : `./fotos/${mappedPhoto}`;
  return "";
}

function symbolFor(type) {
  const words = String(type || "CP")
    .split(/\s+|\/|-/)
    .filter(Boolean)
    .slice(0, 2);
  return words.map((word) => word[0]).join("").slice(0, 3).toUpperCase() || "CP";
}

function formatTiers(product) {
  if (!product.tiers?.length) return "";
  return product.tiers
    .map((tier) => `${tier.minQty}+ ${money.format(tier.price)}`)
    .join("  |  ");
}

function bestVisiblePrice(product) {
  return product.tiers?.[0]?.price ?? product.price ?? 0;
}

function getInitialQty(product) {
  const validMins = (product.tiers ?? [])
    .map((tier) => Number(tier.minQty))
    .filter((value) => Number.isFinite(value) && value > 0);
  return Math.min(...validMins, Number(product.minQty) || 1);
}

function addProduct(productId) {
  const product = productsById.get(productId);
  if (!product) return;
  const current = state.cart[productId] ?? 0;
  state.cart[productId] = current ? current + 1 : getInitialQty(product);
  state.currentOrderCode = "";
  persistCart();
  renderProducts();
  renderCart();
  showToast("Produto adicionado");
}

function handleCartClick(event) {
  const button = event.target.closest("button");
  if (!button) return;

  if (button.dataset.closeCart) {
    closeMobileCart();
    return;
  }

  if (button.dataset.increase) {
    increaseProduct(button.dataset.increase);
    return;
  }

  if (button.dataset.decrease) {
    decreaseProduct(button.dataset.decrease);
    return;
  }

  if (button.dataset.remove) {
    delete state.cart[button.dataset.remove];
    state.currentOrderCode = "";
    persistCart();
    renderProducts();
    renderCart();
    return;
  }

  if (button.dataset.copyOrder) {
    copyOrder().catch((error) => showToast(error.message));
    return;
  }

  if (button.dataset.whatsappOrder) {
    sendWhatsApp().catch((error) => showToast(error.message));
    return;
  }

  if (button.dataset.downloadQuote) {
    downloadQuote(buildOrderText());
  }
}

function decreaseProduct(productId) {
  const product = productsById.get(productId);
  const min = product ? getInitialQty(product) : 1;
  const current = state.cart[productId] ?? 0;

  if (current <= min) {
    delete state.cart[productId];
  } else {
    state.cart[productId] = current - 1;
  }

  state.currentOrderCode = "";
  persistCart();
  renderProducts();
  renderCart();
}

function increaseProduct(productId) {
  state.cart[productId] = (state.cart[productId] ?? 0) + 1;
  state.currentOrderCode = "";
  persistCart();
  renderProducts();
  renderCart();
}

function persistCart() {
  writeJson(KEYS.cart, state.cart);
  refs.cartCount.textContent = getCartItems().reduce((sum, item) => sum + item.qty, 0);
}

function getCartItems() {
  return Object.entries(state.cart)
    .map(([id, qty]) => {
      const product = productsById.get(id);
      if (!product || !qty) return null;
      const tier = getPriceTier(product, qty);
      const unitPrice = tier?.price ?? product.price ?? 0;
      return {
        product,
        qty,
        tier,
        unitPrice,
        lineTotal: unitPrice * qty,
      };
    })
    .filter(Boolean);
}

function getPriceTier(product, qty) {
  const tiers = [...(product.tiers ?? [])]
    .filter((tier) => tier.price && tier.minQty)
    .sort((a, b) => a.minQty - b.minQty);
  let match = tiers[0] ?? null;

  for (const tier of tiers) {
    if (qty >= tier.minQty) match = tier;
  }

  return match;
}

function renderCart() {
  persistCheckoutFromDom();
  persistCart();
  const cartHtml = buildCartHtml();
  refs.desktopCart.innerHTML = cartHtml;
  refs.mobileCart.innerHTML = cartHtml;
  renderMobileOrderBar();
  hydrateCheckoutForms();
}

function renderMobileOrderBar() {
  const items = getCartItems();
  const itemCount = items.reduce((sum, item) => sum + item.qty, 0);
  const subtotal = items.reduce((sum, item) => sum + item.lineTotal, 0);
  const deliveryFee = state.checkout.mode === "entrega" ? Number(state.config.deliveryFee || 0) : 0;
  const total = subtotal + deliveryFee;

  refs.mobileOrderBar.hidden = itemCount === 0;
  refs.mobileOrderSummary.textContent = `${itemCount} ${itemCount === 1 ? "peca" : "pecas"} no carrinho`;
  refs.mobileOrderTotal.textContent = money.format(total);
}

function buildCartHtml() {
  const items = getCartItems();
  const subtotal = items.reduce((sum, item) => sum + item.lineTotal, 0);
  const deliveryFee = state.checkout.mode === "entrega" ? Number(state.config.deliveryFee || 0) : 0;
  const total = subtotal + deliveryFee;
  const disabled = items.length ? "" : "disabled";
  const ownerActionClass = ownerMode ? " checkout-actions-owner" : "";

  return `
    <div class="cart-shell">
      <div class="cart-header">
        <div>
          <h2>Carrinho</h2>
          <span>${items.length} ${items.length === 1 ? "item" : "itens"}</span>
        </div>
        <button class="icon-button mobile-only" type="button" data-close-cart="true" aria-label="Fechar carrinho" title="Fechar carrinho">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m6.4 5 12.6 12.6-1.4 1.4L5 6.4 6.4 5Zm12.6 1.4L6.4 19 5 17.6 17.6 5 19 6.4Z" />
          </svg>
        </button>
      </div>

      <div class="cart-scroll">
        ${
          items.length
            ? items.map(renderCartItem).join("")
            : '<div class="empty-cart">Seu carrinho esta vazio</div>'
        }
      </div>

      <div class="cart-footer">
        <div class="summary-lines">
          <div><span>Subtotal</span><strong>${money.format(subtotal)}</strong></div>
          <div><span>Entrega</span><strong>${money.format(deliveryFee)}</strong></div>
          <div class="total"><span>Total</span><strong>${money.format(total)}</strong></div>
        </div>

        <form class="checkout-form" data-checkout-form>
          <label>Nome
            <input name="name" type="text" autocomplete="name" value="${escapeHtml(state.checkout.name)}" />
          </label>
          <label>Telefone
            <input name="phone" type="tel" autocomplete="tel" value="${escapeHtml(state.checkout.phone)}" />
          </label>
          <label>Tipo
            <select name="mode">
              <option value="retirada" ${state.checkout.mode === "retirada" ? "selected" : ""}>Retirada</option>
              <option value="entrega" ${state.checkout.mode === "entrega" ? "selected" : ""}>Entrega</option>
            </select>
          </label>
          <label>Endereco
            <textarea name="address" rows="2">${escapeHtml(state.checkout.address)}</textarea>
          </label>
          <label>Pagamento
            <select name="payment">
              ${["Pix", "Dinheiro", "Cartao", "A combinar"]
                .map((value) => `<option value="${value}" ${state.checkout.payment === value ? "selected" : ""}>${value}</option>`)
                .join("")}
            </select>
          </label>
          <label>Observacao
            <textarea name="notes" rows="2">${escapeHtml(state.checkout.notes)}</textarea>
          </label>
        </form>

        <div class="checkout-actions${ownerActionClass}">
          ${ownerMode ? `<button class="primary-outline" type="button" data-download-quote="true" ${disabled}>Excel</button>` : ""}
          <button class="primary-outline" type="button" data-copy-order="true" ${disabled}>Copiar</button>
          <button class="checkout-button" type="button" data-whatsapp-order="true" ${disabled}>Enviar pedido</button>
        </div>
      </div>
    </div>
  `;
}

function renderCartItem(item) {
  return `
    <div class="cart-item">
      <div class="cart-item-title">
        <strong>${escapeHtml(item.product.name)}</strong>
        <span>${money.format(item.lineTotal)}</span>
      </div>
      <small>${escapeHtml(item.tier?.label ?? "")} - ${money.format(item.unitPrice)} cada</small>
      <div class="qty-control">
        <button type="button" data-decrease="${escapeHtml(item.product.id)}" aria-label="Diminuir">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 11h14v2H5z" /></svg>
        </button>
        <output>${item.qty}</output>
        <button type="button" data-increase="${escapeHtml(item.product.id)}" aria-label="Aumentar">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5h2v14h-2zM5 11h14v2H5z" /></svg>
        </button>
      </div>
      <button class="text-button" type="button" data-remove="${escapeHtml(item.product.id)}">Remover</button>
    </div>
  `;
}

function hydrateCheckoutForms() {
  document.querySelectorAll("[data-checkout-form]").forEach((form) => {
    form.addEventListener("input", () => {
      readCheckoutForm(form);
      writeJson(KEYS.checkout, state.checkout);
      updateTotalsOnly();
    });
    form.addEventListener("change", () => {
      readCheckoutForm(form);
      writeJson(KEYS.checkout, state.checkout);
      renderCart();
    });
  });
}

function persistCheckoutFromDom() {
  const form = document.querySelector("[data-checkout-form]");
  if (form) {
    readCheckoutForm(form);
    writeJson(KEYS.checkout, state.checkout);
  }
}

function readCheckoutForm(form) {
  const formData = new FormData(form);
  state.checkout = {
    name: String(formData.get("name") ?? ""),
    phone: String(formData.get("phone") ?? ""),
    mode: String(formData.get("mode") ?? "retirada"),
    address: String(formData.get("address") ?? ""),
    payment: String(formData.get("payment") ?? "Pix"),
    notes: String(formData.get("notes") ?? ""),
  };
}

function updateTotalsOnly() {
  const items = getCartItems();
  const subtotal = items.reduce((sum, item) => sum + item.lineTotal, 0);
  const deliveryFee = state.checkout.mode === "entrega" ? Number(state.config.deliveryFee || 0) : 0;
  const total = subtotal + deliveryFee;
  document.querySelectorAll(".summary-lines").forEach((summary) => {
    const rows = summary.querySelectorAll("strong");
    if (rows[0]) rows[0].textContent = money.format(subtotal);
    if (rows[1]) rows[1].textContent = money.format(deliveryFee);
    if (rows[2]) rows[2].textContent = money.format(total);
  });
}

function buildOrderText() {
  persistCheckoutFromDom();
  const items = getCartItems();
  const subtotal = items.reduce((sum, item) => sum + item.lineTotal, 0);
  const deliveryFee = state.checkout.mode === "entrega" ? Number(state.config.deliveryFee || 0) : 0;
  const total = subtotal + deliveryFee;
  const orderCode = state.currentOrderCode || makeOrderCode();
  state.currentOrderCode = orderCode;

  const itemLines = items.map((item) => {
    const tierLabel = item.tier?.label ? ` (${item.tier.label})` : "";
    return `- ${item.qty}x ${item.product.name}${tierLabel} - ${money.format(item.unitPrice)} cada - ${money.format(item.lineTotal)}`;
  });

  return {
    code: orderCode,
    customer: { ...state.checkout },
    store: { ...state.config },
    items: items.map((item) => ({
      id: item.product.id,
      name: item.product.name,
      qty: item.qty,
      unitPrice: item.unitPrice,
      lineTotal: item.lineTotal,
      tierLabel: item.tier?.label ?? "",
    })),
    subtotal,
    deliveryFee,
    total,
    itemCount: items.reduce((sum, item) => sum + item.qty, 0),
    text: [
      `NUMERO DO PEDIDO: ${orderCode}`,
      "",
      "Ola, fiz um pedido pelo catalogo.",
      "Segue para conferencia e cobranca:",
      "",
      `Loja: ${state.config.name || DATA.store.name || "Catalogo"}`,
      "",
      `Cliente: ${state.checkout.name || "Nao informado"}`,
      `Telefone: ${state.checkout.phone || "Nao informado"}`,
      `Tipo: ${state.checkout.mode === "entrega" ? "Entrega" : "Retirada"}`,
      state.checkout.mode === "entrega" ? `Endereco: ${state.checkout.address || "Nao informado"}` : "",
      `Pagamento: ${state.checkout.payment || "Nao informado"}`,
      state.checkout.notes ? `Observacao: ${state.checkout.notes}` : "",
      "",
      "Itens:",
      ...itemLines,
      "",
      `Subtotal: ${money.format(subtotal)}`,
      `Entrega: ${money.format(deliveryFee)}`,
      `Total: ${money.format(total)}`,
    ]
      .filter((line) => line !== "")
      .join("\n"),
  };
}

function addSellerLink(order) {
  const sellerUrl = makeSellerOrderUrl(order);
  return {
    ...order,
    sellerUrl,
    text: [
      order.text,
      "",
      "LINK PARA VENDEDORA VISUALIZAR E BAIXAR EXCEL:",
      sellerUrl,
    ].join("\n"),
  };
}

function makeSellerOrderUrl(order) {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("dono", "1");
  url.hash = `pedido=${encodeOrderForUrl(order)}`;
  return url.toString();
}

function encodeOrderForUrl(order) {
  const payload = {
    code: order.code,
    date: order.date || new Date().toISOString(),
    customer: order.customer,
    checkout: order.checkout || order.customer,
    store: order.store,
    items: order.items,
    subtotal: order.subtotal,
    deliveryFee: order.deliveryFee,
    total: order.total,
    itemCount: order.itemCount,
    text: order.text,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeOrderFromUrl(payload) {
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function importSharedOrderFromUrl() {
  const hash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash;
  const payload = new URLSearchParams(hash).get("pedido");
  if (!payload) return "";
  const order = decodeOrderFromUrl(payload);
  if (!order?.code || !Array.isArray(order.items)) {
    showToast("Link do pedido invalido");
    return "";
  }
  saveOrder(order);
  return order.code;
}

function getSellerLinkParams() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("pedido");
  const token = params.get("token");
  return code ? { code, token: token || "" } : null;
}

async function prepareOrderForSending() {
  const order = buildOrderText();
  try {
    const saved = await apiRequest("/api/orders", {
      method: "POST",
      body: JSON.stringify(order),
    });
    const sellerUrl = saved.sellerUrl || saved.order?.sellerUrl;
    if (sellerUrl) {
      return {
        ...order,
        sellerUrl,
        text: [
          order.text,
          "",
          "LINK PARA VENDEDORA VISUALIZAR E BAIXAR EXCEL:",
          sellerUrl,
        ].join("\n"),
      };
    }
  } catch {
  }
  return addSellerLink(order);
}

async function copyOrder() {
  const order = await prepareOrderForSending();
  await navigator.clipboard.writeText(order.text);
  saveOrder(order);
  showToast("Pedido copiado");
}

async function sendWhatsApp() {
  const order = await prepareOrderForSending();
  saveOrder(order);
  const phone = String(state.config.whatsapp || "").replace(/\D/g, "");
  const encodedText = encodeURIComponent(order.text);
  const url = phone
    ? `https://wa.me/${phone}?text=${encodedText}`
    : `https://api.whatsapp.com/send?text=${encodedText}`;

  navigator.clipboard?.writeText(order.text).catch(() => {});
  window.location.href = url;
}

function saveOrder(order) {
  const orders = readJson(KEYS.orders, []);
  const checkout = order.checkout || (typeof order.customer === "object" ? order.customer : {});
  const customerName = typeof order.customer === "string"
    ? order.customer
    : checkout?.name || "Cliente";
  const savedOrder = {
    code: order.code,
    date: order.date || new Date().toISOString(),
    customer: customerName,
    total: order.total,
    itemCount: order.itemCount,
    items: order.items,
    subtotal: order.subtotal,
    deliveryFee: order.deliveryFee,
    checkout,
    store: order.store,
    text: order.text,
    sellerUrl: order.sellerUrl || "",
  };
  writeJson(KEYS.orders, [
    savedOrder,
    ...orders.filter((item) => item.code !== savedOrder.code),
  ].slice(0, 50));
}

function renderHistory() {
  const orders = readJson(KEYS.orders, []);
  refs.historyList.innerHTML = orders.length
    ? orders
        .map(
          (order) => `
            <div class="history-item">
              <strong>${escapeHtml(order.code)}</strong>
              <span>${escapeHtml(order.customer)} - ${money.format(order.total || 0)}</span>
              <small>${new Date(order.date).toLocaleString("pt-BR")} - ${order.itemCount} pecas</small>
              ${ownerMode && order.items?.length ? `<button class="primary-outline" type="button" data-download-history="${escapeHtml(order.code)}">Baixar Excel</button>` : ""}
            </div>
          `,
        )
        .join("")
    : '<div class="empty-cart">Nenhum pedido salvo neste navegador</div>';
}

async function handleSellerDashboardClick(event) {
  const button = event.target.closest("button");
  if (!button) return;

  if (button.dataset.logout) {
    clearAuth();
    await renderSellerDashboard();
    return;
  }

  if (button.dataset.viewSellerOrder) {
    await renderSellerDashboard(button.dataset.viewSellerOrder);
    return;
  }

  if (button.dataset.downloadSellerOrder) {
    await downloadSellerOrder(button.dataset.downloadSellerOrder);
    return;
  }

  if (button.dataset.copySellerOrder) {
    const order = await fetchSellerOrder(button.dataset.copySellerOrder);
    if (!navigator.clipboard) {
      showToast("Copia nao disponivel neste navegador");
      return;
    }
    navigator.clipboard.writeText(order.text || buildReadableOrderText(order)).then(
      () => showToast("Mensagem do pedido copiada"),
      () => showToast("Nao foi possivel copiar"),
    );
  }
}

async function handleSellerDashboardSubmit(event) {
  event.preventDefault();
  const form = event.target;

  if (form.matches("[data-login-form]")) {
    const formData = new FormData(form);
    const auth = await apiRequest("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        username: formData.get("username"),
        password: formData.get("password"),
      }),
    });
    saveAuth(auth);
    await renderSellerDashboard(state.pendingSellerLink?.code || "");
    showToast("Login realizado");
    return;
  }

  if (form.matches("[data-create-user-form]")) {
    const formData = new FormData(form);
    await apiRequest("/api/users", {
      method: "POST",
      body: JSON.stringify({
        name: formData.get("name"),
        username: formData.get("username"),
        password: formData.get("password"),
        role: formData.get("role"),
      }),
    });
    form.reset();
    await renderSellerDashboard(state.activeSellerOrderCode);
    showToast("Usuario criado");
  }
}

async function renderSellerDashboard(preferredCode = "") {
  if (!state.auth?.token) {
    renderSellerLogin(preferredCode);
    return;
  }

  let orders = [];
  let selectedOrder = null;

  try {
    const response = await apiRequest("/api/orders");
    orders = response.orders || [];
    const selectedCode = preferredCode || state.activeSellerOrderCode || orders[0]?.code || "";
    selectedOrder = selectedCode ? await fetchSellerOrder(selectedCode) : null;
    state.activeSellerOrderCode = selectedOrder?.code || "";

    if (state.auth.user?.role === "admin") {
      const usersResponse = await apiRequest("/api/users");
      state.sellerUsers = usersResponse.users || [];
    }
  } catch (error) {
    clearAuth();
    renderSellerLogin(preferredCode, error.message);
    return;
  }

  refs.sellerOrders.innerHTML = orders.length
    ? `${renderAdminPanel()}${orders.map((order) => renderSellerOrderCard(order, state.activeSellerOrderCode)).join("")}`
    : `
        ${renderAdminPanel()}
        <div class="seller-empty">
          <strong>Nenhum pedido realizado aberto ainda</strong>
          <span>Quando chegar um WhatsApp do cliente, clique no link da vendedora dentro da mensagem.</span>
        </div>
      `;

  refs.sellerDetail.innerHTML = selectedOrder
    ? renderSellerOrderDetail(selectedOrder)
    : `
        <div class="seller-detail-card seller-empty">
          <strong>Aguardando pedido</strong>
          <span>Ao acessar pelo link do WhatsApp, a vendedora cai direto no pedido com itens, total e botao de Excel.</span>
        </div>
      `;
}

function renderSellerLogin(preferredCode = "", errorMessage = "") {
  refs.sellerOrders.innerHTML = "";
  refs.sellerDetail.innerHTML = `
    <form class="seller-detail-card seller-login" data-login-form>
      <div>
        <span>Modo vendedora</span>
        <h3>Entrar para ver pedidos</h3>
        <p>${preferredCode ? `Acesse para abrir direto o pedido ${escapeHtml(preferredCode)}.` : "Entre para visualizar pedidos realizados e baixar Excel."}</p>
      </div>
      ${errorMessage ? `<div class="seller-error">${escapeHtml(errorMessage)}</div>` : ""}
      <label>Login
        <input name="username" type="text" autocomplete="username" required />
      </label>
      <label>Senha
        <input name="password" type="password" autocomplete="current-password" required />
      </label>
      <button class="primary-button" type="submit">Entrar</button>
    </form>
  `;
}

function renderAdminPanel() {
  if (state.auth?.user?.role !== "admin") return "";
  return `
    <section class="seller-admin-panel">
      <div class="seller-admin-top">
        <strong>Administrador</strong>
        <button class="text-button" type="button" data-logout="true">Sair</button>
      </div>
      <form class="seller-user-form" data-create-user-form>
        <input name="name" type="text" placeholder="Nome" required />
        <input name="username" type="text" placeholder="Login" required />
        <input name="password" type="password" placeholder="Senha" minlength="6" required />
        <select name="role">
          <option value="seller">Vendedora</option>
          <option value="admin">Administrador</option>
        </select>
        <button class="primary-button" type="submit">Criar usuario</button>
      </form>
      <div class="seller-user-list">
        ${state.sellerUsers.map((user) => `<span>${escapeHtml(user.name)} - ${escapeHtml(user.role)}</span>`).join("")}
      </div>
    </section>
  `;
}

function renderSellerOrderCard(order, selectedCode) {
  const active = order.code === selectedCode ? " is-active" : "";
  return `
    <article class="seller-order-card${active}">
      <button type="button" data-view-seller-order="${escapeHtml(order.code)}">
        <strong>${escapeHtml(order.code)}</strong>
        <span>${escapeHtml(orderCustomerName(order))}</span>
        <small>${escapeHtml(formatOrderDate(order.createdAt || order.date))} - ${money.format(Number(order.total || 0))}</small>
      </button>
      <div>
        <button class="primary-outline" type="button" data-download-seller-order="${escapeHtml(order.code)}">Excel</button>
      </div>
    </article>
  `;
}

function renderSellerOrderDetail(order) {
  const checkout = order.checkout || {};
  const items = order.items || [];
  return `
    <article class="seller-detail-card">
      <div class="seller-detail-top">
        <div>
          <span>Pedido</span>
          <h3>${escapeHtml(order.code)}</h3>
          <small>${escapeHtml(formatOrderDate(order.createdAt || order.date))}</small>
        </div>
        <strong>${money.format(Number(order.total || 0))}</strong>
      </div>

      <div class="seller-actions">
        <button class="primary-outline" type="button" data-copy-seller-order="${escapeHtml(order.code)}">Copiar mensagem</button>
        <button class="primary-button" type="button" data-download-seller-order="${escapeHtml(order.code)}">Baixar Excel</button>
      </div>

      <div class="seller-customer">
        <div><span>Cliente</span><strong>${escapeHtml(orderCustomerName(order))}</strong></div>
        <div><span>Telefone</span><strong>${escapeHtml(checkout.phone || "Nao informado")}</strong></div>
        <div><span>Tipo</span><strong>${escapeHtml(checkout.mode === "entrega" ? "Entrega" : "Retirada")}</strong></div>
        <div><span>Pagamento</span><strong>${escapeHtml(checkout.payment || "Nao informado")}</strong></div>
        ${checkout.address ? `<div class="seller-wide"><span>Endereco</span><strong>${escapeHtml(checkout.address)}</strong></div>` : ""}
        ${checkout.notes ? `<div class="seller-wide"><span>Observacao</span><strong>${escapeHtml(checkout.notes)}</strong></div>` : ""}
      </div>

      <div class="seller-items">
        <div class="seller-item seller-item-head">
          <span>Item</span>
          <span>Qtd</span>
          <span>Total</span>
        </div>
        ${items.map(renderSellerItem).join("")}
      </div>

      <div class="seller-total">
        <div><span>Subtotal</span><strong>${money.format(Number(order.subtotal || 0))}</strong></div>
        <div><span>Entrega</span><strong>${money.format(Number(order.deliveryFee || 0))}</strong></div>
        <div><span>Total</span><strong>${money.format(Number(order.total || 0))}</strong></div>
      </div>

      ${state.auth?.user?.role === "admin" ? renderSellerEvents() : ""}
    </article>
  `;
}

function renderSellerItem(item) {
  return `
    <div class="seller-item">
      <span>
        <strong>${escapeHtml(item.name)}</strong>
        <small>${escapeHtml(item.tierLabel || "")} ${money.format(Number(item.unitPrice || 0))} cada</small>
      </span>
      <span>${Number(item.qty || 0)}</span>
      <span>${money.format(Number(item.lineTotal || 0))}</span>
    </div>
  `;
}

function orderCustomerName(order) {
  return order.checkout?.name || order.customer || "Cliente";
}

async function fetchSellerOrder(code) {
  const token = state.pendingSellerLink?.code === code ? state.pendingSellerLink.token : "";
  const suffix = token ? `?token=${encodeURIComponent(token)}` : "";
  const response = await apiRequest(`/api/orders/${encodeURIComponent(code)}${suffix}`);
  state.sellerEvents = response.events || [];
  return response.order;
}

async function downloadSellerOrder(code) {
  const response = await apiRequest(`/api/orders/${encodeURIComponent(code)}/download`, { raw: true });
  const blob = await response.blob();
  const disposition = response.headers.get("content-disposition") || "";
  const fileName = disposition.match(/filename="([^"]+)"/)?.[1] || `${safeFileName(code)}.xls`;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  if (state.activeSellerOrderCode === code) {
    await fetchSellerOrder(code);
    await renderSellerDashboard(code);
  }
  showToast("Download registrado");
}

function renderSellerEvents() {
  return `
    <div class="seller-events">
      <h4>Historico do pedido</h4>
      ${
        state.sellerEvents.length
          ? state.sellerEvents.map((event) => `
              <div>
                <strong>${escapeHtml(eventLabel(event.type))}</strong>
                <span>${escapeHtml(event.user?.name || "Sistema")} - ${escapeHtml(formatOrderDate(event.createdAt))}</span>
              </div>
            `).join("")
          : "<span>Nenhum historico ainda</span>"
      }
    </div>
  `;
}

function eventLabel(type) {
  const labels = {
    created: "Pedido criado",
    viewed: "Pedido visualizado",
    downloaded: "Excel baixado",
  };
  return labels[type] || type;
}

function formatOrderDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("pt-BR");
}

function buildReadableOrderText(order) {
  const items = (order.items || []).map((item) => (
    `- ${item.qty}x ${item.name} - ${money.format(Number(item.unitPrice || 0))} cada - ${money.format(Number(item.lineTotal || 0))}`
  ));
  return [
    `NUMERO DO PEDIDO: ${order.code}`,
    "",
    `Cliente: ${orderCustomerName(order)}`,
    `Telefone: ${order.checkout?.phone || "Nao informado"}`,
    "",
    "Itens:",
    ...items,
    "",
    `Total: ${money.format(Number(order.total || 0))}`,
  ].join("\n");
}

function makeOrderCode() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `ORC-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function downloadQuote(order) {
  if (!ownerMode) {
    showToast("Orcamento Excel disponivel apenas no modo dono");
    return;
  }

  const normalizedOrder = normalizeOrderForQuote(order);
  if (!normalizedOrder.items.length) {
    showToast("Carrinho vazio");
    return;
  }

  const html = buildQuoteHtml(normalizedOrder);
  const blob = new Blob(["\ufeff", html], {
    type: "application/vnd.ms-excel;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${safeFileName(normalizedOrder.code)}-${safeFileName(normalizedOrder.customerName || "CLIENTE")}.xls`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showToast("Orcamento Excel gerado");
}

function normalizeOrderForQuote(order) {
  const currentItems = order.items?.length
    ? order.items
    : getCartItems().map((item) => ({
        name: item.product.name,
        qty: item.qty,
        unitPrice: item.unitPrice,
        lineTotal: item.lineTotal,
      }));
  const subtotal = order.subtotal ?? currentItems.reduce((sum, item) => sum + Number(item.lineTotal || 0), 0);
  const deliveryFee = order.deliveryFee ?? 0;

  return {
    code: order.code || state.currentOrderCode || makeOrderCode(),
    customerName: order.checkout?.name || order.customer?.name || state.checkout.name || "Cliente",
    responsible: "Administrador",
    items: currentItems,
    subtotal,
    deliveryFee,
    total: order.total ?? subtotal + deliveryFee,
  };
}

function buildQuoteHtml(order) {
  const rows = order.items
    .map(
      (item) => `
        <tr>
          <td>${escapeHtml(`${item.qty}x ${item.name}`)}</td>
          <td class="money">${Number(item.unitPrice || 0).toFixed(2)}</td>
          <td class="money">${Number(item.lineTotal || 0).toFixed(2)}</td>
        </tr>
      `,
    )
    .join("");

  const deliveryRow = order.deliveryFee
    ? `
        <tr>
          <td>Taxa de entrega</td>
          <td></td>
          <td class="money">${Number(order.deliveryFee || 0).toFixed(2)}</td>
        </tr>
      `
    : "";

  return `
    <html>
      <head>
        <meta charset="utf-8" />
        <style>
          table { border-collapse: collapse; font-family: Arial, sans-serif; font-size: 12pt; }
          td, th { border: 1px solid #d9d9d9; padding: 8px 10px; }
          .title td { border: 0; font-weight: 700; font-size: 14pt; }
          .spacer td { border: 0; height: 14px; }
          th { background: #f2f2f2; font-weight: 700; text-align: left; }
          .money { mso-number-format: "R$ #,##0.00"; text-align: right; }
          .total td { font-weight: 700; background: #f7f7f7; }
          .item { width: 420px; }
          .value { width: 150px; }
        </style>
      </head>
      <body>
        <table>
          <tr class="title"><td colspan="3">Cliente: ${escapeHtml(order.customerName)}</td></tr>
          <tr class="title"><td colspan="3">${escapeHtml(order.code)} | Responsavel: ${escapeHtml(order.responsible)}</td></tr>
          <tr class="spacer"><td colspan="3"></td></tr>
          <tr>
            <th class="item">Item</th>
            <th class="value">Valor unitario</th>
            <th class="value">Valor total do item</th>
          </tr>
          ${rows}
          ${deliveryRow}
          <tr class="total">
            <td>Total do orcamento</td>
            <td></td>
            <td class="money">${Number(order.total || 0).toFixed(2)}</td>
          </tr>
        </table>
      </body>
    </html>
  `;
}

function safeFileName(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "orcamento";
}

function openMobileCart() {
  refs.cartBackdrop.hidden = false;
  refs.mobileCart.classList.add("is-open");
  refs.mobileCart.setAttribute("aria-hidden", "false");
}

function closeMobileCart() {
  refs.mobileCart.classList.remove("is-open");
  refs.mobileCart.setAttribute("aria-hidden", "true");
  refs.cartBackdrop.hidden = true;
}

function showToast(message) {
  refs.toast.textContent = message;
  refs.toast.classList.add("is-visible");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => refs.toast.classList.remove("is-visible"), 1800);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
