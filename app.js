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
const localConfig = { ...storedConfig };
if (localConfig.name === "Catalogo de Pecas" && officialConfig.name) {
  localConfig.name = officialConfig.name;
}

const money = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});

const PAYMENT_OPTIONS = ["Pix", "Dinheiro", "A combinar"];
const ORDER_STATUSES = [
  { value: "novo", label: "Novo" },
  { value: "visualizado", label: "Visualizado" },
  { value: "baixado", label: "Baixado" },
  { value: "cobrado", label: "Cobrado" },
  { value: "pago", label: "Pago" },
  { value: "cancelado", label: "Cancelado" },
];
const ORDER_PAGE_SIZE = 50;

const state = {
  query: "",
  category: "",
  brand: "",
  visible: 72,
  currentOrderCode: "",
  activeSellerOrderCode: "",
  sellerOrderQuery: "",
  sellerOrderStatus: "all",
  sellerOrderPage: 1,
  sellerPagination: { page: 1, limit: ORDER_PAGE_SIZE, total: 0, totalPages: 1 },
  adminView: new URLSearchParams(window.location.search).has("catalogo") ? "catalog" : "orders",
  adminCatalogQuery: "",
  adminCatalogStatus: "all",
  adminCatalogVisible: 60,
  catalogOverrides: new Map(),
  pendingSellerLink: null,
  sellerEvents: [],
  sellerUsers: [],
  orderBackups: [],
  lastCartCount: null,
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
    ...localConfig,
    whatsapp: String(localConfig.whatsapp || officialConfig.whatsapp || "").replace(/\D/g, ""),
  },
};

if (!PAYMENT_OPTIONS.includes(state.checkout.payment)) {
  state.checkout.payment = "Pix";
}

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
  photoCropDialog: document.querySelector("#photoCropDialog"),
  photoCropForm: document.querySelector("#photoCropForm"),
  photoCropCanvas: document.querySelector("#photoCropCanvas"),
  photoCropZoom: document.querySelector("#photoCropZoom"),
  toast: document.querySelector("#toast"),
};

const photoCrop = {
  image: null,
  resolve: null,
  reject: null,
  done: false,
  scale: 1,
  minScale: 1,
  offsetX: 0,
  offsetY: 0,
  dragging: false,
  startX: 0,
  startY: 0,
  baseOffsetX: 0,
  baseOffsetY: 0,
};

DATA.products.forEach((product) => {
  product.baseActive = Boolean(product.active);
  product.baseImageUrl = product.imageUrl || "";
});

let activeProducts = [];
let productsById = new Map();
let categoryCounts = new Map();
rebuildCatalogIndexes();

init();

async function init() {
  await loadCatalogOverrides();
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
  refs.storeName.textContent = state.config.name || DATA.store.name || "Posto dos Componentes";
  document.title = state.config.name || "Posto dos Componentes";
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
  refs.productGrid.addEventListener("change", handleQuantityChange);

  refs.desktopCart.addEventListener("click", handleCartClick);
  refs.mobileCart.addEventListener("click", handleCartClick);
  refs.desktopCart.addEventListener("change", handleQuantityChange);
  refs.mobileCart.addEventListener("change", handleQuantityChange);

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
      name: refs.configStoreName.value.trim() || "Posto dos Componentes",
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
  refs.sellerDashboard.addEventListener("input", handleSellerDashboardInput);
  refs.sellerDashboard.addEventListener("change", handleSellerDashboardChange);

  refs.photoCropForm.addEventListener("submit", handlePhotoCropSubmit);
  refs.photoCropDialog.addEventListener("click", (event) => {
    if (event.target.closest("[data-photo-crop-cancel]")) cancelPhotoCrop();
  });
  refs.photoCropDialog.addEventListener("close", handlePhotoCropClose);
  refs.photoCropZoom.addEventListener("input", handlePhotoCropZoom);
  refs.photoCropCanvas.addEventListener("pointerdown", startPhotoCropDrag);
  refs.photoCropCanvas.addEventListener("pointermove", movePhotoCropDrag);
  refs.photoCropCanvas.addEventListener("pointerup", endPhotoCropDrag);
  refs.photoCropCanvas.addEventListener("pointercancel", endPhotoCropDrag);
}

async function loadCatalogOverrides() {
  try {
    const response = await apiRequest("/api/catalog-overrides");
    applyCatalogOverrides(response.overrides || []);
    rebuildCatalogIndexes();
  } catch {
    rebuildCatalogIndexes();
  }
}

function applyCatalogOverrides(overrides) {
  (overrides || []).forEach((override) => {
    if (override?.productId) state.catalogOverrides.set(override.productId, override);
  });

  DATA.products.forEach((product) => {
    product.active = product.baseActive;
    product.imageUrl = product.baseImageUrl || "";

    const override = state.catalogOverrides.get(product.id);
    if (!override) return;
    if (typeof override.active === "boolean") product.active = override.active;
    if (typeof override.imageUrl === "string") product.imageUrl = override.imageUrl;
  });
}

