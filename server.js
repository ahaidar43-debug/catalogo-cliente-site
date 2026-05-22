import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 5173);
const SESSION_SECRET = process.env.SESSION_SECRET || "local-dev-secret-change-on-render";
const TOKEN_DAYS = Number(process.env.TOKEN_DAYS || 7);
const DATA_FILE = process.env.LOCAL_DATA_FILE || path.join(__dirname, "data", "local-db.json");
const hasPostgres = Boolean(process.env.DATABASE_URL);
const ORDER_STATUSES = ["novo", "visualizado", "baixado", "cobrado", "pago", "cancelado"];
const DEFAULT_ORDER_STATUS = ORDER_STATUSES[0];
const CRC32_TABLE = buildCrc32Table();
const fallbackPasswordHashes = {
  admin: "$2a$10$RKrwqOK9KXX0JNJzjSUkuuftpxRIAx5S29SjpKrkOnVhIVsSbHkvS",
  vendedora: "$2a$10$Nl3vKELNCuwmNkrbZku.AuW7OfYXr0BZ7Rij2A4ocGL7WOcTOmTxq",
};

const pool = hasPostgres
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
    })
  : null;

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "8mb" }));

await ensureStore();

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, storage: hasPostgres ? "postgres" : "file" });
});

app.post("/api/auth/login", async (req, res) => {
  const username = cleanText(req.body?.username).toLowerCase();
  const password = String(req.body?.password || "");
  const user = username ? await findUserByUsername(username) : null;

  const validPassword = user
    && user.active
    && (
      (await bcrypt.compare(password, user.password_hash))
      || (fallbackPasswordHashes[username] && await bcrypt.compare(password, fallbackPasswordHashes[username]))
    );

  if (!validPassword) {
    res.status(401).json({ error: "Login ou senha incorretos" });
    return;
  }

  res.json({
    token: signSession(user),
    user: publicUser(user),
  });
});

app.get("/api/auth/me", requireAuth(), (req, res) => {
  res.json({ user: publicUser(req.user) });
});

app.get("/api/users", requireAuth(["admin"]), async (_req, res) => {
  res.json({ users: (await listUsers()).map(publicUser) });
});

app.post("/api/users", requireAuth(["admin"]), async (req, res) => {
  const name = cleanText(req.body?.name);
  const username = cleanText(req.body?.username).toLowerCase();
  const role = req.body?.role === "admin" ? "admin" : "seller";
  const password = String(req.body?.password || "");

  if (!name || !username || password.length < 6) {
    res.status(400).json({ error: "Informe nome, login e senha com pelo menos 6 caracteres" });
    return;
  }

  try {
    const user = await createUser({ name, username, role, password });
    res.status(201).json({ user: publicUser(user) });
  } catch (error) {
    if (String(error.message).includes("duplicate")) {
      res.status(409).json({ error: "Esse login ja existe" });
      return;
    }
    throw error;
  }
});

app.get("/api/catalog-overrides", async (_req, res) => {
  res.json({ overrides: await listProductOverrides() });
});

app.patch("/api/products/:id", requireAuth(["admin"]), async (req, res) => {
  let imageUrl;
  try {
    imageUrl = Object.hasOwn(req.body || {}, "imageUrl") ? cleanImageUrl(req.body.imageUrl) : undefined;
  } catch {
    res.status(400).json({ error: "Use um link http/https ou uma imagem valida" });
    return;
  }

  const active = typeof req.body?.active === "boolean" ? req.body.active : undefined;
  if (active === undefined && imageUrl === undefined) {
    res.status(400).json({ error: "Informe o que deseja alterar no item" });
    return;
  }

  const override = await upsertProductOverride(req.params.id, { active, imageUrl }, req.user.id);
  res.json({ override });
});

app.post("/api/orders", async (req, res) => {
  const orderInput = normalizeIncomingOrder(req.body || {});
  if (!orderInput.code || !orderInput.items.length) {
    res.status(400).json({ error: "Pedido sem codigo ou sem itens" });
    return;
  }

  const order = await upsertOrder(orderInput, publicBaseUrl(req));
  await logOrderEvent(order.id, null, "created", { source: "catalog" });
  res.status(201).json({ order: orderForApi(order), sellerUrl: order.seller_url });
});

