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

const pool = hasPostgres
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
    })
  : null;

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "2mb" }));

await ensureStore();

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, storage: hasPostgres ? "postgres" : "file" });
});

app.post("/api/auth/login", async (req, res) => {
  const username = cleanText(req.body?.username).toLowerCase();
  const password = String(req.body?.password || "");
  const user = username ? await findUserByUsername(username) : null;

  if (!user || !user.active || !(await bcrypt.compare(password, user.password_hash))) {
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

app.get("/api/orders", requireAuth(["admin", "seller"]), async (_req, res) => {
  const orders = await listOrders();
  res.json({ orders: orders.map(orderSummaryForApi) });
});

app.get("/api/orders/:code", requireAuth(["admin", "seller"]), async (req, res) => {
  const order = await findOrderByCode(req.params.code);
  if (!order) {
    res.status(404).json({ error: "Pedido nao encontrado" });
    return;
  }

  await logOrderEvent(order.id, req.user.id, "viewed", {
    via: req.query.token ? "whatsapp-link" : "dashboard",
  });

  const events = req.user.role === "admin" ? await listOrderEvents(order.id) : [];
  res.json({ order: orderForApi(order), events });
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
  const order = await findOrderByCode(req.params.code);
  if (!order) {
    res.status(404).json({ error: "Pedido nao encontrado" });
    return;
  }

  await logOrderEvent(order.id, req.user.id, "downloaded", { format: "xls" });
  const html = buildQuoteHtml(order);
  const fileName = `${safeFileName(order.code)}-${safeFileName(order.customer_name || "CLIENTE")}.xls`;
  res.setHeader("Content-Type", "application/vnd.ms-excel; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  res.send(`\ufeff${html}`);
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
    `);
  } else {
    await loadFileStore();
  }

  await seedDefaultUsers();
}

async function seedDefaultUsers() {
  if ((await listUsers()).length) return;

  await createUser({
    name: process.env.ADMIN_NAME || "Administrador",
    username: (process.env.ADMIN_USERNAME || "admin").toLowerCase(),
    password: process.env.ADMIN_PASSWORD || "admin123",
    role: "admin",
  });

  await createUser({
    name: process.env.SELLER_NAME || "Vendedora",
    username: (process.env.SELLER_USERNAME || "vendedora").toLowerCase(),
    password: process.env.SELLER_PASSWORD || "vendedora123",
    role: "seller",
  });
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
    created_at: existing?.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  store.orders = [order, ...store.orders.filter((item) => item.code !== order.code)];
  await saveFileStore(store);
  return order;
}

async function listOrders() {
  if (hasPostgres) {
    const result = await pool.query("SELECT * FROM orders ORDER BY created_at DESC");
    return result.rows;
  }
  return (await loadFileStore()).orders.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
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

function buildQuoteHtml(order) {
  const checkout = parseJsonValue(order.checkout);
  const items = parseJsonValue(order.items);
  const rows = items
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

  const deliveryRow = Number(order.delivery_fee || 0)
    ? `
        <tr>
          <td>Taxa de entrega</td>
          <td></td>
          <td class="money">${Number(order.delivery_fee || 0).toFixed(2)}</td>
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
          <tr class="title"><td colspan="3">Cliente: ${escapeHtml(order.customer_name)}</td></tr>
          <tr class="title"><td colspan="3">${escapeHtml(order.code)} | Telefone: ${escapeHtml(checkout.phone || "Nao informado")}</td></tr>
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

async function loadFileStore() {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    const store = { users: [], orders: [], events: [], nextUserId: 1, nextOrderId: 1, nextEventId: 1 };
    await saveFileStore(store);
    return store;
  }
}

async function saveFileStore(store) {
  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
  await fs.writeFile(DATA_FILE, JSON.stringify(store, null, 2));
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function cleanText(value) {
  return String(value ?? "").trim();
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

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
