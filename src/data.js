// Deterministic synthetic database in the shape of Looker's canonical
// "thelook" schema — NORMALIZED tables, so the mock SDK must resolve real
// LookML-style joins (order_items → orders → users, order_items → products)
// exactly the way a generated SQL query would. Replaces nothing in
// production — the real app gets rows from @looker/sdk run_inline_query.
// Deterministic PRNG so every demo/benchmark run sees identical data.

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEPARTMENTS = [
  { name: "Outerwear", base: 120, share: 0.20, brands: ["North Peak", "Stormline", "Alpine Co", "Ridgewear"] },
  { name: "Jeans", base: 70, share: 0.16, brands: ["True Denim", "Bluegrain", "Selvedge & Co", "Rivet"] },
  { name: "Sweaters", base: 55, share: 0.12, brands: ["Wool&Way", "Cablecraft", "Merino Mills"] },
  { name: "Tops & Tees", base: 24, share: 0.14, brands: ["Plainly", "Crewline", "Softstack"] },
  { name: "Dresses", base: 85, share: 0.11, brands: ["Meadowline", "Aster & Vine", "Twirl"] },
  { name: "Shoes", base: 95, share: 0.13, brands: ["Stride Lab", "Cobble & Last", "Pace Theory"] },
  { name: "Accessories", base: 30, share: 0.08, brands: ["Loop & Clasp", "Brimful", "Satchelry"] },
  { name: "Activewear", base: 48, share: 0.06, brands: ["Kinetic", "Sweatline", "FormFit", "Georgia Motion"] },
];

const STATES = [
  ["California", 0.14], ["Texas", 0.10], ["New York", 0.09], ["Florida", 0.08],
  ["Illinois", 0.06], ["Washington", 0.05], ["Massachusetts", 0.05], ["Colorado", 0.04],
  ["Georgia", 0.04], ["Oregon", 0.04], ["Ohio", 0.04], ["Michigan", 0.03],
  ["Virginia", 0.03], ["Arizona", 0.03], ["North Carolina", 0.03], ["Pennsylvania", 0.03],
  ["Minnesota", 0.03], ["New Jersey", 0.03], ["Utah", 0.02], ["Other", 0.04],
];

const TRAFFIC = [["Search", 0.35], ["Organic", 0.22], ["Email", 0.18], ["Social", 0.15], ["Display", 0.10]];

function pickWeighted(rand, pairs) {
  let r = rand(), acc = 0;
  for (const [v, w] of pairs) { acc += w; if (r <= acc) return v; }
  return pairs[pairs.length - 1][0];
}

// Months 2024-01 .. 2026-06 with mild growth + winter seasonality.
function monthList() {
  const out = [];
  for (let y = 2024; y <= 2026; y++)
    for (let m = 1; m <= 12; m++) {
      if (y === 2026 && m > 6) break;
      out.push({ y, m, key: `${y}-${String(m).padStart(2, "0")}` });
    }
  return out;
}

function generate() {
  const rand = mulberry32(20260808);

  // -- products: department × brand × a few SKUs each ------------------------
  const products = [];
  let productId = 0;
  for (const dept of DEPARTMENTS)
    for (const brand of dept.brands)
      for (let k = 0; k < 4; k++) {
        const retail = Math.round(dept.base * (0.7 + rand() * 0.8) * 100) / 100;
        products.push({
          id: ++productId, brand, department: dept.name,
          retail_price: retail,
          cost: Math.round(retail * (0.52 + rand() * 0.18) * 100) / 100,
        });
      }
  const productsByDept = new Map(DEPARTMENTS.map(d => [d.name, products.filter(p => p.department === d.name)]));

  // -- users -----------------------------------------------------------------
  const users = [];
  for (let i = 1; i <= 600; i++) users.push({ id: i, state: pickWeighted(rand, STATES) });

  // -- orders + order_items --------------------------------------------------
  const orders = [];
  const order_items = [];
  let orderId = 1000, itemId = 0;
  monthList().forEach(({ m, key }, i) => {
    const growth = 1 + i * 0.035;
    const season = 1 + 0.35 * Math.cos(((m - 12) / 12) * 2 * Math.PI); // peaks Nov–Jan
    const nOrders = Math.round(38 * growth * season * (0.85 + rand() * 0.3));
    for (let o = 0; o < nOrders; o++) {
      orderId++;
      const day = 1 + Math.floor(rand() * 28);
      orders.push({
        id: orderId,
        user_id: 1 + Math.floor(rand() * users.length),
        created_date: `${key}-${String(day).padStart(2, "0")}`,
        traffic_source: pickWeighted(rand, TRAFFIC),
      });
      const nItems = 1 + (rand() < 0.35 ? 1 : 0) + (rand() < 0.12 ? 1 : 0);
      for (let it = 0; it < nItems; it++) {
        const dept = pickWeighted(rand, DEPARTMENTS.map(d => [d, d.share]));
        if ((dept.name === "Outerwear" || dept.name === "Sweaters") && season < 1 && rand() < 0.4) continue;
        const pool = productsByDept.get(dept.name);
        const product = pool[Math.floor(rand() * pool.length)];
        order_items.push({
          id: ++itemId,
          order_id: orderId,
          product_id: product.id,
          sale_price: Math.round(product.retail_price * (0.85 + rand() * 0.3) * 100) / 100,
        });
      }
    }
  });

  return { users, products, orders, order_items };
}

export const DB = generate();