app.get("/api/orders", requireAuth(["admin", "seller"]), async (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
  const query = cleanText(req.query.q).slice(0, 120);
  const status = cleanOrderStatus(req.query.status, "");
  const result = await listOrders({ page, limit, query, status });
  res.json({
    ...result,
    orders: result.orders.map(orderSummaryForApi),
  });
});

app.get("/api/orders/:code", requireAuth(["admin", "seller"]), async (req, res) => {
  let order = await findOrderByCode(req.params.code);
  if (!order) {
    res.status(404).json({ error: "Pedido nao encontrado" });
    return;
  }

  await logOrderEvent(order.id, req.user.id, "viewed", {
    via: req.query.token ? "whatsapp-link" : "dashboard",
  });
  if ((order.status || DEFAULT_ORDER_STATUS) === "novo") {
    order = await updateOrderStatus(order.id, "visualizado", req.user.id, { automatic: true }) || order;
  }

  const events = req.user.role === "admin" ? await listOrderEvents(order.id) : [];
  res.json({ order: orderForApi(order), events });
});

app.patch("/api/orders/:code/status", requireAuth(["admin", "seller"]), async (req, res) => {
  const status = cleanOrderStatus(req.body?.status);
  if (!status) {
    res.status(400).json({ error: "Status do pedido invalido" });
    return;
  }

  const order = await findOrderByCode(req.params.code);
  if (!order) {
    res.status(404).json({ error: "Pedido nao encontrado" });
    return;
  }

  const updatedOrder = await updateOrderStatus(order.id, status, req.user.id, { manual: true });
  res.json({ order: orderForApi(updatedOrder || order) });
});

app.get("/api/orders/:code/events", requireAuth(["admin"]), async (req, res) => {
  const order = await findOrderByCode(req.params.code);
  if (!order) {
    res.status(404).json({ error: "Pedido nao encontrado" });
    return;
  }
  res.json({ events: await listOrderEvents(order.id) });
});

app.get("/api/orders/:code/download", requireAuth(["admin", "seller"]), async (req, res) => {
  let order = await findOrderByCode(req.params.code);
  if (!order) {
    res.status(404).json({ error: "Pedido nao encontrado" });
    return;
  }

  await logOrderEvent(order.id, req.user.id, "downloaded", { format: "xlsx" });
  if (["novo", "visualizado"].includes(order.status || DEFAULT_ORDER_STATUS)) {
    order = await updateOrderStatus(order.id, "baixado", req.user.id, { automatic: true, format: "xlsx" }) || order;
  }
  const workbook = buildQuoteWorkbook(order);
  const fileName = `${safeFileName(order.code)}-${safeFileName(order.customer_name || "CLIENTE")}.xlsx`;
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  res.send(workbook);
});

app.use(express.static(__dirname));
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Catalogo rodando em http://0.0.0.0:${PORT}`);
});