function rebuildCatalogIndexes() {
  activeProducts = DATA.products.filter((product) => product.active);
  productsById = new Map(DATA.products.map((product) => [product.id, product]));
  categoryCounts = activeProducts.reduce((map, product) => {
    map.set(product.type, (map.get(product.type) ?? 0) + 1);
    return map;
  }, new Map());
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
  const featuredPrice = featuredCatalogPrice(product);
  const priceNote = catalogPriceNote(product, featuredPrice);
  const minQty = getInitialQty(product);
  const photoUrl = getProductPhotoUrl(product);
  const actions = quantityInCart
    ? `
        <div class="card-cart-actions">
          <div class="qty-control">
            <button type="button" data-decrease="${escapeHtml(product.id)}" aria-label="Diminuir quantidade">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 11h14v2H5z" /></svg>
            </button>
            <input class="qty-input" type="number" inputmode="numeric" min="${minQty}" step="1" value="${quantityInCart}" data-set-qty="${escapeHtml(product.id)}" aria-label="Quantidade de ${escapeHtml(product.name)}" />
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
          <strong>${money.format(featuredPrice.price)}</strong>
          <span>${escapeHtml(featuredPrice.label)}</span>
        </div>
        <div class="tier-line">${escapeHtml(priceNote)}</div>
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

function featuredCatalogPrice(product) {
  const tiers = sortedPriceTiers(product);
  const fivePlusTier = tiers.find((tier) => tier.minQty === 5) || tiers.find((tier) => tier.minQty > 1);
  const fallbackPrice = product.price ?? tiers[0]?.price ?? 0;
  if (fivePlusTier) {
    return {
      minQty: fivePlusTier.minQty,
      price: fivePlusTier.price,
      label: `${fivePlusTier.minQty}+ pecas`,
    };
  }

  return {
    minQty: 1,
    price: fallbackPrice,
    label: "preco unitario",
  };
}

function catalogPriceNote(product, featuredPrice) {
  const tiers = sortedPriceTiers(product);
  const lowerTiers = tiers.filter((tier) => tier.minQty < featuredPrice.minQty);
  const lowerTier = lowerTiers[lowerTiers.length - 1];

  if (lowerTier && featuredPrice.minQty > 1) {
    return `Menos de ${featuredPrice.minQty} pecas: ${money.format(lowerTier.price)} cada`;
  }

  if (featuredPrice.minQty > 1) {
    return `Pedido minimo: ${featuredPrice.minQty} pecas`;
  }

  const otherTiers = tiers
    .filter((tier) => tier.minQty > featuredPrice.minQty)
    .map((tier) => `${tier.minQty}+ ${money.format(tier.price)}`);
  return otherTiers.length ? otherTiers.join("  |  ") : "Preco para qualquer quantidade";
}

function sortedPriceTiers(product) {
  return [...(product.tiers ?? [])]
    .map((tier) => ({
      minQty: Number(tier.minQty),
      price: Number(tier.price),
    }))
    .filter((tier) => Number.isFinite(tier.minQty) && tier.minQty > 0 && Number.isFinite(tier.price))
    .sort((a, b) => a.minQty - b.minQty);
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

function handleQuantityChange(event) {
  const input = event.target.closest("[data-set-qty]");
  if (!input) return;
  setProductQuantity(input.dataset.setQty, input.value);
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

function setProductQuantity(productId, value) {
  const product = productsById.get(productId);
  if (!product) return;

  const min = getInitialQty(product);
  const parsed = Number.parseInt(String(value), 10);
  state.cart[productId] = Number.isFinite(parsed) ? Math.max(parsed, min) : min;
  state.currentOrderCode = "";
  persistCart();
  renderProducts();
  renderCart();
}

function persistCart() {
  writeJson(KEYS.cart, state.cart);
  const itemCount = getCartItems().reduce((sum, item) => sum + item.qty, 0);
  refs.cartCount.textContent = itemCount;
  if (state.lastCartCount !== null && state.lastCartCount !== itemCount) {
    refs.openCartButton.classList.remove("is-bumping");
    window.requestAnimationFrame(() => refs.openCartButton.classList.add("is-bumping"));
  }
  state.lastCartCount = itemCount;
}

function getCartItems() {
  return Object.entries(state.cart)
    .map(([id, qty]) => {
      const product = productsById.get(id);
      if (!product || !product.active || !qty) return null;
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
              ${PAYMENT_OPTIONS
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
  const minQty = getInitialQty(item.product);

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
        <input class="qty-input" type="number" inputmode="numeric" min="${minQty}" step="1" value="${item.qty}" data-set-qty="${escapeHtml(item.product.id)}" aria-label="Quantidade de ${escapeHtml(item.product.name)}" />
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
      syncCheckoutForms(form);
      updateTotalsOnly();
    });
    form.addEventListener("change", () => {
      readCheckoutForm(form);
      writeJson(KEYS.checkout, state.checkout);
      syncCheckoutForms(form);
      updateTotalsOnly();
    });
  });
}

function persistCheckoutFromDom() {
  const focusedForm = document.activeElement?.closest?.("[data-checkout-form]");
  const mobileForm = refs.mobileCart.classList.contains("is-open")
    ? refs.mobileCart.querySelector("[data-checkout-form]")
    : null;
  const form = focusedForm || mobileForm || refs.desktopCart.querySelector("[data-checkout-form]");
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
    payment: PAYMENT_OPTIONS.includes(String(formData.get("payment"))) ? String(formData.get("payment")) : "Pix",
    notes: String(formData.get("notes") ?? ""),
  };
}

function syncCheckoutForms(sourceForm) {
  document.querySelectorAll("[data-checkout-form]").forEach((form) => {
    if (form === sourceForm) return;
    updateCheckoutFormValues(form);
  });
}

function updateCheckoutFormValues(form) {
  Object.entries(state.checkout).forEach(([name, value]) => {
    const field = form.elements.namedItem(name);
    if (field && field !== document.activeElement) field.value = value;
  });
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
  renderMobileOrderBar();
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

  if (button.dataset.adminView) {
    state.adminView = button.dataset.adminView;
    state.adminCatalogVisible = 60;
    await renderSellerDashboard(state.activeSellerOrderCode);
    return;
  }

  if (button.dataset.createOrderBackup) {
    await createOrderBackup();
    return;
  }

  if (button.dataset.downloadBackup) {
    await downloadRawFile(
      `/api/backups/${encodeURIComponent(button.dataset.downloadBackup)}/download?format=${button.dataset.format || "csv"}`,
      `backup-pedidos.${button.dataset.format || "csv"}`,
    );
    return;
  }

  if (button.dataset.exportOrders) {
    await downloadRawFile(
      `/api/orders/export?format=${button.dataset.format || "csv"}`,
      `todos-os-pedidos.${button.dataset.format || "csv"}`,
    );
    return;
  }

  if (button.dataset.loadAdminProducts) {
    state.adminCatalogVisible += 60;
    updateAdminCatalogList();
    return;
  }

  if (button.dataset.sellerPage) {
    state.sellerOrderPage = Math.max(1, Number(button.dataset.sellerPage) || 1);
    await renderSellerDashboard();
    return;
  }

  if (button.dataset.clearSellerSearch) {
    state.sellerOrderQuery = "";
    state.sellerOrderStatus = "all";
    state.sellerOrderPage = 1;
    await renderSellerDashboard();
    return;
  }

  if (button.dataset.adminToggleProduct) {
    await saveProductOverride(button.dataset.adminToggleProduct, {
      active: button.dataset.active === "true",
    });
    return;
  }

  if (button.dataset.adminSavePhoto) {
    const card = button.closest("[data-admin-product-card]");
    const input = card?.querySelector("[data-admin-photo-url]");
    await saveProductOverride(button.dataset.adminSavePhoto, {
      imageUrl: input?.value || "",
    });
    return;
  }

  if (button.dataset.adminClearPhoto) {
    await saveProductOverride(button.dataset.adminClearPhoto, { imageUrl: "" });
    return;
  }

  if (button.dataset.logout) {
    clearAuth();
    await renderSellerDashboard();
    return;
  }

  if (button.dataset.viewSellerOrder) {
    state.adminView = "orders";
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

function handleSellerDashboardInput(event) {
  const searchInput = event.target.closest("[data-admin-product-search]");
  if (!searchInput) return;
  state.adminCatalogQuery = searchInput.value;
  state.adminCatalogVisible = 60;
  updateAdminCatalogList();
}

async function handleSellerDashboardChange(event) {
  const orderStatusFilter = event.target.closest("[data-seller-status-filter]");
  if (orderStatusFilter) {
    state.sellerOrderStatus = orderStatusFilter.value;
    state.sellerOrderPage = 1;
    await renderSellerDashboard();
    return;
  }

  const orderStatusSelect = event.target.closest("[data-order-status]");
  if (orderStatusSelect) {
    await updateSellerOrderStatus(orderStatusSelect.dataset.orderStatusCode, orderStatusSelect.value);
    return;
  }

  const statusSelect = event.target.closest("[data-admin-product-status]");
  if (statusSelect) {
    state.adminCatalogStatus = statusSelect.value;
    state.adminCatalogVisible = 60;
    updateAdminCatalogList();
    return;
  }

  const fileInput = event.target.closest("[data-admin-photo-file]");
  if (fileInput?.files?.[0]) {
    try {
      const imageUrl = await openPhotoCropper(fileInput.files[0]);
      await saveProductOverride(fileInput.dataset.adminPhotoFile, { imageUrl });
    } catch (error) {
      if (!error.cancelled) showToast(error.message);
    } finally {
      fileInput.value = "";
    }
  }
}

async function handleSellerDashboardSubmit(event) {
  event.preventDefault();
  const form = event.target;

  if (form.matches("[data-seller-order-search-form]")) {
    const formData = new FormData(form);
    state.sellerOrderQuery = String(formData.get("query") || "").trim();
    state.sellerOrderPage = 1;
    await renderSellerDashboard();
    return;
  }

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
    const response = await apiRequest(`/api/orders?${sellerOrderQueryParams()}`);
    orders = response.orders || [];
    state.sellerPagination = {
      page: Number(response.page || state.sellerOrderPage || 1),
      limit: Number(response.limit || ORDER_PAGE_SIZE),
      total: Number(response.total || orders.length),
      totalPages: Number(response.totalPages || 1),
    };
    state.sellerOrderPage = state.sellerPagination.page;
    const adminCatalogMode = state.auth.user?.role === "admin" && state.adminView === "catalog";
    const adminBackupMode = state.auth.user?.role === "admin" && state.adminView === "backups";
    const selectedCode = adminCatalogMode || adminBackupMode ? "" : preferredCode || state.activeSellerOrderCode || orders[0]?.code || "";
    selectedOrder = selectedCode ? await fetchSellerOrder(selectedCode) : null;
    state.activeSellerOrderCode = selectedOrder?.code || "";

    if (state.auth.user?.role === "admin") {
      const usersResponse = await apiRequest("/api/users");
      state.sellerUsers = usersResponse.users || [];
      if (adminBackupMode) {
        const backupsResponse = await apiRequest("/api/backups");
        state.orderBackups = backupsResponse.backups || [];
      }
    }
  } catch (error) {
    clearAuth();
    renderSellerLogin(preferredCode, error.message);
    return;
  }

  const adminCatalogMode = state.auth.user?.role === "admin" && state.adminView === "catalog";
  const adminBackupMode = state.auth.user?.role === "admin" && state.adminView === "backups";
  const sellerList = `
    ${renderAdminPanel()}
    ${renderSellerOrderFilters()}
    ${
      orders.length
        ? `${orders.map((order) => renderSellerOrderCard(order, state.activeSellerOrderCode)).join("")}${renderSellerPagination()}`
        : `
            <div class="seller-empty">
              <strong>Nenhum pedido encontrado</strong>
              <span>Use outro nome, telefone, codigo ou status.</span>
            </div>
          `
    }
  `;
  refs.sellerOrders.innerHTML = adminBackupMode
    ? `${renderAdminPanel()}`
    : orders.length
    ? sellerList
    : `
        ${renderAdminPanel()}
        ${renderSellerOrderFilters()}
        <div class="seller-empty">
          <strong>Nenhum pedido encontrado</strong>
          <span>Quando chegar um WhatsApp do cliente, clique no link da vendedora dentro da mensagem.</span>
        </div>
      `;

  refs.sellerDetail.innerHTML = selectedOrder
    ? renderSellerOrderDetail(selectedOrder)
    : adminCatalogMode
      ? renderAdminCatalog()
    : adminBackupMode
      ? renderAdminBackups()
    : `
        <div class="seller-detail-card seller-empty">
          <strong>Aguardando pedido</strong>
          <span>Ao acessar pelo link do WhatsApp, a vendedora cai direto no pedido com itens, total e botao de Excel.</span>
        </div>
      `;

  if (adminCatalogMode) updateAdminCatalogList();
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

function sellerOrderQueryParams() {
  const params = new URLSearchParams({
    page: String(state.sellerOrderPage || 1),
    limit: String(ORDER_PAGE_SIZE),
  });
  if (state.sellerOrderQuery.trim()) params.set("q", state.sellerOrderQuery.trim());
  if (state.sellerOrderStatus !== "all") params.set("status", state.sellerOrderStatus);
  return params.toString();
}

function renderSellerOrderFilters() {
  const pagination = state.sellerPagination;
  const start = pagination.total ? (pagination.page - 1) * pagination.limit + 1 : 0;
  const end = Math.min(pagination.total, pagination.page * pagination.limit);
  return `
    <section class="seller-list-tools">
      <form class="seller-search-form" data-seller-order-search-form>
        <input name="query" type="search" value="${escapeHtml(state.sellerOrderQuery)}" placeholder="Buscar cliente, telefone ou pedido" />
        <button class="primary-button" type="submit">Buscar</button>
      </form>
      <label>Status
        <select data-seller-status-filter>
          <option value="all" ${state.sellerOrderStatus === "all" ? "selected" : ""}>Todos</option>
          ${ORDER_STATUSES.map((status) => `
            <option value="${status.value}" ${state.sellerOrderStatus === status.value ? "selected" : ""}>${status.label}</option>
          `).join("")}
        </select>
      </label>
      <div class="seller-list-summary">
        <span>${start}-${end} de ${pagination.total} pedidos</span>
        ${(state.sellerOrderQuery || state.sellerOrderStatus !== "all") ? `<button class="text-button" type="button" data-clear-seller-search="true">Limpar</button>` : ""}
      </div>
    </section>
  `;
}

function renderSellerPagination() {
  const pagination = state.sellerPagination;
  if (pagination.totalPages <= 1) return "";
  return `
    <nav class="seller-pagination" aria-label="Paginas de pedidos">
      <button class="primary-outline" type="button" data-seller-page="${pagination.page - 1}" ${pagination.page <= 1 ? "disabled" : ""}>Anterior</button>
      <span>Pagina ${pagination.page} de ${pagination.totalPages}</span>
      <button class="primary-outline" type="button" data-seller-page="${pagination.page + 1}" ${pagination.page >= pagination.totalPages ? "disabled" : ""}>Proxima</button>
    </nav>
  `;
}

function renderAdminPanel() {
  if (state.auth?.user?.role !== "admin") return "";
  const ordersActive = state.adminView === "orders" ? " is-active" : "";
  const catalogActive = state.adminView === "catalog" ? " is-active" : "";
  const backupsActive = state.adminView === "backups" ? " is-active" : "";
  return `
    <section class="seller-admin-panel">
      <div class="seller-admin-top">
        <strong>Administrador</strong>
        <button class="text-button" type="button" data-logout="true">Sair</button>
      </div>
      <div class="seller-admin-tabs">
        <button class="primary-outline${ordersActive}" type="button" data-admin-view="orders">Pedidos</button>
        <button class="primary-outline${catalogActive}" type="button" data-admin-view="catalog">Catalogo</button>
        <button class="primary-outline${backupsActive}" type="button" data-admin-view="backups">Backups</button>
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

function renderAdminCatalog() {
  const activeCount = DATA.products.filter((product) => product.active).length;
  return `
    <article class="seller-detail-card admin-catalog-panel">
      <div class="seller-detail-top">
        <div>
          <span>Catalogo</span>
          <h3>Itens e fotos</h3>
          <small>${activeCount} ativos de ${DATA.products.length} produtos</small>
        </div>
        <strong>${DATA.products.length}</strong>
      </div>

      <div class="admin-catalog-controls">
        <label>Buscar produto
          <input data-admin-product-search type="search" value="${escapeHtml(state.adminCatalogQuery)}" placeholder="Nome, codigo, marca ou categoria" />
        </label>
        <label>Status
          <select data-admin-product-status>
            <option value="all" ${state.adminCatalogStatus === "all" ? "selected" : ""}>Todos</option>
            <option value="active" ${state.adminCatalogStatus === "active" ? "selected" : ""}>Ativos</option>
            <option value="inactive" ${state.adminCatalogStatus === "inactive" ? "selected" : ""}>Inativos</option>
            <option value="with-photo" ${state.adminCatalogStatus === "with-photo" ? "selected" : ""}>Com foto</option>
            <option value="without-photo" ${state.adminCatalogStatus === "without-photo" ? "selected" : ""}>Sem foto</option>
          </select>
        </label>
      </div>

      <div class="admin-product-summary" data-admin-product-summary></div>
      <div class="admin-product-list" data-admin-product-results></div>
    </article>
  `;
}

function renderAdminBackups() {
  const backups = state.orderBackups || [];
  const lastBackup = backups[0];
  return `
    <article class="seller-detail-card admin-backup-panel">
      <div class="seller-detail-top">
        <div>
          <span>Backups</span>
          <h3>Exportacao diaria dos pedidos</h3>
          <small>${lastBackup ? `Ultimo backup: ${formatBackupDate(lastBackup.date)} - ${lastBackup.orderCount} pedidos` : "Nenhum backup gerado ainda"}</small>
        </div>
        <strong>${backups.length}</strong>
      </div>

      <div class="backup-actions">
        <button class="primary-button" type="button" data-create-order-backup="true">Gerar backup de hoje</button>
        <button class="primary-outline" type="button" data-export-orders="true" data-format="csv">Exportar todos CSV</button>
        <button class="primary-outline" type="button" data-export-orders="true" data-format="json">Exportar todos JSON</button>
      </div>

      <div class="backup-note">
        <strong>Rotina ativa</strong>
        <span>O sistema cria backup automatico todos os dias as 23:55 no horario de Sao Paulo. Se o servidor reiniciar, ele tambem confere o backup do dia anterior.</span>
      </div>

      <div class="backup-list">
        ${
          backups.length
            ? backups.map(renderBackupCard).join("")
            : `
                <div class="seller-empty">
                  <strong>Nenhum backup salvo</strong>
                  <span>Clique em gerar backup de hoje para criar o primeiro arquivo agora.</span>
                </div>
              `
        }
      </div>
    </article>
  `;
}

function renderBackupCard(backup) {
  return `
    <div class="backup-card">
      <div>
        <strong>${escapeHtml(formatBackupDate(backup.date))}</strong>
        <span>${Number(backup.orderCount || 0)} pedidos - ${money.format(Number(backup.totalValue || 0))}</span>
        <small>${escapeHtml(backup.source === "manual" ? "Gerado manualmente" : "Backup automatico")} - ${escapeHtml(formatOrderDate(backup.createdAt))}</small>
      </div>
      <div>
        <button class="primary-outline" type="button" data-download-backup="${escapeHtml(String(backup.id))}" data-format="csv">CSV</button>
        <button class="primary-outline" type="button" data-download-backup="${escapeHtml(String(backup.id))}" data-format="json">JSON</button>
      </div>
    </div>
  `;
}

function formatBackupDate(value) {
  const [year, month, day] = String(value || "").slice(0, 10).split("-");
  return year && month && day ? `${day}/${month}/${year}` : "Data indisponivel";
}

function updateAdminCatalogList() {
  const list = refs.sellerDetail.querySelector("[data-admin-product-results]");
  const summary = refs.sellerDetail.querySelector("[data-admin-product-summary]");
  if (!list || !summary) return;

  const products = getAdminProducts();
  const visible = products.slice(0, state.adminCatalogVisible);
  summary.innerHTML = `
    <strong>${products.length} produto${products.length === 1 ? "" : "s"} encontrado${products.length === 1 ? "" : "s"}</strong>
    <span>${DATA.products.filter((product) => product.active).length} ativos no catalogo do cliente</span>
  `;
  list.innerHTML = visible.length
    ? `
        ${visible.map(renderAdminProductCard).join("")}
        ${
          products.length > visible.length
            ? `<button class="primary-outline admin-load-more" type="button" data-load-admin-products="true">Carregar mais</button>`
            : ""
        }
      `
    : `
        <div class="seller-empty">
          <strong>Nenhum produto encontrado</strong>
          <span>Tente buscar por outro nome, codigo ou categoria.</span>
        </div>
      `;
}

function getAdminProducts() {
  const queryParts = normalize(state.adminCatalogQuery).split(/\s+/).filter(Boolean);
  return DATA.products.filter((product) => {
    const hasPhoto = Boolean(getProductPhotoUrl(product));
    if (state.adminCatalogStatus === "active" && !product.active) return false;
    if (state.adminCatalogStatus === "inactive" && product.active) return false;
    if (state.adminCatalogStatus === "with-photo" && !hasPhoto) return false;
    if (state.adminCatalogStatus === "without-photo" && hasPhoto) return false;
    if (!queryParts.length) return true;

    const haystack = normalize(`${product.id} ${product.name} ${product.brand} ${product.type} ${product.section}`);
    return queryParts.every((part) => haystack.includes(part));
  });
}

function renderAdminProductCard(product) {
  const photoUrl = getProductPhotoUrl(product);
  const nextActive = !product.active;
  return `
    <article class="admin-product-card" data-admin-product-card="${escapeHtml(product.id)}">
      <div class="admin-product-preview${photoUrl ? " has-photo" : ""}">
        ${
          photoUrl
            ? `<img src="${escapeHtml(photoUrl)}" alt="${escapeHtml(product.name)}" loading="lazy" />`
            : `<span>${escapeHtml(symbolFor(product.type))}</span>`
        }
      </div>
      <div class="admin-product-info">
        <div>
          <strong>${escapeHtml(product.name)}</strong>
          <small>${escapeHtml(product.id)} - ${escapeHtml(product.type)} - ${escapeHtml(product.brand || "GERAL")}</small>
        </div>
        <span class="admin-status ${product.active ? "is-active" : "is-inactive"}">
          ${product.active ? "Ativo no catalogo" : "Inativo"}
        </span>
      </div>
      <div class="admin-product-actions">
        <button class="${product.active ? "primary-outline" : "primary-button"}" type="button" data-admin-toggle-product="${escapeHtml(product.id)}" data-active="${String(nextActive)}">
          ${product.active ? "Desativar" : "Ativar"}
        </button>
        <label class="admin-file-button">
          Enviar foto
          <input type="file" accept="image/*" data-admin-photo-file="${escapeHtml(product.id)}" />
        </label>
        <input data-admin-photo-url="${escapeHtml(product.id)}" type="url" value="${escapeHtml(product.imageUrl || "")}" placeholder="Link da foto" />
        <button class="primary-outline" type="button" data-admin-save-photo="${escapeHtml(product.id)}">Salvar foto</button>
        <button class="text-button" type="button" data-admin-clear-photo="${escapeHtml(product.id)}">Remover foto</button>
      </div>
    </article>
  `;
}

async function saveProductOverride(productId, patch) {
  try {
    const response = await apiRequest(`/api/products/${encodeURIComponent(productId)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    applyCatalogOverrides([response.override]);
    rebuildCatalogIndexes();
    updateAdminCatalogList();
    showToast("Catalogo atualizado");
  } catch (error) {
    showToast(error.message);
  }
}

function openPhotoCropper(file) {
  if (!file.type.startsWith("image/")) {
    return Promise.reject(new Error("Escolha um arquivo de imagem"));
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Nao foi possivel ler a foto"));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error("Nao foi possivel abrir a foto"));
      image.onload = () => {
        Object.assign(photoCrop, {
          image,
          resolve,
          reject,
          done: false,
          dragging: false,
        });
        resetPhotoCropView();
        refs.photoCropDialog.showModal();
        drawPhotoCrop();
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function resetPhotoCropView() {
  const canvas = refs.photoCropCanvas;
  const image = photoCrop.image;
  const minScale = Math.max(canvas.width / image.width, canvas.height / image.height);
  photoCrop.minScale = minScale;
  photoCrop.scale = minScale;
  photoCrop.offsetX = (canvas.width - image.width * minScale) / 2;
  photoCrop.offsetY = (canvas.height - image.height * minScale) / 2;
  refs.photoCropZoom.value = "1";
}

function handlePhotoCropZoom(event) {
  if (!photoCrop.image) return;
  const oldScale = photoCrop.scale;
  const nextScale = photoCrop.minScale * Number(event.target.value || 1);
  const canvas = refs.photoCropCanvas;
  const centerX = canvas.width / 2;
  const centerY = canvas.height / 2;

  photoCrop.offsetX = centerX - ((centerX - photoCrop.offsetX) / oldScale) * nextScale;
  photoCrop.offsetY = centerY - ((centerY - photoCrop.offsetY) / oldScale) * nextScale;
  photoCrop.scale = nextScale;
  clampPhotoCrop();
  drawPhotoCrop();
}

function startPhotoCropDrag(event) {
  if (!photoCrop.image) return;
  photoCrop.dragging = true;
  photoCrop.startX = event.clientX;
  photoCrop.startY = event.clientY;
  photoCrop.baseOffsetX = photoCrop.offsetX;
  photoCrop.baseOffsetY = photoCrop.offsetY;
  refs.photoCropCanvas.setPointerCapture(event.pointerId);
}

function movePhotoCropDrag(event) {
  if (!photoCrop.dragging || !photoCrop.image) return;
  const ratio = canvasPointRatio();
  photoCrop.offsetX = photoCrop.baseOffsetX + (event.clientX - photoCrop.startX) * ratio;
  photoCrop.offsetY = photoCrop.baseOffsetY + (event.clientY - photoCrop.startY) * ratio;
  clampPhotoCrop();
  drawPhotoCrop();
}

function endPhotoCropDrag(event) {
  photoCrop.dragging = false;
  if (event && refs.photoCropCanvas.hasPointerCapture(event.pointerId)) {
    refs.photoCropCanvas.releasePointerCapture(event.pointerId);
  }
}

function canvasPointRatio() {
  const rect = refs.photoCropCanvas.getBoundingClientRect();
  return rect.width ? refs.photoCropCanvas.width / rect.width : 1;
}

function clampPhotoCrop() {
  const canvas = refs.photoCropCanvas;
  const image = photoCrop.image;
  const drawWidth = image.width * photoCrop.scale;
  const drawHeight = image.height * photoCrop.scale;
  photoCrop.offsetX = drawWidth <= canvas.width
    ? (canvas.width - drawWidth) / 2
    : Math.min(0, Math.max(canvas.width - drawWidth, photoCrop.offsetX));
  photoCrop.offsetY = drawHeight <= canvas.height
    ? (canvas.height - drawHeight) / 2
    : Math.min(0, Math.max(canvas.height - drawHeight, photoCrop.offsetY));
}

function drawPhotoCrop() {
  const canvas = refs.photoCropCanvas;
  const context = canvas.getContext("2d");
  context.fillStyle = "#fffaf0";
  context.fillRect(0, 0, canvas.width, canvas.height);
  if (!photoCrop.image) return;
  context.drawImage(
    photoCrop.image,
    photoCrop.offsetX,
    photoCrop.offsetY,
    photoCrop.image.width * photoCrop.scale,
    photoCrop.image.height * photoCrop.scale,
  );
}

function handlePhotoCropSubmit(event) {
  event.preventDefault();
  if (!photoCrop.image) return;
  photoCrop.done = true;
  const dataUrl = refs.photoCropCanvas.toDataURL("image/jpeg", 0.82);
  refs.photoCropDialog.close("save");
  photoCrop.resolve?.(dataUrl);
  clearPhotoCrop();
}

function cancelPhotoCrop() {
  if (!photoCrop.image) {
    refs.photoCropDialog.close("cancel");
    return;
  }
  photoCrop.done = true;
  const error = new Error("Recorte cancelado");
  error.cancelled = true;
  refs.photoCropDialog.close("cancel");
  photoCrop.reject?.(error);
  clearPhotoCrop();
}

function handlePhotoCropClose() {
  if (!photoCrop.image || photoCrop.done) return;
  const error = new Error("Recorte cancelado");
  error.cancelled = true;
  photoCrop.reject?.(error);
  clearPhotoCrop();
}

function clearPhotoCrop() {
  Object.assign(photoCrop, {
    image: null,
    resolve: null,
    reject: null,
    done: false,
    dragging: false,
  });
}

function renderSellerOrderCard(order, selectedCode) {
  const active = order.code === selectedCode ? " is-active" : "";
  return `
    <article class="seller-order-card${active}">
      <button type="button" data-view-seller-order="${escapeHtml(order.code)}">
        <strong>${escapeHtml(order.code)}</strong>
        <span>${escapeHtml(orderCustomerName(order))}</span>
        <small>${escapeHtml(formatOrderDate(order.createdAt || order.date))} - ${money.format(Number(order.total || 0))}</small>
        <em class="seller-status-pill status-${escapeHtml(order.status || "novo")}">${escapeHtml(orderStatusLabel(order.status))}</em>
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
        <label class="seller-status-control">Status
          <select data-order-status data-order-status-code="${escapeHtml(order.code)}">
            ${renderOrderStatusOptions(order.status)}
          </select>
        </label>
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

function renderOrderStatusOptions(currentStatus = "novo") {
  return ORDER_STATUSES.map((status) => `
    <option value="${status.value}" ${status.value === (currentStatus || "novo") ? "selected" : ""}>${status.label}</option>
  `).join("");
}

function orderStatusLabel(value = "novo") {
  return ORDER_STATUSES.find((status) => status.value === value)?.label || "Novo";
}

async function updateSellerOrderStatus(code, status) {
  try {
    await apiRequest(`/api/orders/${encodeURIComponent(code)}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
    showToast("Status atualizado");
    await renderSellerDashboard(code);
  } catch (error) {
    showToast(error.message);
  }
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
  const fileName = disposition.match(/filename="([^"]+)"/)?.[1] || `${safeFileName(code)}.xlsx`;
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

async function createOrderBackup() {
  await apiRequest("/api/backups/run", {
    method: "POST",
    body: JSON.stringify({}),
  });
  const response = await apiRequest("/api/backups");
  state.orderBackups = response.backups || [];
  await renderSellerDashboard();
  showToast("Backup de hoje atualizado");
}

async function downloadRawFile(path, fallbackName) {
  const response = await apiRequest(path, { raw: true });
  const blob = await response.blob();
  const disposition = response.headers.get("content-disposition") || "";
  const fileName = disposition.match(/filename="([^"]+)"/)?.[1] || fallbackName;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showToast("Arquivo gerado");
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
                <span>${escapeHtml(event.user?.name || "Sistema")} - ${escapeHtml(formatOrderDate(event.createdAt))}${eventDetailText(event)}</span>
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
    status_changed: "Status alterado",
  };
  return labels[type] || type;
}

function eventDetailText(event) {
  if (event.type !== "status_changed") return "";
  const from = orderStatusLabel(event.details?.from);
  const to = orderStatusLabel(event.details?.to);
  return ` - ${from} para ${to}`;
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

  const csv = buildQuoteCsv(normalizedOrder);
  const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${safeFileName(normalizedOrder.code)}-${safeFileName(normalizedOrder.customerName || "CLIENTE")}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showToast("Orcamento gerado para abrir no celular");
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
    checkout: order.checkout || state.checkout,
    items: currentItems,
    subtotal,
    deliveryFee,
    total: order.total ?? subtotal + deliveryFee,
  };
}

function buildQuoteCsv(order) {
  const checkout = order.checkout || {};
  const modeLabel = checkout.mode === "entrega" ? "Entrega" : "Retirada";
  const rows = [
    [`Cliente: ${order.customerName}`],
    [`${order.code} | Telefone: ${checkout.phone || "Nao informado"}`],
    [`Tipo: ${modeLabel} | Pagamento: ${checkout.payment || "Nao informado"}`],
  ];

  if (checkout.address) rows.push([`Endereco: ${checkout.address}`]);
  if (checkout.notes) rows.push([`Observacao: ${checkout.notes}`]);

  rows.push(
    [],
    ["Item", "Valor unitario", "Valor total do item"],
    ...order.items.map((item) => [
      `${item.qty}x ${item.name}`,
      csvAmount(item.unitPrice),
      csvAmount(item.lineTotal),
    ]),
  );

  if (order.deliveryFee) rows.push(["Taxa de entrega", "", csvAmount(order.deliveryFee)]);
  rows.push(["Total do orcamento", "", csvAmount(order.total)]);
  return rows.map((row) => row.map(csvCell).join(";")).join("\r\n");
}

function csvAmount(value) {
  return Number(value || 0).toFixed(2).replace(".", ",");
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
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