async function ensureStore() {
  if (hasPostgres) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'seller')),
        active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        code TEXT UNIQUE NOT NULL,
        share_token TEXT UNIQUE NOT NULL,
        seller_url TEXT NOT NULL,
        customer_name TEXT NOT NULL,
        customer_phone TEXT,
        checkout JSONB NOT NULL,
        store JSONB NOT NULL,
        items JSONB NOT NULL,
        subtotal NUMERIC(12,2) NOT NULL DEFAULT 0,
        delivery_fee NUMERIC(12,2) NOT NULL DEFAULT 0,
        total NUMERIC(12,2) NOT NULL DEFAULT 0,
        item_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'novo',
        text TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS order_events (
        id SERIAL PRIMARY KEY,
        order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        event_type TEXT NOT NULL,
        details JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS product_overrides (
        id SERIAL PRIMARY KEY,
        product_id TEXT UNIQUE NOT NULL,
        active BOOLEAN,
        image_url TEXT NOT NULL DEFAULT '',
        updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'novo';
      CREATE INDEX IF NOT EXISTS orders_created_at_idx ON orders (created_at DESC);
      CREATE INDEX IF NOT EXISTS orders_status_created_at_idx ON orders (status, created_at DESC);
      CREATE INDEX IF NOT EXISTS orders_customer_name_idx ON orders (LOWER(customer_name));
      CREATE INDEX IF NOT EXISTS orders_customer_phone_idx ON orders (customer_phone);
    `);
  } else {
    await loadFileStore();
  }

  await seedDefaultUsers();
}

async function seedDefaultUsers() {
  await ensureDefaultUser({
    name: process.env.ADMIN_NAME || "Administrador",
    username: (process.env.ADMIN_USERNAME || "admin").toLowerCase(),
    password: process.env.ADMIN_PASSWORD || "admin123",
    role: "admin",
  });

  await ensureDefaultUser({
    name: process.env.SELLER_NAME || "Vendedora",
    username: (process.env.SELLER_USERNAME || "vendedora").toLowerCase(),
    password: process.env.SELLER_PASSWORD || "vendedora123",
    role: "seller",
  });
}

async function ensureDefaultUser({ name, username, password, role }) {
  const existing = await findUserByUsername(username);
  if (!existing) {
    return createUser({ name, username, password, role });
  }

  if (!process.env.UPDATE_DEFAULT_PASSWORDS) return existing;

  const passwordHash = await bcrypt.hash(password, 10);
  if (hasPostgres) {
    const result = await pool.query(
      `UPDATE users
       SET name = $1, password_hash = $2, role = $3, active = TRUE
       WHERE username = $4
       RETURNING *`,
      [name, passwordHash, role, username],
    );
    return result.rows[0];
  }

  const store = await loadFileStore();
  const user = store.users.find((item) => item.username === username);
  Object.assign(user, { name, password_hash: passwordHash, role, active: true });
  await saveFileStore(store);
  return user;
}

async function createUser({ name, username, password, role }) {
  const passwordHash = await bcrypt.hash(password, 10);
  if (hasPostgres) {
    const result = await pool.query(
      `INSERT INTO users (name, username, password_hash, role)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [name, username, passwordHash, role],
    );
    return result.rows[0];
  }

  const store = await loadFileStore();
  if (store.users.some((user) => user.username === username)) {
    throw new Error("duplicate username");
  }
  const user = {
    id: store.nextUserId++,
    name,
    username,
    password_hash: passwordHash,
    role,
    active: true,
    created_at: new Date().toISOString(),
  };
  store.users.push(user);
  await saveFileStore(store);
  return user;
}

async function listUsers() {
  if (hasPostgres) {
    const result = await pool.query("SELECT * FROM users ORDER BY created_at ASC");
    return result.rows;
  }
  return (await loadFileStore()).users;
}

async function findUserByUsername(username) {
  if (hasPostgres) {
    const result = await pool.query("SELECT * FROM users WHERE username = $1", [username]);
    return result.rows[0] || null;
  }
  return (await loadFileStore()).users.find((user) => user.username === username) || null;
}

async function findUserById(id) {
  if (hasPostgres) {
    const result = await pool.query("SELECT * FROM users WHERE id = $1", [id]);
    return result.rows[0] || null;
  }
  return (await loadFileStore()).users.find((user) => Number(user.id) === Number(id)) || null;
}

async function listProductOverrides() {
  if (hasPostgres) {
    const result = await pool.query(
      `SELECT product_id, active, image_url, updated_at
       FROM product_overrides
       ORDER BY updated_at DESC`,
    );
    return result.rows.map(productOverrideForApi);
  }

  const store = await loadFileStore();
  return store.productOverrides.map(productOverrideForApi);
}

async function findProductOverride(productId) {
  if (hasPostgres) {
    const result = await pool.query("SELECT * FROM product_overrides WHERE product_id = $1", [productId]);
    return result.rows[0] || null;
  }

  const store = await loadFileStore();
  return store.productOverrides.find((item) => item.product_id === productId) || null;
}

async function upsertProductOverride(productId, patch, userId) {
  const cleanProductId = cleanText(productId).slice(0, 120);
  const existing = await findProductOverride(cleanProductId);
  const next = {
    product_id: cleanProductId,
    active: patch.active === undefined ? existing?.active ?? null : patch.active,
    image_url: patch.imageUrl === undefined ? existing?.image_url ?? "" : patch.imageUrl,
  };

  if (hasPostgres) {
    const result = await pool.query(
      `INSERT INTO product_overrides (product_id, active, image_url, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (product_id) DO UPDATE SET
        active = EXCLUDED.active,
        image_url = EXCLUDED.image_url,
        updated_by = EXCLUDED.updated_by,
        updated_at = NOW()
       RETURNING product_id, active, image_url, updated_at`,
      [next.product_id, next.active, next.image_url, userId],
    );
    return productOverrideForApi(result.rows[0]);
  }

  const store = await loadFileStore();
  const updated = {
    ...next,
    updated_by: userId,
    updated_at: new Date().toISOString(),
  };
  store.productOverrides = [
    updated,
    ...store.productOverrides.filter((item) => item.product_id !== cleanProductId),
  ];
  await saveFileStore(store);
  return productOverrideForApi(updated);
}

async function upsertOrder(input, baseUrl) {
  const existing = await findOrderByCode(input.code);
  const shareToken = existing?.share_token || crypto.randomBytes(18).toString("base64url");
  const sellerUrl = `${baseUrl}/?dono=1&pedido=${encodeURIComponent(input.code)}&token=${shareToken}`;
  const values = [
    input.code,
    shareToken,
    sellerUrl,
    input.checkout.name || "Cliente",
    input.checkout.phone || "",
    input.checkout,
    input.store,
    input.items,
    input.subtotal,
    input.deliveryFee,
    input.total,
    input.itemCount,
    input.text,
  ];

  if (hasPostgres) {
    const result = await pool.query(
      `INSERT INTO orders (
        code, share_token, seller_url, customer_name, customer_phone, checkout, store, items,
        subtotal, delivery_fee, total, item_count, text
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, $11, $12, $13)
      ON CONFLICT (code) DO UPDATE SET
        seller_url = EXCLUDED.seller_url,
        customer_name = EXCLUDED.customer_name,
        customer_phone = EXCLUDED.customer_phone,
        checkout = EXCLUDED.checkout,
        store = EXCLUDED.store,
        items = EXCLUDED.items,
        subtotal = EXCLUDED.subtotal,
        delivery_fee = EXCLUDED.delivery_fee,
        total = EXCLUDED.total,
        item_count = EXCLUDED.item_count,
        text = EXCLUDED.text,
        updated_at = NOW()
      RETURNING *`,
      values.map((value) => (typeof value === "object" ? JSON.stringify(value) : value)),
    );
    return result.rows[0];
  }

  const store = await loadFileStore();
  const order = {
    id: existing?.id || store.nextOrderId++,
    code: input.code,
    share_token: shareToken,
    seller_url: sellerUrl,
    customer_name: input.checkout.name || "Cliente",
    customer_phone: input.checkout.phone || "",
    checkout: input.checkout,
    store: input.store,
    items: input.items,
    subtotal: input.subtotal,
    delivery_fee: input.deliveryFee,
    total: input.total,
    item_count: input.itemCount,
    text: input.text,
    status: existing?.status || DEFAULT_ORDER_STATUS,
    created_at: existing?.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  store.orders = [order, ...store.orders.filter((item) => item.code !== order.code)];
  await saveFileStore(store);
  return order;
}

async function listOrders({ page = 1, limit = 50, query = "", status = "" } = {}) {
  const offset = (page - 1) * limit;
  if (hasPostgres) {
    const filters = [];
    const values = [];

    if (query) {
      values.push(`%${query}%`);
      const index = values.length;
      filters.push(`(code ILIKE $${index} OR customer_name ILIKE $${index} OR customer_phone ILIKE $${index})`);
    }

    if (status) {
      values.push(status);
      filters.push(`status = $${values.length}`);
    }

    const whereSql = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const countResult = await pool.query(`SELECT COUNT(*)::int AS total FROM orders ${whereSql}`, values);
    const total = Number(countResult.rows[0]?.total || 0);
    const pageValues = [...values, limit, offset];
    const result = await pool.query(
      `SELECT * FROM orders
       ${whereSql}
       ORDER BY created_at DESC
       LIMIT $${pageValues.length - 1}
       OFFSET $${pageValues.length}`,
      pageValues,
    );
    return paginatedOrders(result.rows, { page, limit, total });
  }

  let orders = (await loadFileStore()).orders;
  if (query) {
    const needle = normalizeSearch(query);
    orders = orders.filter((order) => normalizeSearch(`${order.code} ${order.customer_name} ${order.customer_phone}`).includes(needle));
  }
  if (status) orders = orders.filter((order) => (order.status || DEFAULT_ORDER_STATUS) === status);
  orders = orders.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return paginatedOrders(orders.slice(offset, offset + limit), { page, limit, total: orders.length });
}

async function findOrderByCode(code) {
  if (hasPostgres) {
    const result = await pool.query("SELECT * FROM orders WHERE code = $1", [code]);
    return result.rows[0] || null;
  }
  return (await loadFileStore()).orders.find((order) => order.code === code) || null;
}

async function logOrderEvent(orderId, userId, eventType, details = {}) {
  if (hasPostgres) {
    await pool.query(
      "INSERT INTO order_events (order_id, user_id, event_type, details) VALUES ($1, $2, $3, $4::jsonb)",
      [orderId, userId, eventType, JSON.stringify(details)],
    );
    return;
  }

  const store = await loadFileStore();
  store.events.push({
    id: store.nextEventId++,
    order_id: orderId,
    user_id: userId,
    event_type: eventType,
    details,
    created_at: new Date().toISOString(),
  });
  await saveFileStore(store);
}

async function updateOrderStatus(orderId, status, userId, details = {}) {
  const cleanStatus = cleanOrderStatus(status);
  if (!cleanStatus) return null;
  const existing = await findOrderById(orderId);
  if (!existing) return null;
  const previousStatus = existing.status || DEFAULT_ORDER_STATUS;

  if (hasPostgres) {
    const result = await pool.query(
      `UPDATE orders
       SET status = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [cleanStatus, orderId],
    );
    if (previousStatus !== cleanStatus) {
      await logOrderEvent(orderId, userId, "status_changed", {
        ...details,
        from: previousStatus,
        to: cleanStatus,
      });
    }
    return result.rows[0] || null;
  }

  const store = await loadFileStore();
  const order = store.orders.find((item) => Number(item.id) === Number(orderId));
  if (!order) return null;
  order.status = cleanStatus;
  order.updated_at = new Date().toISOString();
  await saveFileStore(store);
  if (previousStatus !== cleanStatus) {
    await logOrderEvent(orderId, userId, "status_changed", {
      ...details,
      from: previousStatus,
      to: cleanStatus,
    });
  }
  return order;
}

async function findOrderById(id) {
  if (hasPostgres) {
    const result = await pool.query("SELECT * FROM orders WHERE id = $1", [id]);
    return result.rows[0] || null;
  }
  return (await loadFileStore()).orders.find((order) => Number(order.id) === Number(id)) || null;
}

async function listOrderEvents(orderId) {
  if (hasPostgres) {
    const result = await pool.query(
      `SELECT e.*, u.name AS user_name, u.username, u.role
       FROM order_events e
       LEFT JOIN users u ON u.id = e.user_id
       WHERE e.order_id = $1
       ORDER BY e.created_at DESC`,
      [orderId],
    );
    return result.rows.map(eventForApi);
  }

  const store = await loadFileStore();
  return store.events
    .filter((event) => Number(event.order_id) === Number(orderId))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .map((event) => {
      const user = store.users.find((item) => Number(item.id) === Number(event.user_id));
      return eventForApi({ ...event, user_name: user?.name, username: user?.username, role: user?.role });
    });
}

function requireAuth(roles = []) {
  return async (req, res, next) => {
    try {
      const token = String(req.get("authorization") || "").replace(/^Bearer\s+/i, "");
      const payload = verifySession(token);
      const user = payload ? await findUserById(payload.id) : null;
      if (!user || !user.active) {
        res.status(401).json({ error: "Entre com login e senha" });
        return;
      }
      if (roles.length && !roles.includes(user.role)) {
        res.status(403).json({ error: "Acesso permitido apenas para administrador" });
        return;
      }
      req.user = user;
      next();
    } catch (error) {
      next(error);
    }
  };
}

function signSession(user) {
  const payload = {
    id: user.id,
    username: user.username,
    role: user.role,
    exp: Date.now() + TOKEN_DAYS * 24 * 60 * 60 * 1000,
  };
  const encoded = base64url(JSON.stringify(payload));
  const signature = crypto.createHmac("sha256", SESSION_SECRET).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function verifySession(token) {
  if (!token || !token.includes(".")) return null;
  const [encoded, signature] = token.split(".");
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(encoded).digest("base64url");
  if (Buffer.byteLength(signature) !== Buffer.byteLength(expected)) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  if (Date.now() > Number(payload.exp || 0)) return null;
  return payload;
}

function normalizeIncomingOrder(body) {
  const checkout = body.customer || body.checkout || {};
  const items = Array.isArray(body.items) ? body.items.map(normalizeItem).filter((item) => item.qty > 0) : [];
  const subtotal = numberOrZero(body.subtotal ?? items.reduce((sum, item) => sum + item.lineTotal, 0));
  const deliveryFee = numberOrZero(body.deliveryFee ?? body.delivery_fee);
  const total = numberOrZero(body.total ?? subtotal + deliveryFee);
  return {
    code: cleanText(body.code).slice(0, 80),
    checkout: {
      name: cleanText(checkout.name),
      phone: cleanText(checkout.phone),
      mode: cleanText(checkout.mode || "retirada"),
      address: cleanText(checkout.address),
      payment: cleanText(checkout.payment),
      notes: cleanText(checkout.notes),
    },
    store: body.store && typeof body.store === "object" ? body.store : {},
    items,
    subtotal,
    deliveryFee,
    total,
    itemCount: numberOrZero(body.itemCount ?? items.reduce((sum, item) => sum + item.qty, 0)),
    text: String(body.text || ""),
  };
}

function normalizeItem(item) {
  return {
    id: cleanText(item.id),
    name: cleanText(item.name),
    qty: numberOrZero(item.qty),
    unitPrice: numberOrZero(item.unitPrice ?? item.unit_price),
    lineTotal: numberOrZero(item.lineTotal ?? item.line_total),
    tierLabel: cleanText(item.tierLabel ?? item.tier_label),
  };
}

function orderForApi(order) {
  return {
    id: order.id,
    code: order.code,
    status: order.status || DEFAULT_ORDER_STATUS,
    sellerUrl: order.seller_url,
    customer: order.customer_name,
    checkout: parseJsonValue(order.checkout),
    store: parseJsonValue(order.store),
    items: parseJsonValue(order.items),
    subtotal: Number(order.subtotal || 0),
    deliveryFee: Number(order.delivery_fee || 0),
    total: Number(order.total || 0),
    itemCount: Number(order.item_count || 0),
    text: order.text || "",
    createdAt: order.created_at,
    updatedAt: order.updated_at,
  };
}

function orderSummaryForApi(order) {
  return {
    code: order.code,
    status: order.status || DEFAULT_ORDER_STATUS,
    customer: order.customer_name,
    phone: order.customer_phone,
    total: Number(order.total || 0),
    itemCount: Number(order.item_count || 0),
    createdAt: order.created_at,
  };
}

function eventForApi(event) {
  return {
    id: event.id,
    type: event.event_type,
    details: parseJsonValue(event.details),
    createdAt: event.created_at,
    user: event.user_id
      ? {
          id: event.user_id,
          name: event.user_name || "Usuario",
          username: event.username || "",
          role: event.role || "",
        }
      : null,
  };
}

function productOverrideForApi(override) {
  return {
    productId: override.product_id,
    active: typeof override.active === "boolean" ? override.active : override.active ?? null,
    imageUrl: override.image_url || "",
    updatedAt: override.updated_at,
  };
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    role: user.role,
    active: user.active,
  };
}

function publicBaseUrl(req) {
  return process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
}

function buildQuoteWorkbook(order) {
  const entries = [
    { name: "[Content_Types].xml", data: xlsxContentTypesXml() },
    { name: "_rels/.rels", data: xlsxRootRelsXml() },
    { name: "xl/workbook.xml", data: xlsxWorkbookXml() },
    { name: "xl/_rels/workbook.xml.rels", data: xlsxWorkbookRelsXml() },
    { name: "xl/styles.xml", data: xlsxStylesXml() },
    { name: "xl/worksheets/sheet1.xml", data: buildQuoteWorksheetXml(order) },
  ];
  return createZip(entries);
}

function buildQuoteWorksheetXml(order) {
  const checkout = parseJsonValue(order.checkout);
  const parsedItems = parseJsonValue(order.items);
  const items = Array.isArray(parsedItems) ? parsedItems : [];
  const modeLabel = checkout.mode === "entrega" ? "Entrega" : "Retirada";
  const rows = [
    { merge: true, cells: [{ value: `Cliente: ${order.customer_name || checkout.name || "Cliente"}`, style: 1 }] },
    { merge: true, cells: [{ value: `${order.code} | Telefone: ${checkout.phone || "Nao informado"}`, style: 1 }] },
    { merge: true, cells: [{ value: `Tipo: ${modeLabel} | Pagamento: ${checkout.payment || "Nao informado"}` }] },
  ];

  if (checkout.address) rows.push({ merge: true, cells: [{ value: `Endereco: ${checkout.address}` }] });
  if (checkout.notes) rows.push({ merge: true, cells: [{ value: `Observacao: ${checkout.notes}` }] });

  rows.push(
    { cells: [] },
    {
      cells: [
        { value: "Item", style: 2 },
        { value: "Valor unitario", style: 2 },
        { value: "Valor total do item", style: 2 },
      ],
    },
  );

  items.forEach((item) => {
    rows.push({
      cells: [
        { value: `${item.qty}x ${item.name}`, style: 4 },
        { value: Number(item.unitPrice || 0), type: "number", style: 3 },
        { value: Number(item.lineTotal || 0), type: "number", style: 3 },
      ],
    });
  });

  if (Number(order.delivery_fee || 0)) {
    rows.push({
      cells: [
        { value: "Taxa de entrega", style: 4 },
        { value: "", style: 4 },
        { value: Number(order.delivery_fee || 0), type: "number", style: 3 },
      ],
    });
  }

  rows.push({
    cells: [
      { value: "Total do orcamento", style: 5 },
      { value: "", style: 5 },
      { value: Number(order.total || 0), type: "number", style: 6 },
    ],
  });

  return buildWorksheetXml(rows);
}

function buildWorksheetXml(rows) {
  const sheetRows = rows.map((row, index) => {
    const rowNumber = index + 1;
    const cells = (row.cells || []).map((cell, cellIndex) => buildCellXml(cell, cellIndex, rowNumber)).join("");
    return `<row r="${rowNumber}">${cells}</row>`;
  }).join("");
  const merges = rows
    .map((row, index) => row.merge ? `<mergeCell ref="A${index + 1}:C${index + 1}"/>` : "")
    .filter(Boolean);

  return `
    <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
      xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      <dimension ref="A1:C${rows.length}"/>
      <cols>
        <col min="1" max="1" width="55" customWidth="1"/>
        <col min="2" max="3" width="18" customWidth="1"/>
      </cols>
      <sheetData>${sheetRows}</sheetData>
      ${merges.length ? `<mergeCells count="${merges.length}">${merges.join("")}</mergeCells>` : ""}
    </worksheet>
  `;
}

function buildCellXml(cell, columnIndex, rowNumber) {
  const ref = `${String.fromCharCode(65 + columnIndex)}${rowNumber}`;
  const style = Number.isInteger(cell.style) ? ` s="${cell.style}"` : "";
  if (cell.type === "number") {
    const value = Number(cell.value);
    return `<c r="${ref}"${style}><v>${Number.isFinite(value) ? value : 0}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr"${style}><is><t>${escapeXml(cell.value)}</t></is></c>`;
}

function xlsxContentTypesXml() {
  return `
    <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
      <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
      <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
    </Types>
  `;
}

function xlsxRootRelsXml() {
  return `
    <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
    </Relationships>
  `;
}

function xlsxWorkbookXml() {
  return `
    <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
      xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      <sheets>
        <sheet name="Orcamento" sheetId="1" r:id="rId1"/>
      </sheets>
    </workbook>
  `;
}

function xlsxWorkbookRelsXml() {
  return `
    <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
      <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
    </Relationships>
  `;
}

function xlsxStylesXml() {
  return `
    <?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
      <numFmts count="1">
        <numFmt numFmtId="164" formatCode="&quot;R$&quot; #,##0.00"/>
      </numFmts>
      <fonts count="2">
        <font><sz val="11"/><name val="Calibri"/></font>
        <font><b/><sz val="11"/><name val="Calibri"/></font>
      </fonts>
      <fills count="4">
        <fill><patternFill patternType="none"/></fill>
        <fill><patternFill patternType="gray125"/></fill>
        <fill><patternFill patternType="solid"><fgColor rgb="FFEAF2ED"/><bgColor indexed="64"/></patternFill></fill>
        <fill><patternFill patternType="solid"><fgColor rgb="FFF5F7F6"/><bgColor indexed="64"/></patternFill></fill>
      </fills>
      <borders count="2">
        <border><left/><right/><top/><bottom/><diagonal/></border>
        <border>
          <left style="thin"><color rgb="FFD9D9D9"/></left>
          <right style="thin"><color rgb="FFD9D9D9"/></right>
          <top style="thin"><color rgb="FFD9D9D9"/></top>
          <bottom style="thin"><color rgb="FFD9D9D9"/></bottom>
          <diagonal/>
        </border>
      </borders>
      <cellStyleXfs count="1">
        <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
      </cellStyleXfs>
      <cellXfs count="7">
        <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
        <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
        <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
        <xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
        <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>
        <xf numFmtId="0" fontId="1" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
        <xf numFmtId="164" fontId="1" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
      </cellXfs>
      <cellStyles count="1">
        <cellStyle name="Normal" xfId="0" builtinId="0"/>
      </cellStyles>
    </styleSheet>
  `;
}

function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const timestamp = dosDateTime(new Date());

  entries.forEach((entry) => {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data).trim(), "utf8");
    const name = Buffer.from(entry.name, "utf8");
    const checksum = crc32(data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(timestamp.time, 10);
    localHeader.writeUInt16LE(timestamp.date, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, name, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(timestamp.time, 12);
    centralHeader.writeUInt16LE(timestamp.date, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, name);

    offset += localHeader.length + name.length + data.length;
  });

  const body = Buffer.concat(localParts);
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(body.length, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([body, centralDirectory, end]);
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function buildCrc32Table() {
  const table = new Uint32Array(256);
  for (let i = 0; i < table.length; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function loadFileStore() {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    return normalizeFileStore(JSON.parse(raw));
  } catch {
    const store = normalizeFileStore({});
    await saveFileStore(store);
    return store;
  }
}

async function saveFileStore(store) {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  await fs.writeFile(DATA_FILE, JSON.stringify(store, null, 2));
}

function normalizeFileStore(store) {
  const orders = Array.isArray(store.orders)
    ? store.orders.map((order) => ({ ...order, status: order.status || DEFAULT_ORDER_STATUS }))
    : [];

  return {
    users: Array.isArray(store.users) ? store.users : [],
    orders,
    events: Array.isArray(store.events) ? store.events : [],
    productOverrides: Array.isArray(store.productOverrides) ? store.productOverrides : [],
    nextUserId: Number(store.nextUserId || 1),
    nextOrderId: Number(store.nextOrderId || 1),
    nextEventId: Number(store.nextEventId || 1),
  };
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function cleanText(value) {
  return String(value ?? "").trim();
}

function cleanOrderStatus(value, fallback = null) {
  const status = cleanText(value).toLowerCase();
  return ORDER_STATUSES.includes(status) ? status : fallback;
}

function paginatedOrders(orders, { page, limit, total }) {
  return {
    orders,
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}

function normalizeSearch(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function cleanImageUrl(value) {
  const text = cleanText(value);
  if (!text) return "";
  const allowed = /^https?:\/\//i.test(text)
    || /^data:image\/(png|jpe?g|webp);base64,/i.test(text)
    || text.startsWith("./fotos/");
  if (!allowed) throw new Error("invalid image url");
  return text.slice(0, 2_500_000);
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function parseJsonValue(value) {
  if (!value) return Array.isArray(value) ? [] : {};
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

function safeFileName(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "orcamento";
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
