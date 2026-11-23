// Market Pulse dashboard.
// Plain JavaScript, no build step: the browser runs this file as it is.
//
// How it works:
//   1. load() downloads data/latest.json (written by analyzer/dashboard_data.py).
//   2. The part after "#" in the address decides which page to show (the "route"):
//        #/            Today        #/watchlist   Watchlist
//        #/news        News         #/videos      Videos
//        #/s/NVDA      Detail page with a chart for one symbol
//        #/compare/NVDA,AMD   Two to four symbols side by side
//        #/calc/VWCE.DE       ETF calculator (in calc.js), shown under Portfolio
//   3. Each page is a function that returns HTML, which we put into <main id="view">.

const TZ = "Europe/Istanbul";
const state = { data: null, newsFilter: "all", range: "6M", chartType: "line" };
const view = document.getElementById("view");

// ---------------------------------------------------------------- small helpers

// Makes text safe to put inside HTML (so a headline can't break the page).
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const fmtPrice = (v, cur = "") => {
  if (v == null) return "–";
  const digits = v >= 1000 ? 0 : v >= 1 ? 2 : 4;
  return cur + v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
};
const fmtPct = (v) => (v == null ? "–" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(2)}%`);
const dir = (v) => (v == null || Math.abs(v) < 0.005 ? "flat" : v > 0 ? "up" : "down");
const arrow = (v) => ({ up: "▲", down: "▼", flat: "" }[dir(v)]);
const pill = (v) => `<span class="pill ${dir(v)} num">${arrow(v)} ${fmtPct(v)}</span>`;

function timeAgo(ts) {
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
const istanbulTime = (iso) => new Date(iso).toLocaleString("en-GB", {
  timeZone: TZ, weekday: "short", hour: "2-digit", minute: "2-digit",
});

// Tiny line chart (no axes) showing the last 30 days.
function sparkline(values, change) {
  if (!values || values.length < 2) return '<svg class="spark"></svg>';
  const w = 64, h = 28, min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - 2 - ((v - min) / span) * (h - 4)}`).join(" ");
  const color = dir(change) === "down" ? "var(--down-mark)" : "var(--up-mark)";
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" aria-hidden="true">
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

// ---------------------------------------------------------------- logos
// Company logos come from Financial Modeling Prep's free image service and coin
// icons from the open-source "cryptocurrency-icons" set. If a logo is missing,
// a colored circle with the first letters is shown instead.

const INDEX_FLAG = { "^GSPC": "🇺🇸", "^IXIC": "🇺🇸", "^NDX": "🇺🇸", "^DJI": "🇺🇸", "^RUT": "🇺🇸", "^VIX": "😨",
  "^STOXX50E": "🇪🇺", "^GDAXI": "🇩🇪", "^FCHI": "🇫🇷", "^FTSE": "🇬🇧", "^ATX": "🇦🇹", "^N225": "🇯🇵" };
const isCrypto = (symbol) => /-(USD|EUR|USDT)$/.test(symbol);

function logo(symbol, name, size = "") {
  symbol = String(symbol || "");
  if (symbol.startsWith("^")) return `<span class="logo flag ${size}">${INDEX_FLAG[symbol] || "📊"}</span>`;
  const hue = [...symbol].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  const letters = esc(String(name || symbol).replace(/[^A-Za-z0-9 ]/g, "").split(" ").filter(Boolean)
    .slice(0, 2).map((w) => w[0]).join("").toUpperCase() || symbol.slice(0, 2));
  const src = isCrypto(symbol)
    ? `https://cdn.jsdelivr.net/npm/cryptocurrency-icons@0.18.1/svg/color/${symbol.split("-")[0].toLowerCase()}.svg`
    : `https://financialmodelingprep.com/image-stock/${encodeURIComponent(symbol)}.png`;
  return `<span class="logo ${size} ${isCrypto(symbol) ? "coin" : ""}" style="--h:${hue}"><i>${letters}</i><img class="lg" src="${src}" alt="" loading="lazy" referrerpolicy="no-referrer"></span>`;
}

function siteIcon(link, size = "sm") {
  let host = "";
  try { host = new URL(link).hostname; } catch (e) { /* ignore */ }
  return `<span class="logo site ${size}"><i>📰</i>${host ? `<img class="lg" src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64" alt="" loading="lazy" referrerpolicy="no-referrer">` : ""}</span>`;
}

// A logo that fails to load is removed, so the letters behind it show.
document.addEventListener("error", (e) => { if (e.target.matches?.("img.lg")) e.target.remove(); }, true);
document.addEventListener("load", (e) => { if (e.target.matches?.("img.lg")) e.target.classList.add("ok"); }, true);

// ---------------------------------------------------------------- favorites
// Saved on this phone. Order = order shown on the Today page and in the Watchlist.
const favs = {
  list() { try { return JSON.parse(localStorage.getItem("favs") || "[]"); } catch (e) { return []; } },
  save(l) { try { localStorage.setItem("favs", JSON.stringify(l)); } catch (e) { /* ignore */ } },
  has(sym) { return this.list().includes(sym); },
  toggle(sym) { const l = this.list(); this.save(l.includes(sym) ? l.filter((x) => x !== sym) : [...l, sym]); },
  move(sym, step) {
    const l = this.list(), i = l.indexOf(sym), j = i + step;
    if (i < 0 || j < 0 || j >= l.length) return;
    [l[i], l[j]] = [l[j], l[i]]; this.save(l);
  },
  quotes() { return this.list().map((s) => quoteFor(s)).filter(Boolean); },
};
const starBtn = (sym) => `<button class="star ${favs.has(sym) ? "on" : ""}" data-star="${esc(sym)}" aria-label="Favorite ${esc(sym)}">${favs.has(sym) ? "★" : "☆"}</button>`;

const SIGNAL_EMOJI = { buy: "🟢", sell: "🔴", avoid: "⛔", hold: "🟡", watch: "👀" };
const signalFor = (symbol) => (state.data?.digest?.signals || []).find((s) => s.symbol === symbol);
const quoteFor = (symbol) => state.data.quotes.find((q) => q.symbol === symbol);

// ---------------------------------------------------------------- password lock
// The data files on the website are encrypted (see analyzer/lock.py).
// data/lock.json says how. We turn your password into a key with PBKDF2
// and use it to decrypt each file right here on your phone.

const lock = { info: null, key: null, keySalt: null };
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function savedPassword() {
  try { return localStorage.getItem("dashPassword"); } catch (e) { return null; }
}
function savePassword(pw) {
  try { pw ? localStorage.setItem("dashPassword", pw) : localStorage.removeItem("dashPassword"); } catch (e) { /* private mode */ }
}

async function deriveKey(password) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: b64(lock.info.salt), iterations: lock.info.iterations, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
}

// Downloads a data file and decrypts it if needed.
async function getJSON(path) {
  const resp = await fetch(`${path}?t=${Date.now()}`, { cache: "no-store" });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const body = await resp.json();
  if (!lock.info || !lock.info.v) return body;
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(body.iv) }, lock.key, b64(body.ct));
  return JSON.parse(new TextDecoder().decode(plain));
}

function showLock(message = "") {
  document.getElementById("page-title").textContent = "Market Pulse";
  document.getElementById("updated").textContent = "🔒 Locked";
  view.innerHTML = `
    <form class="card lock" id="lock-form">
      <div style="font-size:40px">🔒</div>
      <h2>Enter your password</h2>
      <input type="password" id="pw" autocomplete="current-password" placeholder="Dashboard password" required>
      <label class="remember"><input type="checkbox" id="remember" checked> Remember on this device</label>
      ${message ? `<p class="lock-error">${esc(message)}</p>` : ""}
      <button type="submit" class="primary">Unlock</button>
    </form>`;
  document.getElementById("pw").focus();
  document.getElementById("lock-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pw = document.getElementById("pw").value;
    savePassword(document.getElementById("remember").checked ? pw : null);
    lock.key = null;
    await load(pw);
  });
}

// ---------------------------------------------------------------- loading data

async function load(typedPassword) {
  const btn = document.getElementById("refresh");
  btn.classList.add("spin");
  try {
    lock.info = await fetch(`data/lock.json?t=${Date.now()}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { v: 0 })).catch(() => ({ v: 0 }));
    if (lock.info.v) {
      // A new salt comes with every update, so the key is derived again when it changes.
      if (!lock.key || lock.keySalt !== lock.info.salt) {
        const pw = typedPassword || savedPassword();
        if (!pw) { showLock(); return; }
        lock.key = await deriveKey(pw);
        lock.password = pw;  // kept in memory only, to encrypt price alerts you save
        lock.keySalt = lock.info.salt;
      }
    }
    try {
      state.data = await getJSON("data/latest.json");
      if (checkForNewVersion()) return;
      await loadInbox();
    } catch (e) {
      if (e.name === "OperationError") {  // decryption failed: wrong password
        lock.key = null; savePassword(null);
        showLock("Wrong password, try again.");
        return;
      }
      throw e;
    }
    document.getElementById("updated").textContent = `Updated ${istanbulTime(state.data.generated_at)} · Istanbul`;
    document.getElementById("lock-form")?.remove();  // unlocked: hide the lock screen
    render();
    startLive();
  } catch (e) {
    document.getElementById("updated").textContent = "Couldn't load data. Tap ↻ to retry.";
    if (!state.data) view.innerHTML = `<div class="empty">No data yet. It appears after the first update run.</div>`;
  } finally {
    btn.classList.remove("spin");
  }
}

// ---------------------------------------------------------------- pages

// ---------------------------------------------------------------- market clock
// Regular trading hours in each exchange's own time zone, so summer/winter time is handled.
// Public holidays are not included: on a holiday the market shows "open" but is closed.

const EXCHANGES = [
  { id: "us", flag: "🇺🇸", name: "New York", tz: "America/New_York", open: [9, 30], close: [16, 0] },
  { id: "de", flag: "🇩🇪", name: "Frankfurt", tz: "Europe/Berlin", open: [9, 0], close: [17, 30] },
  { id: "at", flag: "🇦🇹", name: "Vienna", tz: "Europe/Vienna", open: [9, 0], close: [17, 30] },
  { id: "uk", flag: "🇬🇧", name: "London", tz: "Europe/London", open: [8, 0], close: [16, 30] },
];
// Other European exchanges, for single-stock pages (by Yahoo symbol ending).
const VENUES = Object.fromEntries(EXCHANGES.map((x) => [x.id, x]));
Object.assign(VENUES, {
  AS: { flag: "🇳🇱", name: "Amsterdam", tz: "Europe/Amsterdam", open: [9, 0], close: [17, 30] },
  PA: { flag: "🇫🇷", name: "Paris", tz: "Europe/Paris", open: [9, 0], close: [17, 30] },
  MI: { flag: "🇮🇹", name: "Milan", tz: "Europe/Rome", open: [9, 0], close: [17, 30] },
  MC: { flag: "🇪🇸", name: "Madrid", tz: "Europe/Madrid", open: [9, 0], close: [17, 30] },
  SW: { flag: "🇨🇭", name: "Zurich (SIX)", tz: "Europe/Zurich", open: [9, 0], close: [17, 30] },
  CO: { flag: "🇩🇰", name: "Copenhagen", tz: "Europe/Copenhagen", open: [9, 0], close: [17, 0] },
  ST: { flag: "🇸🇪", name: "Stockholm", tz: "Europe/Stockholm", open: [9, 0], close: [17, 30] },
  HE: { flag: "🇫🇮", name: "Helsinki", tz: "Europe/Helsinki", open: [10, 0], close: [18, 30] },
  OL: { flag: "🇳🇴", name: "Oslo", tz: "Europe/Oslo", open: [9, 0], close: [16, 20] },
  BR: { flag: "🇧🇪", name: "Brussels", tz: "Europe/Brussels", open: [9, 0], close: [17, 30] },
  LS: { flag: "🇵🇹", name: "Lisbon", tz: "Europe/Lisbon", open: [8, 0], close: [16, 30] },
  IR: { flag: "🇮🇪", name: "Dublin", tz: "Europe/Dublin", open: [8, 0], close: [16, 30] },
});
Object.entries(VENUES).forEach(([id, v]) => { v.id = id; });

const WEEKDAY = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 };

function tzNow(tz, at = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at).map((x) => [x.type, x.value]));
  return { day: WEEKDAY[p.weekday], min: Number(p.hour) * 60 + Number(p.minute) };
}

function marketStatus(ex, at = new Date()) {
  const { day, min } = tzNow(ex.tz, at);
  const o = ex.open[0] * 60 + ex.open[1], c = ex.close[0] * 60 + ex.close[1];
  const workday = (d) => d >= 1 && d <= 5;
  if (workday(day) && min >= o && min < c) return { open: true, minutes: c - min };
  let ahead = workday(day) && min < o ? o - min : null;
  for (let d = 1; ahead == null; d++) if (workday((day + d) % 7)) ahead = d * 1440 - min + o;
  return { open: false, minutes: ahead };
}

function duration(m) {
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

function istanbulClock(at, withDay) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Istanbul", hour: "2-digit", minute: "2-digit",
    ...(withDay ? { weekday: "short" } : {}) }).format(at);
}

function statusText(ex) {
  const s = marketStatus(ex), at = new Date(Date.now() + s.minutes * 60000);
  if (s.open) return { open: true, label: "🟢 Open", detail: `closes in ${duration(s.minutes)}` };
  if (s.minutes > 18 * 60) return { open: false, label: "🔴 Closed", detail: `opens ${istanbulClock(at, true)}` };
  return { open: false, label: "🔴 Closed", detail: `opens in ${duration(s.minutes)}` };
}

const hhmm = (t) => `${String(t[0]).padStart(2, "0")}:${String(t[1]).padStart(2, "0")}`;
function istanbulHours(ex) {
  // Today's opening and closing time, shown in Istanbul time.
  const ref = new Date(), { min } = tzNow(ex.tz, ref);
  const toIst = (t) => istanbulClock(new Date(ref.getTime() + ((t[0] * 60 + t[1]) - min) * 60000));
  return `${toIst(ex.open)}–${toIst(ex.close)}`;
}

function marketsCard() {
  return `<h2 class="section-title">🕒 Markets <span class="sub">times in Istanbul</span></h2>
    <div class="card markets">${EXCHANGES.map((ex) => `
      <div class="mrow"><div class="who"><div class="t">${ex.flag} ${ex.name}</div>
        <div class="s">${istanbulHours(ex)} <span class="local">(local ${hhmm(ex.open)}–${hhmm(ex.close)})</span></div></div>
        <div class="mstat" data-mclock="${ex.id}" data-two-lines></div></div>`).join("")}
      <div class="mrow"><div class="who"><div class="t">₿ Crypto</div><div class="s">24 hours, 7 days</div></div>
        <div class="mstat"><b class="m-open">🟢 Open</b><span>always</span></div></div>
      <p class="hint">Public holidays are not included.</p>
    </div>`;
}

function exchangeFor(q) {
  if (q.group === "crypto") return null;
  const suffix = q.symbol.includes(".") ? q.symbol.split(".").pop() : "";
  if (VENUES[suffix] && suffix.length === 2 && suffix === suffix.toUpperCase()) return suffix;
  if (q.group === "index") return /^\^(GDAXI|STOXX50E|FCHI)$/.test(q.symbol) ? "de" : q.symbol === "^FTSE" ? "uk" : q.symbol === "^ATX" ? "at" : /^\^(GSPC|NDX|IXIC|DJI|RUT|VIX)$/.test(q.symbol) ? "us" : null;
  if (q.symbol.endsWith(".VI")) return "at";
  if (q.symbol.endsWith(".L")) return "uk";
  return (q.tags || []).includes("europe") || q.symbol.includes(".") ? "de" : "us";
}

function marketLine(q) {
  if (q.group === "crypto") return `<div class="hero-clock"><span class="m-open">🟢 Open</span> · crypto trades 24 hours, 7 days a week</div>`;
  const ex = VENUES[exchangeFor(q)];
  if (!ex) return "";
  return `<div class="hero-clock">${ex.flag} <b>${ex.name}</b> · ${marketTag(ex.id)}
    <div class="s">Trading hours ${istanbulHours(ex)} Istanbul time (local ${hhmm(ex.open)}–${hhmm(ex.close)})</div></div>`;
}

function marketTag(id) { return `<span class="mtag" data-mclock="${id}"></span>`; }

function tickClocks() {
  document.querySelectorAll("[data-mclock]").forEach((el) => {
    const ex = VENUES[el.dataset.mclock];
    if (!ex) return;
    const st = statusText(ex);
    const cls = st.open ? "m-open" : "m-closed";
    el.innerHTML = "twoLines" in el.dataset ? `<b class="${cls}">${st.label}</b><span>${st.detail}</span>`
      : `<span class="${cls}">${st.label} · ${st.detail}</span>`;
  });
}
setInterval(tickClocks, 20000);

function pageToday() {
  const d = state.data;
  const indices = d.quotes.filter((q) => q.group === "index");
  const movers = d.quotes.filter((q) => q.group !== "index" && q.change_1d != null)
    .sort((a, b) => Math.abs(b.change_1d) - Math.abs(a.change_1d)).slice(0, 5);
  const digest = d.digest;
  const signals = digest?.signals || [];

  return `
    <div class="chips">${indices.map((q) => `
      <a class="chip" href="#/s/${q.file}">
        <div class="label">${INDEX_FLAG[q.symbol] || "📊"} ${esc(q.name)}</div>
        <div class="value num">${livePrice(q, false)}</div>
        <div class="num" style="font-size:13px;font-weight:600">${liveChange(q)}</div>
      </a>`).join("")}
    </div>

    <h2 class="section-title">🎯 Today's signals${digest ? ` <span class="sub">${istanbulTime(digest.sent_at)}</span>` : ""}</h2>
    ${signals.length ? signals.map(signalCard).join("") :
      `<div class="card empty">No signals yet today. They appear after the morning digest.</div>`}

    <h2 class="section-title">🔥 Biggest moves</h2>
    <div class="list">${movers.map((q) => row(q)).join("")}</div>

    ${recordTeaser()}

    ${installHint()}
    <p class="disclaimer">⚠️ Signals are AI analysis, not financial advice, and can be wrong.</p>`;
}

function recordTeaser() {
  const r = state.data.track_record;
  if (!r || !r.total) return "";
  const b = r.buy, x = r.sell;
  const part = (label, s) => s.scored ? `${label} ${s.right}/${s.scored} right` : `${label} ⏳`;
  return `<a class="card teaser" href="#/record">✅ <b>Track record:</b> ${part("BUY", b)} · ${part("SELL", x)} <span class="chev">›</span></a>`;
}

function signalCard(s) {
  const q = quoteFor(s.symbol);
  const href = q ? `#/s/${q.file}` : "#/";
  return `<a class="card signal" href="${href}">
    <div class="signal-head">
      ${logo(s.symbol, s.name || q?.name)}
      <div class="who"><div class="t">${esc(s.name || q?.name || s.symbol)}</div>
        <div class="s">${esc(s.symbol)}${s.confidence ? ` · ${"⭐".repeat({ Low: 1, Medium: 2, High: 3 }[s.confidence] || 0)} ${esc(s.confidence)}` : ""}</div></div>
      <span class="badge ${s.action}">${SIGNAL_EMOJI[s.action] || ""} ${esc(s.label)}</span>
    </div>
    ${q ? `<div class="num" style="margin-top:6px;font-size:14px">${livePrice(q)} &nbsp;${livePill(q)}</div>` : ""}
    ${s.reasons ? `<p class="why">${esc(s.reasons)}</p>` : ""}
  </a>`;
}

function row(q, opts = {}) {
  const sig = signalFor(q.symbol);
  return `<a class="row ${opts.star ? "has-star" : ""}" href="#/s/${q.file}">
    ${logo(q.symbol, q.name)}
    <div class="who">
      <div class="t">${esc(q.name)}</div>
      <div class="s">${esc(q.symbol)}${sig ? ` <span class="badge mini ${sig.action}">${SIGNAL_EMOJI[sig.action] || ""} ${esc(sig.label)}</span>` : ""}</div>
    </div>
    ${sparkline(q.spark, q.change_1m)}
    <div class="price">
      <div class="p num">${livePrice(q)}</div>
      ${livePill(q)}
    </div>
    ${opts.star ? starBtn(q.symbol) : ""}
  </a>`;
}

function pageWatchlist() {
  if (state.editing) return pageEditWatchlist();
  const q = state.data.quotes;
  const fav = favs.quotes(), notFav = (x) => !favs.has(x.symbol);
  const us = q.filter((x) => x.group === "stock" && !(x.tags || []).includes("europe") && notFav(x));
  const eu = q.filter((x) => x.group === "stock" && (x.tags || []).includes("europe") && notFav(x));
  const crypto = q.filter((x) => x.group === "crypto" && notFav(x));
  const block = (title, items) => items.length ? `<h2 class="section-title">${title}</h2><div class="list">${items.map((x) => row(x, { star: true })).join("")}</div>` : "";
  const favBlock = !fav.length ? `<p class="hint fav-hint">Tip: tap ☆ to pin a stock to the top and to your Today page.</p>`
    : state.reorder ? `<h2 class="section-title">⭐ Favorites <button class="pill-btn small" data-act="reorder-done">✓ Done</button></h2>
        <div class="list">${fav.map((x, i) => `<div class="row edit-row">${logo(x.symbol, x.name)}
          <div class="who"><div class="t">${esc(x.name)}</div><div class="s">${esc(x.symbol)}</div></div>
          <button class="mv" data-move="${esc(x.symbol)}" data-step="-1" ${i ? "" : "disabled"} aria-label="Move up">▲</button>
          <button class="mv" data-move="${esc(x.symbol)}" data-step="1" ${i < fav.length - 1 ? "" : "disabled"} aria-label="Move down">▼</button>
          ${starBtn(x.symbol)}</div>`).join("")}</div>`
    : `<h2 class="section-title">⭐ Favorites ${fav.length > 1 ? `<button class="pill-btn small" data-act="reorder">↕️ Reorder</button>` : ""}</h2>
        <div class="list">${fav.map((x) => row(x, { star: true })).join("")}</div>`;
  return `<div class="edit-bar"><span class="sub">${q.filter((x) => x.live && live.prices[x.symbol]).length ? "● Some prices are live" : "Prices refresh every 15 minutes"}</span>
      <button class="pill-btn" data-act="edit">✏️ Edit list</button></div>` +
    (state.flash ? `<div class="card notice">${state.flash}</div>` : "") +
    favBlock + earningsSection() + block(`🇺🇸 US stocks ${marketTag("us")}`, us) + block(`🇪🇺 Europe ${marketTag("de")}`, eu) + block("₿ Crypto", crypto) +
    `<p class="disclaimer">Prices from Yahoo Finance (European stocks about 15 min delayed). Live where marked ● LIVE.</p>`;
}

// Which of your stocks a headline is about (by symbol from the feed, or name in the title).
function newsSymbol(n) {
  if (n.symbol) return n.symbol;
  if (n._sym !== undefined) return n._sym;
  const hit = state.data.quotes.find((q) => q.group !== "index" && q.name.length >= 3 &&
    (new RegExp(`\\b${q.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(n.title) ||
     (q.symbol.split(/[.-]/)[0].length >= 3 && new RegExp(`\\b${q.symbol.split(/[.-]/)[0]}\\b`).test(n.title))));
  return (n._sym = hit ? hit.symbol : null);
}
function newsLogo(n) {
  const sym = newsSymbol(n);
  return sym ? logo(sym, quoteFor(sym)?.name, "sm") : siteIcon(n.link);
}

// ---------------------------------------------------------------- "Show more" for long lists
// Long lists start with a few rows. A button under the list shows the next batch,
// and "Show less" folds it back. How far you opened a list is remembered until you
// switch to another tab.
let shownCount = {};
// "older" swaps "Show 10 more" for "Show 10 older messages" (used by the inbox).
function limited(key, items, first = 5, step = 10, older = false) {
  const n = Math.max(first, shownCount[key] ?? first);
  const left = items.length - n;
  let more = "";
  if (left > 0) {
    const next = Math.min(step, left), all = next === left;
    const what = older ? `${all ? `all ${left}` : next} older message${next === 1 ? "" : "s"}` : `${all ? `all ${left}` : next} more`;
    more = `<button class="show-more" data-more="${esc(key)}" data-n="${n + next}">
      Show ${what}${all ? "" : ` <span>(${left} left)</span>`} ⌄</button>`;
  } else if (n > first && items.length > first) {
    more = `<button class="show-more" data-more="${esc(key)}" data-n="${first}">Show less ⌃</button>`;
  }
  return { items: items.slice(0, n), more };
}

function pageNews() {
  const all = state.data.news;
  const cryptoWords = /bitcoin|crypto|ethereum|solana|btc|eth\b|coin/i;
  const filters = {
    all: () => true,
    mine: (n) => newsSymbol(n),
    crypto: (n) => cryptoWords.test(n.title) || /coin/i.test(n.source),
    ai: (n) => /\bAI\b|artificial intelligence|nvidia|openai|chip/i.test(n.title),
  };
  const items = all.filter(filters[state.newsFilter]);
  const btn = (k, label) => `<button data-filter="${k}" class="${state.newsFilter === k ? "on" : ""}">${label}</button>`;
  const page = limited(`news-${state.newsFilter}`, items, 10, 10);
  return `<div class="filters">${btn("all", "All")}${btn("mine", "📈 My stocks")}${btn("ai", "🤖 AI")}${btn("crypto", "₿ Crypto")}</div>
    <div class="list">${items.length ? page.items.map((n) => `
      <a class="news-item" href="${esc(n.link)}" target="_blank" rel="noopener">
        ${newsLogo(n)}<div class="nbody"><div class="meta">${esc(n.source.replace(/^Yahoo \(.*\)$/, "Yahoo Finance"))} · ${timeAgo(n.ts)}${newsSymbol(n) ? `<span class="tag">${esc(newsSymbol(n))}</span>` : ""}</div>
        <div class="title">${esc(n.title)}</div></div>
      </a>`).join("") : `<div class="empty">No articles for this filter.</div>`}</div>${page.more}`;
}

const compact = (n) => n == null ? "–" : Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);

function pageVideos() {
  const now = Date.now() / 1000;
  const vids = state.data.videos.map((v) => {
    const hours = Math.max(1, (now - v.published_ts) / 3600);
    return { ...v, perHour: v.views == null ? 0 : v.views / hours };
  });
  // "Trending": the fastest-growing fifth of videos (views per hour since upload).
  const rates = vids.map((v) => v.perHour).sort((a, b) => b - a);
  const hot = rates[Math.max(0, Math.floor(rates.length / 5) - 1)] || Infinity;
  vids.forEach((v) => { v.trending = v.perHour > 0 && v.perHour >= hot; });

  const sorters = {
    new: (a, b) => b.published_ts - a.published_ts,
    views: (a, b) => (b.views || 0) - (a.views || 0),
    hot: (a, b) => b.perHour - a.perHour,
  };
  const list = [...vids].sort(sorters[state.videoSort || "new"]);
  const btn = (k, label) => `<button data-vsort="${k}" class="${(state.videoSort || "new") === k ? "on" : ""}">${label}</button>`;
  const when = (ts) => new Date(ts * 1000).toLocaleString("en-GB", { timeZone: TZ, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  const page = limited(`videos-${state.videoSort || "new"}`, list, 6, 6);
  return `<div class="filters">${btn("new", "🕒 Newest")}${btn("views", "👁 Most viewed")}${btn("hot", "🔥 Trending")}</div>
    <div class="list">${list.length ? page.items.map((x) => `
      <a class="video" href="${esc(x.link)}" target="_blank" rel="noopener">
        <div class="thumb">${x.id ? `<img loading="lazy" alt="" src="https://i.ytimg.com/vi/${esc(x.id)}/mqdefault.jpg">` : ""}
          ${x.trending ? `<span class="hot">🔥 Trending</span>` : ""}</div>
        <div class="vbody">
          <div class="title">${esc(x.title)}</div>
          <div class="meta">${esc(x.channel_title || x.channel)}</div>
          <div class="meta num">📅 ${esc(when(x.published_ts))} · ${timeAgo(x.published_ts)}</div>
          <div class="meta num">👁 ${compact(x.views)} views · 👍 ${compact(x.likes)}${x.views ? ` · ${compact(Math.round(x.perHour))}/h` : ""}</div>
          ${x.description ? `<div class="desc">${esc(x.description)}</div>` : ""}
        </div>
      </a>`).join("") : `<div class="empty">No new videos in the last 3 days.</div>`}</div>${page.more}
    <p class="disclaimer">Last 3 days from your channels. Add channels in config/sources.yaml.</p>`;
}

// Track record: how did earlier signals turn out?
function pageRecord() {
  const r = state.data.track_record;
  if (!r || !r.total) {
    return `<div class="card empty">No signals saved yet. From now on every morning's signals are saved here
      and checked against what the price really did.</div>`;
  }
  const summary = (title, s, verb) => `
    <div class="card score">
      <div class="k">${title}</div>
      ${s.scored ? `<div class="big num">${s.right} of ${s.scored} right</div>
        <div class="meter" role="img" aria-label="${s.hit_rate}% right"><span style="width:${s.hit_rate}%"></span></div>
        <div class="hint num">${s.hit_rate}% · price ${verb} on average <b class="${dir(s.avg_change)}-text">${fmtPct(s.avg_change)}</b> after 1 week</div>`
        : `<div class="big">⏳ Not scored yet</div>`}
      ${s.pending ? `<div class="hint">${s.pending} still waiting for their 1-week result</div>` : ""}
    </div>`;
  const icon = { right: "✅", wrong: "❌", pending: "⏳", info: "➖" };
  const cell = (v) => `<span class="${dir(v)}-text num">${v == null ? "·" : fmtPct(v)}</span>`;
  const days = limited("record-days", [...new Set(r.items.map((i) => i.date))], 3, 5);
  const dayLabel = (d) => new Date(d + "T12:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

  return `
    <div class="score-grid">
      ${summary("🟢 BUY calls", r.buy, "moved")}
      ${summary("🔴 SELL & ⛔ DON'T BUY", r.sell, "moved")}
    </div>
    <p class="explain">A <b>BUY</b> counts as ✅ right if the price is higher one week later.
      A <b>SELL</b> or <b>DON'T BUY</b> is right if the price is lower. HOLD and WATCH are shown but not scored.
      Changes are measured from the last closing price before the signal. Tracking since ${esc(dayLabel(r.since))}.</p>
    ${days.items.map((d) => `
      <h2 class="section-title">${esc(dayLabel(d))}</h2>
      <div class="list">
        <div class="rec-row rec-head"><span></span><span>1 day</span><span>1 week</span><span>1 month</span><span></span></div>
        ${r.items.filter((i) => i.date === d).map((i) => {
          const q = quoteFor(i.symbol);
          return `<a class="rec-row" href="${q ? `#/s/${q.file}` : "#/record"}">
            <span class="rec-who"><span class="badge ${i.action}">${SIGNAL_EMOJI[i.action] || ""} ${esc(i.label)}</span>
              <b>${esc(i.symbol)}</b><small class="num">from ${fmtPrice(i.entry_price, q?.currency || "")}</small></span>
            ${cell(i["1d"])}${cell(i["1w"])}${cell(i["1m"])}
            <span title="${i.result}">${icon[i.result]}</span>
          </a>`;
        }).join("")}
      </div>`).join("")}${days.more}
    <p class="disclaimer">Past results don't guarantee future results.</p>`;
}

function pageDetail(file) {
  const q = state.data.quotes.find((x) => x.file === file);
  if (!q) return `<a class="back" href="#/watchlist">‹ Watchlist</a><div class="empty">Symbol not found.</div>`;
  const sig = signalFor(q.symbol);
  const related = state.data.news.filter((n) => n.symbol === q.symbol ||
    n.title.toLowerCase().includes(q.name.toLowerCase())).slice(0, 6);
  const stat = (k, v, hint = "") => `<div class="stat"><div class="k">${k}</div><div class="v num">${v}</div>${hint ? `<div class="hint">${hint}</div>` : ""}</div>`;
  const rsiHint = q.rsi14 == null ? "" : q.rsi14 > 70 ? "overbought 🔥" : q.rsi14 < 30 ? "oversold 🧊" : "neutral";
  const seg = (name, opts, cur) => `<div class="seg" data-seg="${name}">${opts.map((o) =>
    `<button data-v="${o}" class="${o === cur ? "on" : ""}">${o === "line" ? "Line" : o === "candles" ? "Candles" : o}</button>`).join("")}</div>`;

  return `
    <a class="back" href="#/watchlist">‹ Watchlist</a>
    <div class="hero">
      <div class="hero-top">${logo(q.symbol, q.name, "lg")}
        <div class="hero-name"><div class="t">${esc(q.name)}</div><div class="s">${esc(q.symbol)}</div></div>
        ${q.group !== "index" ? starBtn(q.symbol) : ""}</div>
      ${marketLine(q)}
      <div class="big num">${livePrice(q)}</div>
      <div class="chg num">${liveChange(q)} today ${q.live ? `<span class="live-tag" data-livetag="${esc(q.symbol)}">${live.prices[q.symbol] ? "● LIVE" : "○ connecting"}</span>` : `· last price ${esc(q.last_date)}, may be delayed`}</div>
    </div>
    ${sig ? `<div style="margin-top:12px">${signalCard(sig)}</div>` : ""}
    <div class="btn-row"><a class="pill-btn cmp-btn" href="${compareHref([q, comparePartner(q)].filter(Boolean))}">⚖️ Compare with others</a>
      ${calcIsEtf(q) ? `<a class="pill-btn cmp-btn" href="#/calc/${encodeURIComponent(q.file)}">🧮 What if I invest?</a>` : ""}</div>
    ${earningsLine(q)}
    ${dividendLine(q)}

    <div class="controls">${seg("range", ["1M", "3M", "6M", "1Y", "2Y"], state.range)}${seg("type", ["line", "candles"], state.chartType)}</div>
    <div class="card" style="padding:10px 6px 6px">
      <div class="legend"><span><i style="background:var(--ink-2)"></i>Price</span>
        <span><i style="background:var(--sma50)"></i>50-day average</span>
        <span><i style="background:var(--sma200)"></i>200-day average</span></div>
      <div class="readout num" id="readout">Touch the chart to see values.</div>
      <div id="chart"></div>
    </div>

    ${alertsCard(q)}

    <h2 class="section-title">📊 Key numbers</h2>
    <div class="stats">
      ${stat("1 week", `<span class="${dir(q.change_5d)}-text">${fmtPct(q.change_5d)}</span>`)}
      ${stat("1 month", `<span class="${dir(q.change_1m)}-text">${fmtPct(q.change_1m)}</span>`)}
      ${stat("RSI (14)", q.rsi14 == null ? "–" : q.rsi14.toFixed(0), rsiHint)}
      ${stat("vs 50-day", fmtPct(q.vs_sma50), "above/below average")}
      ${stat("vs 200-day", fmtPct(q.vs_sma200), "long-term trend")}
      ${stat("Volume", q.volume_ratio == null ? "–" : q.volume_ratio.toFixed(1) + "×", "vs 20-day avg")}
    </div>

    <h2 class="section-title">📰 News</h2>
    <div class="list">${related.length ? related.map((n) => `
      <a class="news-item" href="${esc(n.link)}" target="_blank" rel="noopener">
        <div class="meta">${esc(n.source.replace(/^Yahoo \(.*\)$/, "Yahoo Finance"))} · ${timeAgo(n.ts)}</div>
        <div class="title">${esc(n.title)}</div></a>`).join("") : `<div class="empty">No news in the last 24 hours.</div>`}</div>`;
}

// ---------------------------------------------------------------- the price chart

let chart = null;
const historyCache = {};

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Moving average: for each day, the average close of the previous `n` days.
function sma(candles, n) {
  const out = [];
  let sum = 0;
  candles.forEach((c, i) => {
    sum += c[4];
    if (i >= n) sum -= candles[i - n][4];
    if (i >= n - 1) out.push({ time: c[0], value: sum / n });
  });
  return out;
}

async function drawChart(q) {
  const el = document.getElementById("chart");
  if (!el || !window.LightweightCharts) return;
  if (!historyCache[q.file]) {
    historyCache[q.file] = (await getJSON(`data/history/${q.file}.json`)).candles;
  }
  const candles = historyCache[q.file];
  if (chart) { chart.remove(); chart = null; }

  chart = LightweightCharts.createChart(el, {
    autoSize: true,
    layout: { background: { type: "solid", color: "transparent" }, textColor: cssVar("--ink-3"), fontSize: 11,
      fontFamily: "-apple-system, BlinkMacSystemFont, Inter, sans-serif" },
    grid: { vertLines: { visible: false }, horzLines: { color: cssVar("--chart-grid") } },
    rightPriceScale: { borderVisible: false },
    timeScale: { borderVisible: false, fixLeftEdge: true, fixRightEdge: true },
    crosshair: { mode: 0, vertLine: { labelVisible: false }, horzLine: { labelVisible: true } },
    handleScale: false, handleScroll: false,
  });

  const up = cssVar("--up-mark"), down = cssVar("--down-mark");
  let main;
  if (state.chartType === "candles") {
    main = chart.addCandlestickSeries({ upColor: up, downColor: down, wickUpColor: up, wickDownColor: down,
      borderVisible: false, priceLineVisible: false });
    main.setData(candles.map((c) => ({ time: c[0], open: c[1], high: c[2], low: c[3], close: c[4] })));
  } else {
    const lineColor = cssVar("--ink");
    main = chart.addAreaSeries({ lineColor, lineWidth: 2, topColor: lineColor + "22", bottomColor: lineColor + "00",
      priceLineVisible: false, crosshairMarkerRadius: 4 });
    main.setData(candles.map((c) => ({ time: c[0], value: c[4] })));
  }
  liveChart = { symbol: q.symbol, main, candles, type: state.chartType };
  const lineOpts = { lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false };
  const s50 = chart.addLineSeries({ ...lineOpts, color: cssVar("--sma50") });
  const s200 = chart.addLineSeries({ ...lineOpts, color: cssVar("--sma200") });
  s50.setData(sma(candles, 50));
  s200.setData(sma(candles, 200));

  // Show the chosen time range.
  const days = { "1M": 31, "3M": 92, "6M": 183, "1Y": 366, "2Y": 732 }[state.range];
  const last = new Date(candles[candles.length - 1][0]);
  const from = new Date(last.getTime() - days * 86400000).toISOString().slice(0, 10);
  chart.timeScale().setVisibleRange({ from, to: candles[candles.length - 1][0] });

  // Values under your finger.
  const readout = document.getElementById("readout");
  chart.subscribeCrosshairMove((p) => {
    const d = p.time && p.seriesData.get(main);
    if (!d) { readout.textContent = "Touch the chart to see values."; return; }
    const a = p.seriesData.get(s50), b = p.seriesData.get(s200);
    const price = d.close ?? d.value;
    const ohlc = d.open != null ? `O ${fmtPrice(d.open)} H ${fmtPrice(d.high)} L ${fmtPrice(d.low)} ` : "";
    readout.textContent = `${p.time} · ${ohlc}Close ${fmtPrice(price, q.currency)}` +
      (a ? ` · 50d ${fmtPrice(a.value)}` : "") + (b ? ` · 200d ${fmtPrice(b.value)}` : "");
  });
}

// ---------------------------------------------------------------- install hint (iPhone)

function installHint() {
  const isIOS = /iPhone|iPad/.test(navigator.userAgent);
  const standalone = window.navigator.standalone || matchMedia("(display-mode: standalone)").matches;
  let dismissed = false;
  try { dismissed = localStorage.getItem("installHintDismissed") === "1"; } catch (e) { /* private mode */ }
  if (!isIOS || standalone || dismissed) return "";
  return `<div class="install" id="install">📲 <div><b>Install as an app:</b> tap the Share button
    <span aria-hidden="true">⬆️</span> below, then <b>Add to Home Screen</b>.</div>
    <button aria-label="Hide" id="install-x">✕</button></div>`;
}

// ---------------------------------------------------------------- live prices
// Crypto: Coinbase sends every price change for free (no account).
// US stocks: Finnhub sends live trades when you have a free key (FINNHUB_API_KEY secret).
// Each new price updates the numbers on screen and the last bar of the open chart.

const live = { prices: {}, sockets: {}, retry: {} };
let liveChart = null;

// Current price and change for a quote, using the live price when we have one.
function current(q) {
  const L = live.prices[q.symbol];
  if (!L) return { price: q.last, chg: q.change_1d };
  const tickDay = new Date(L.ts).toISOString().slice(0, 10);
  const base = tickDay === q.last_date ? q.prev_close : q.last;  // compare with yesterday's close
  return { price: L.price, chg: base ? (L.price / base - 1) * 100 : null };
}
const livePrice = (q, withCurrency = true) =>
  `<span data-lp="${esc(q.symbol)}">${fmtPrice(current(q).price, withCurrency ? q.currency : "")}</span>`;
const livePill = (q) => `<span data-lpill="${esc(q.symbol)}">${pill(current(q).chg)}</span>`;
const liveChange = (q) => {
  const c = current(q).chg;
  return `<span data-lchg="${esc(q.symbol)}" class="${dir(c)}-text">${arrow(c)} ${fmtPct(c)}</span>`;
};

const pending = new Set();
function onTick(symbol, price, ts) {
  if (!price) return;
  const prev = live.prices[symbol]?.price;
  live.prices[symbol] = { price, ts, prev };
  if (!pending.size) requestAnimationFrame(paint);  // update the screen at most once per frame
  pending.add(symbol);
  updateChart(symbol, price, ts);
}

function paint() {
  for (const sym of pending) {
    const q = quoteFor(sym);
    if (!q) continue;
    const { price, prev } = live.prices[sym];
    const flash = prev == null || price === prev ? "" : price > prev ? "flash-up" : "flash-down";
    const sel = (attr) => document.querySelectorAll(`[${attr}="${CSS.escape(sym)}"]`);
    sel("data-lp").forEach((el) => {
      el.textContent = fmtPrice(price, el.closest(".chip") ? "" : q.currency);
      if (flash) { el.classList.remove("flash-up", "flash-down"); void el.offsetWidth; el.classList.add(flash); }
    });
    sel("data-lpill").forEach((el) => { el.innerHTML = pill(current(q).chg); });
    sel("data-lchg").forEach((el) => { const c = current(q).chg; el.className = `${dir(c)}-text`; el.textContent = `${arrow(c)} ${fmtPct(c)}`; });
    sel("data-livetag").forEach((el) => { el.textContent = "● LIVE"; });
  }
  pending.clear();
  const dot = document.getElementById("live-dot");
  if (dot) dot.hidden = !Object.keys(live.prices).length;
}

function updateChart(symbol, price, ts) {
  if (!liveChart || liveChart.symbol !== symbol) return;
  const day = new Date(ts).toISOString().slice(0, 10);
  const c = liveChart.candles;
  const last = c[c.length - 1];
  if (last[0] === day) {
    last[4] = price; last[2] = Math.max(last[2], price); last[3] = Math.min(last[3], price);
  } else if (day > last[0]) {
    c.push([day, price, price, price, price, 0]);
  } else return;
  const bar = c[c.length - 1];
  liveChart.main.update(liveChart.type === "candles"
    ? { time: bar[0], open: bar[1], high: bar[2], low: bar[3], close: bar[4] }
    : { time: bar[0], value: bar[4] });
}

function connect(name, url, onOpen, onMessage) {
  if (live.sockets[name] || document.visibilityState === "hidden") return;
  const ws = new WebSocket(url);
  live.sockets[name] = ws;
  ws.onopen = () => { live.retry[name] = 0; onOpen(ws); };
  ws.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch (err) { /* ignore bad messages */ } };
  ws.onclose = () => {
    delete live.sockets[name];
    if (document.visibilityState === "hidden") return;
    const wait = Math.min(60, 2 ** (live.retry[name] = (live.retry[name] || 0) + 1));  // back off: 2, 4, 8 … 60 s
    setTimeout(() => connect(name, url, onOpen, onMessage), wait * 1000);
  };
}

function startLive() {
  const quotes = state.data.quotes;
  const crypto = quotes.filter((q) => q.live === "coinbase").map((q) => q.symbol);
  if (crypto.length) {
    connect("coinbase", "wss://ws-feed.exchange.coinbase.com",
      (ws) => ws.send(JSON.stringify({ type: "subscribe", product_ids: crypto, channels: ["ticker"] })),
      (m) => { if (m.type === "ticker") onTick(m.product_id, parseFloat(m.price), Date.parse(m.time) || Date.now()); });
  }
  const key = state.data.live?.finnhub_key;
  const us = quotes.filter((q) => q.live === "finnhub").map((q) => q.symbol);
  if (key && us.length) {
    connect("finnhub", `wss://ws.finnhub.io?token=${encodeURIComponent(key)}`,
      (ws) => us.forEach((sym) => ws.send(JSON.stringify({ type: "subscribe", symbol: sym }))),
      (m) => {
        if (m.type !== "trade") return;
        const latest = {};
        for (const t of m.data || []) if (!latest[t.s] || t.t > latest[t.s].t) latest[t.s] = t;
        Object.values(latest).forEach((t) => onTick(t.s, t.p, t.t));
      });
  }
}
function stopLive() {
  Object.values(live.sockets).forEach((ws) => ws.close());
}

// ---------------------------------------------------------------- watchlist editor
// Changes are saved to config/watchlist.yaml in your GitHub repository, using a
// GitHub key that is stored only on this device. Saving starts the Dashboard
// workflow, so new symbols show up after about 2 minutes.

const REPO = (() => {
  const m = location.hostname.match(/^([^.]+)\.github\.io$/);
  const path = location.pathname.split("/").filter(Boolean)[0];
  return m && path ? { owner: m[1], name: path } : { owner: "kingsley3r", name: "stock-analyzer" };
})();
const ghKey = {
  get() { try { return localStorage.getItem("ghKey") || ""; } catch (e) { return ""; } },
  set(v) { try { v ? localStorage.setItem("ghKey", v) : localStorage.removeItem("ghKey"); } catch (e) { /* ignore */ } },
};

const MARKETS = { us: "🇺🇸 US stock", europe: "🇪🇺 Europe stock", crypto: "₿ Crypto", index: "📊 Index" };

function startEditing() {
  const w = state.data.watchlist || {};
  const list = [];
  (w.indices || []).forEach((i) => list.push({ ...i, market: "index" }));
  (w.stocks || []).forEach((i) => list.push({ ...i, market: (i.tags || []).includes("europe") ? "europe" : "us" }));
  (w.crypto || []).forEach((i) => list.push({ ...i, market: "crypto" }));
  state.draft = list.map((i) => ({ ...i, symbol: String(i.symbol) }));
  state.editing = true; state.flash = ""; state.editError = "";
  render();
}

function pageEditWatchlist() {
  const items = state.draft;
  const group = (m) => items.filter((i) => i.market === m);
  const block = (m) => group(m).length ? `<h2 class="section-title">${MARKETS[m]}</h2><div class="list">${group(m).map((i) => `
      <div class="row edit-row">${logo(i.symbol, i.name, "sm")}<div class="who"><div class="t">${esc(i.name || i.symbol)}</div><div class="s">${esc(i.symbol)}</div></div>
      <button class="remove" data-remove="${esc(i.symbol)}" aria-label="Remove ${esc(i.symbol)}">✕</button></div>`).join("")}</div>` : "";
  return `
    <div class="edit-bar"><b>✏️ Edit watchlist</b><button class="pill-btn" data-act="cancel">Cancel</button></div>
    ${state.flash ? `<div class="card notice">${esc(state.flash)}</div>` : ""}
    <form class="card add-form" id="add-form" autocomplete="off">
      <label class="k" for="add-search">➕ Add a stock, coin or index</label>
      <div class="search-wrap">
        <input id="add-search" type="search" placeholder="🔎 Type a name or symbol, e.g. Netflix, BMW, XRP" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="search">
        <div id="suggest" class="suggest" role="listbox" hidden></div>
      </div>
      <p class="hint">Tap a result to add it. Not listed? Type the exact Yahoo Finance symbol
        (e.g. BMW.DE, XRP-USD) and pick “Add as typed”.</p>
    </form>
    ${state.editError ? `<p class="lock-error" style="margin:10px 4px 0">${esc(state.editError)}</p>` : ""}
    ${block("us")}${block("europe")}${block("crypto")}${block("index")}
    <div class="card save-card">
      ${keyField()}
      <button class="primary" data-act="save" ${state.saving ? "disabled" : ""}>${state.saving ? "Saving…" : "💾 Save changes"}</button>
    </div>`;
}

function toYaml(items) {
  const line = (i) => {
    const parts = [`symbol: ${JSON.stringify(i.symbol)}`, `name: ${JSON.stringify(i.name || i.symbol)}`];
    const tags = (i.tags || []).filter((t) => t !== "europe");
    if (i.market === "europe") tags.push("europe");
    if (tags.length && (i.market === "us" || i.market === "europe")) parts.push(`tags: [${tags.map((t) => JSON.stringify(t)).join(", ")}]`);
    return `  - { ${parts.join(", ")} }`;
  };
  const sect = (key, ms) => {
    const rows = items.filter((i) => ms.includes(i.market)).map(line);
    return rows.length ? `${key}:\n${rows.join("\n")}\n` : `${key}: []\n`;
  };
  return `# Your watchlist. Last edited in the app on ${new Date().toISOString().slice(0, 10)}.
# Symbols use Yahoo Finance format: AAPL, SAP.DE, ASML.AS, BTC-USD, ^GSPC.
# You can edit it in the app (Watchlist > Edit list) or here.

${sect("indices", ["index"])}
${sect("stocks", ["us", "europe"])}
${sect("crypto", ["crypto"])}`;
}

// Saves one file in the repository with your GitHub key (creates it if it doesn't exist yet).
async function ghSave(path, text, message, token) {
  const url = `https://api.github.com/repos/${REPO.owner}/${REPO.name}/contents/${path}`;
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" };
  const cur = await fetch(`${url}?ref=main`, { headers, cache: "no-store" });
  if (cur.status === 401) throw new Error("GitHub didn't accept the key. Check it was copied completely.");
  if (!cur.ok && cur.status !== 404) throw new Error(`The key can't read the repository (error ${cur.status}). Check it has access to ${REPO.name}.`);
  const sha = cur.ok ? (await cur.json()).sha : undefined;
  const bytes = new TextEncoder().encode(text);
  const content = btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
  const put = await fetch(url, { method: "PUT", headers, body: JSON.stringify({ message, content, sha, branch: "main" }) });
  if (put.status === 403 || put.status === 404) throw new Error("The key can read but not save. Give it “Contents: Read and write” permission.");
  if (!put.ok) throw new Error(`Saving failed (error ${put.status}). Try again in a minute.`);
}

function keyField() {
  return ghKey.get() ? `<p class="hint">🔑 GitHub key saved on this device · <button type="button" class="link" data-act="forget-key">remove</button></p>`
    : `<label class="k" for="gh-key">🔑 Your GitHub key (needed once, stays on this phone)</label>
       <input id="gh-key" type="password" placeholder="github_pat_…" autocomplete="off">
       <p class="hint">How to create it: see “Edit the watchlist in the app” in the README.</p>`;
}

// ---------------------------------------------------------------- settings page
function pageSettings() {
  const pa = priceAlertCfg();
  const a = { enabled: true, quiet_enabled: true, quiet_from: "23:00", quiet_to: "07:00", quiet_mode: "silent", ...(state.data.alerts || {}) };
  const t = (v) => typeof v === "number" ? `${String(Math.floor(v / 60) % 24).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}` : String(v).padStart(5, "0");
  const toggle = (id, on, label, hint) => `<label class="toggle-row"><span><b>${label}</b>${hint ? `<span class="hint">${hint}</span>` : ""}</span>
    <input type="checkbox" id="${id}" ${on ? "checked" : ""}><span class="switch" aria-hidden="true"></span></label>`;
  return `
    ${pushCard()}
    <h2 class="section-title">🚨 News alerts</h2>
    <form class="card settings" id="settings-form">
      ${toggle("al-on", a.enabled, "Send news alerts", "Important news about your stocks and coins, checked every 15 minutes.")}
      <div class="sep"></div>
      ${toggle("al-quiet", a.quiet_enabled, "🌙 Quiet time", "No notifications in this time (Istanbul time), except the morning digest.")}
      <div class="quiet-box" ${a.quiet_enabled ? "" : "hidden"}>
        <div class="time-row"><label>From <input type="time" id="al-from" value="${esc(t(a.quiet_from))}" step="300"></label>
          <label>To <input type="time" id="al-to" value="${esc(t(a.quiet_to))}" step="300"></label></div>
        <label class="k" for="al-mode">During quiet time</label>
        <select id="al-mode">
          <option value="silent" ${a.quiet_mode !== "skip" ? "selected" : ""}>🔕 Inbox only, no notification</option>
          <option value="skip" ${a.quiet_mode === "skip" ? "selected" : ""}>⛔ Skip them completely</option>
        </select>
      </div>
    </form>

    <h2 class="section-title">🚀 Big-move alerts</h2>
    <div class="card settings">
      ${toggle("pa-on", pa.moves_enabled, "Alert me on big daily moves", "For every stock and coin on your watchlist.")}
      <div class="time-row">
        <label>Stocks move more than (%) <input type="number" id="pa-stock" min="1" max="50" step="0.5" value="${esc(pa.move_pct)}"></label>
        <label>Coins move more than (%) <input type="number" id="pa-coin" min="1" max="50" step="0.5" value="${esc(pa.crypto_move_pct)}"></label>
      </div>
      <p class="hint">Price targets for single stocks: open the stock and use 🔔 Price alerts.
        ${pa.targets.length ? `You have ${pa.targets.length}: ${pa.targets.map((a) => `${esc(a.symbol)} ${"above" in a ? "above" : "below"} ${esc(a.above ?? a.below)}`).join(", ")}.` : ""}</p>
    </div>
    ${state.editError ? `<p class="lock-error" style="margin:10px 4px 0">${esc(state.editError)}</p>` : ""}
    ${state.flash ? `<div class="card notice">${esc(state.flash)}</div>` : ""}
    <div class="card save-card">${keyField()}
      <button class="primary" data-act="save-settings" ${state.saving ? "disabled" : ""}>${state.saving ? "Saving…" : "💾 Save settings"}</button>
    </div>
    <p class="disclaimer">Changes apply from the next check, within about 15 minutes.</p>`;
}

async function saveSettings() {
  const typed = document.getElementById("gh-key")?.value.trim();
  if (typed) ghKey.set(typed);
  const token = ghKey.get();
  const cfg = {
    enabled: document.getElementById("al-on").checked,
    quiet_enabled: document.getElementById("al-quiet").checked,
    quiet_from: document.getElementById("al-from").value || "23:00",
    quiet_to: document.getElementById("al-to").value || "07:00",
    quiet_mode: document.getElementById("al-mode").value,
  };
  state.data.alerts = { ...(state.data.alerts || {}), ...cfg };  // keep the form as typed
  const paIn = { on: document.getElementById("pa-on").checked,
    stock: Number(document.getElementById("pa-stock").value) || 5, coin: Number(document.getElementById("pa-coin").value) || 8 };
  state.data.price_alerts = { ...priceAlertCfg(), moves_enabled: paIn.on, move_pct: paIn.stock, crypto_move_pct: paIn.coin };
  if (!token) { state.editError = "Please paste your GitHub key first."; render(); return; }
  state.saving = true; state.editError = ""; state.flash = ""; render();
  const yaml = `# News alert settings, saved from the app (⚙️ Settings) on ${new Date().toISOString().slice(0, 10)}.
# Times are Istanbul time. quiet_mode: silent = inbox only, no notification; skip = not saved.
enabled: ${cfg.enabled}
quiet_enabled: ${cfg.quiet_enabled}
quiet_from: "${cfg.quiet_from}"
quiet_to: "${cfg.quiet_to}"
quiet_mode: ${cfg.quiet_mode}
`;
  try {
    await ghSave("config/alerts.yaml", yaml, "Update alert settings from the app", token);
    const pa = { ...priceAlertCfg(), moves_enabled: paIn.on, move_pct: paIn.stock, crypto_move_pct: paIn.coin };
    await ghSave("config/price_alerts.json", await sealForRepo({ ...pa, targets: pa.targets.map(({ fired, ...a }) => a) }),
      "Update price alerts from the app", token);
    state.data.price_alerts = pa;
    state.flash = "✅ Saved. Alerts follow the new settings within about 15 minutes.";
  } catch (e) {
    state.editError = e.message || "Saving failed. Check your internet connection.";
  } finally {
    state.saving = false;
    render();
  }
}

view.addEventListener("change", (e) => {
  if (e.target.id === "al-quiet") document.querySelector(".quiet-box").hidden = !e.target.checked;
});

async function saveWatchlist() {
  const typed = document.getElementById("gh-key")?.value.trim();
  if (typed) ghKey.set(typed);
  const token = ghKey.get();
  if (!token) { state.editError = "Please paste your GitHub key first."; render(); return; }
  state.saving = true; state.editError = ""; render();
  try {
    await ghSave("config/watchlist.yaml", toYaml(state.draft), "Update watchlist from the app", token);
    // Show the edited list right away; prices for new symbols come with the next update.
    state.data.watchlist = {
      indices: state.draft.filter((i) => i.market === "index"),
      stocks: state.draft.filter((i) => i.market === "us" || i.market === "europe"),
      crypto: state.draft.filter((i) => i.market === "crypto"),
    };
    state.editing = false;
    state.flash = "✅ Saved. New symbols appear in about 2 minutes (tap ↻ then).";
  } catch (e) {
    state.editError = e.message || "Saving failed. Check your internet connection.";
  } finally {
    state.saving = false;
    render();
  }
}

// ------------------------------------------------ watchlist search dropdown
// Typing shows matches from the built-in list (symbols.js) right away, then
// adds more from Finnhub's symbol search when a Finnhub key is set.

const EU_SUFFIX = ["DE", "AS", "PA", "MI", "MC", "L", "SW", "VI", "BR", "LS", "ST", "CO", "HE", "OL", "IR"];
const MARKET_TAG = { us: "🇺🇸 US", europe: "🇪🇺 EU", crypto: "₿ Crypto", index: "📊 Index" };

function guessMarket(symbol) {
  if (symbol.startsWith("^")) return "index";
  if (/-(USD|EUR|USDT)$/.test(symbol)) return "crypto";
  const dot = symbol.lastIndexOf(".");
  return dot > 0 && EU_SUFFIX.includes(symbol.slice(dot + 1)) ? "europe" : "us";
}

function localMatches(q) {
  const Q = q.toUpperCase(), words = q.toLowerCase();
  const scored = [];
  for (const [symbol, name, market] of window.SYMBOLS || []) {
    const S = symbol.toUpperCase(), n = name.toLowerCase();
    let score = 0;
    if (S === Q || S.replace(/^\^/, "").split(/[.-]/)[0] === Q) score = 100;
    else if (S.startsWith(Q)) score = 80;
    else if (n.startsWith(words)) score = 70;
    else if (n.split(/[\s()&-]+/).some((w) => w.startsWith(words))) score = 60;
    else if (words.length >= 3 && n.includes(words)) score = 40;
    if (score) scored.push({ symbol, name, market, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.symbol.length - b.symbol.length).slice(0, 8);
}

const finnhubCache = new Map();
async function finnhubMatches(q) {
  const key = state.data?.live?.finnhub_key;
  if (!key || q.length < 2) return [];
  if (finnhubCache.has(q)) return finnhubCache.get(q);
  try {
    const r = await fetch(`https://finnhub.io/api/v1/search?q=${encodeURIComponent(q)}&token=${key}`);
    if (!r.ok) return [];
    const out = [];
    for (const it of (await r.json()).result || []) {
      if (!["Common Stock", "ADR", "ETP", "REIT"].includes(it.type)) continue;
      let symbol = String(it.symbol || "").toUpperCase();
      const dot = symbol.lastIndexOf(".");
      if (dot > 0 && !EU_SUFFIX.includes(symbol.slice(dot + 1))) {
        // US share classes like BRK.B are BRK-B on Yahoo; skip other exchanges.
        if (/^[A-Z]{1,5}\.[A-Z]$/.test(symbol)) symbol = symbol.replace(".", "-"); else continue;
      }
      const name = String(it.description || symbol).toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
      out.push({ symbol, name, market: guessMarket(symbol) });
      if (out.length >= 8) break;
    }
    finnhubCache.set(q, out);
    return out;
  } catch (e) { return []; }
}

let searchSeq = 0;
function showSuggestions(results, q) {
  const box = document.getElementById("suggest");
  if (!box) return;
  const have = new Set(state.draft.map((i) => i.symbol));
  const typed = q.trim().toUpperCase();
  const rows = results.map((r) => `
    <button type="button" class="opt" data-pick="${esc(r.symbol)}" data-name="${esc(r.name)}" data-market="${r.market}" ${have.has(r.symbol) ? "disabled" : ""}>
      ${logo(r.symbol, r.name, "sm")}<span class="who"><span class="t">${esc(r.name)}</span><span class="s">${esc(r.symbol)}</span></span>
      <span class="mk">${have.has(r.symbol) ? "✓ on list" : MARKET_TAG[r.market]}</span>
    </button>`);
  if (/^[\^A-Z0-9][A-Z0-9.\-=^]{0,14}$/.test(typed) && !results.some((r) => r.symbol === typed) && !have.has(typed)) {
    rows.push(`<button type="button" class="opt typed" data-pick="${esc(typed)}" data-name="" data-market="${guessMarket(typed)}">
      <span class="who"><span class="t">➕ Add “${esc(typed)}” as typed</span><span class="s">${MARKET_TAG[guessMarket(typed)]} · checked at the next update</span></span></button>`);
  }
  box.innerHTML = rows.join("") || `<div class="empty-opt">No match yet. Keep typing…</div>`;
  box.hidden = !q.trim();
}

async function runSearch(q) {
  const seq = ++searchSeq;
  const local = localMatches(q.trim());
  showSuggestions(local, q);
  if (q.trim().length < 2) return;
  await new Promise((res) => setTimeout(res, 250));            // wait until typing pauses
  if (seq !== searchSeq) return;
  const remote = await finnhubMatches(q.trim());
  if (seq !== searchSeq) return;
  const seen = new Set(local.map((r) => r.symbol));
  showSuggestions([...local, ...remote.filter((r) => !seen.has(r.symbol))].slice(0, 10), q);
}

view.addEventListener("input", (e) => {
  if (e.target.id === "add-search") runSearch(e.target.value);
});

view.addEventListener("click", (e) => {
  const opt = e.target.closest("[data-pick]");
  if (!opt || !state.editing) return;
  const symbol = opt.dataset.pick;
  if (state.draft.some((i) => i.symbol === symbol)) return;
  state.draft.push({ symbol, name: opt.dataset.name || symbol, market: opt.dataset.market, tags: [] });
  state.editError = "";
  state.flash = `➕ Added ${opt.dataset.name || symbol}. Tap 💾 Save changes when you're done.`;
  render();
  document.getElementById("add-search")?.focus();
});

view.addEventListener("submit", (e) => {
  if (e.target.id !== "add-form") return;
  e.preventDefault();                                           // Enter picks the first result
  document.querySelector("#suggest [data-pick]:not([disabled])")?.click();
});

// ================================================================ new tools
// 💼 Portfolio (your trades, stored only on this phone), 🧪 paper trading,
// 📅 earnings dates and 🔔 price alerts.

const money = (v, cur = "$") => v == null ? "–"
  : `${v < 0 ? "−" : ""}${cur}${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signedMoney = (v, cur = "$") => v == null ? "–" : `${v > 0 ? "+" : ""}${money(v, cur)}`;
const guessCurrency = (sym) => /\.(DE|AS|PA|MI|MC|BR|VI|HE|IR|LS)$/.test(sym) ? "€" : /\.L$/.test(sym) ? "GBp " : /\.CO$/.test(sym) ? "DKK "
  : /\.SW$/.test(sym) ? "CHF " : /\.(ST)$/.test(sym) ? "SEK " : /\.OL$/.test(sym) ? "NOK " : "$";
const todayISO = () => new Date().toLocaleDateString("en-CA", { timeZone: TZ });
const nice = (iso, opts = { weekday: "short", day: "numeric", month: "short" }) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { ...opts, timeZone: "UTC" });

// ---------------------------------------------------------------- portfolio (phone only)
const book = {
  list() { try { return JSON.parse(localStorage.getItem("trades") || "[]"); } catch (e) { return []; } },
  save(l) { try { localStorage.setItem("trades", JSON.stringify(l)); return true; } catch (e) { return false; } },
};

// Turns your trades into holdings (average-cost method) with today's values.
function holdings() {
  const pos = {};
  const trades = book.list().slice().sort((a, b) => (a.date + a.id).localeCompare(b.date + b.id));
  for (const t of trades) {
    const p = pos[t.symbol] ||= { symbol: t.symbol, name: t.name || t.symbol, shares: 0, cost: 0, realized: 0 };
    const n = Number(t.shares), px = Number(t.price), fee = Number(t.fee || 0);
    if (t.side === "sell") {
      const avg = p.shares ? p.cost / p.shares : 0, sold = Math.min(n, p.shares);
      p.realized += sold * (px - avg) - fee;
      p.cost -= sold * avg; p.shares -= sold;
    } else {
      p.shares += n; p.cost += n * px + fee;
    }
  }
  const rows = Object.values(pos).map((p) => {
    const q = quoteFor(p.symbol);
    const cur = q?.currency ?? guessCurrency(p.symbol);
    const c = q ? current(q) : null;
    const last = c?.price ?? null;
    const prev = q && c?.chg != null ? last / (1 + c.chg / 100) : last;
    const value = last != null ? p.shares * last : null;
    return { ...p, q, cur, last, avg: p.shares ? p.cost / p.shares : null, value,
      dayChange: last != null && p.shares ? p.shares * (last - prev) : 0,
      unrealized: value != null ? value - p.cost : null };
  });
  const totals = {};
  for (const r of rows) {
    const t = totals[r.cur] ||= { cur: r.cur, value: 0, cost: 0, day: 0, unrealized: 0, realized: 0, priced: true };
    if (r.shares > 1e-9) {
      if (r.value == null) { t.priced = false; t.value += r.cost; } else t.value += r.value;
      t.cost += r.cost; t.day += r.dayChange; t.unrealized += r.unrealized ?? 0;
    }
    t.realized += r.realized;
  }
  return { open: rows.filter((r) => r.shares > 1e-9).sort((a, b) => (b.value ?? b.cost) - (a.value ?? a.cost)),
    closed: rows.filter((r) => r.shares <= 1e-9), totals: Object.values(totals), trades };
}

function pagePortfolio() {
  const tab = state.pfTab || "mine";
  const seg = `<div class="seg wide" data-seg="pf">
      <button data-v="mine" class="${tab === "mine" ? "on" : ""}">💼 Mine</button>
      <button data-v="div" class="${tab === "div" ? "on" : ""}">💰 Dividends</button>
      <button data-v="paper" class="${tab === "paper" ? "on" : ""}">🧪 Paper</button>
      <button data-v="calc" class="${tab === "calc" ? "on" : ""}">🧮 Calc</button></div>`;
  return seg + (tab === "calc" ? calcView() : tab === "paper" ? paperView() : tab === "div" ? dividendView() : myPortfolio());
}

function myPortfolio() {
  const h = holdings();
  const myTrades = limited("my-trades", h.trades.slice().reverse(), 5, 10);
  const totalCards = h.totals.filter((t) => t.cost || t.realized).map((t) => {
    const pct = t.cost ? t.unrealized / t.cost * 100 : null, dayPct = t.value - t.day ? t.day / (t.value - t.day) * 100 : null;
    return `<div class="card pf-total">
      <div class="k">Total value${h.totals.length > 1 ? ` · ${esc(t.cur.trim())}` : ""}</div>
      <div class="big num">${money(t.value, t.cur)}</div>
      <div class="pf-sub num"><span class="${dir(t.day)}-text">${signedMoney(t.day, t.cur)} (${fmtPct(dayPct)}) today</span></div>
      <div class="pf-grid num">
        <div><span class="k">Profit/loss (open)</span><b class="${dir(t.unrealized)}-text">${signedMoney(t.unrealized, t.cur)}${pct != null ? ` · ${fmtPct(pct)}` : ""}</b></div>
        <div><span class="k">Realized (sold)</span><b class="${dir(t.realized)}-text">${signedMoney(t.realized, t.cur)}</b></div>
      </div>
      ${t.priced ? "" : `<p class="hint">Some holdings aren't on your watchlist, so they're counted at what you paid.</p>`}
    </div>`;
  }).join("");
  const holdingRow = (r) => {
    const inner = `${logo(r.symbol, r.name)}
      <div class="who"><div class="t">${esc(r.name)}</div>
        <div class="s">${+r.shares.toFixed(6)} × avg ${fmtPrice(r.avg, r.cur)}</div></div>
      <div class="price"><div class="p num">${r.value != null ? money(r.value, r.cur) : "no price"}</div>
        ${r.unrealized != null ? `<span class="pill ${dir(r.unrealized)} num">${signedMoney(r.unrealized, r.cur)}</span>` : `<span class="hint">not on watchlist</span>`}</div>`;
    return r.q ? `<a class="row" href="#/s/${r.q.file}">${inner}</a>` : `<div class="row">${inner}</div>`;
  };
  const editing = state.tradeEdit ? h.trades.find((t) => t.id === state.tradeEdit) : null;
  const t = editing || { side: "buy", date: todayISO() };
  const opts = [...new Map([...(state.data.quotes || []).filter((q) => q.group !== "index").map((q) => [q.symbol, q.name]),
    ...(window.SYMBOLS || []).filter((s) => s[2] !== "index").map((s) => [s[0], s[1]])]).entries()];
  return `
    ${totalCards || `<div class="card empty">Add your first trade below. Your portfolio is saved only on this phone.</div>`}
    ${h.open.length ? `<h2 class="section-title">📦 Holdings</h2><div class="list">${h.open.map(holdingRow).join("")}</div>` : ""}

    <h2 class="section-title" id="trade-form-title">${editing ? "✏️ Edit trade" : "➕ Add a trade"}</h2>
    <form class="card settings trade-form" id="trade-form" autocomplete="off">
      <div class="seg wide" data-seg="side">
        <button type="button" data-v="buy" class="${t.side !== "sell" ? "on" : ""}">🟢 Bought</button>
        <button type="button" data-v="sell" class="${t.side === "sell" ? "on" : ""}">🔴 Sold</button></div>
      <input type="hidden" id="tr-side" value="${t.side === "sell" ? "sell" : "buy"}">
      <label class="k">Stock or coin <input id="tr-symbol" list="sym-list" required placeholder="e.g. NVDA, SAP.DE, BTC-USD" value="${esc(t.symbol || "")}" autocapitalize="characters" spellcheck="false"></label>
      <datalist id="sym-list">${opts.map(([s, n]) => `<option value="${esc(s)}">${esc(n)}</option>`).join("")}</datalist>
      <div class="time-row">
        <label>Shares / coins <input id="tr-shares" type="number" inputmode="decimal" step="any" min="0" required value="${esc(t.shares ?? "")}"></label>
        <label>Price each <input id="tr-price" type="number" inputmode="decimal" step="any" min="0" required value="${esc(t.price ?? "")}"></label>
      </div>
      <div class="time-row">
        <label>Date <input id="tr-date" type="date" required value="${esc(t.date)}"></label>
        <label>Fee (optional) <input id="tr-fee" type="number" inputmode="decimal" step="any" min="0" value="${esc(t.fee ?? "")}"></label>
      </div>
      <div class="btn-row"><button type="submit" class="primary">${editing ? "💾 Save changes" : "➕ Add trade"}</button>
        ${editing ? `<button type="button" class="pill-btn" data-act="trade-cancel">Cancel</button>` : ""}</div>
    </form>
    ${state.editError ? `<p class="lock-error" style="margin:10px 4px 0">${esc(state.editError)}</p>` : ""}

    ${h.trades.length ? `<h2 class="section-title">🧾 Your trades</h2><div class="list">${myTrades.items.map((x) => `
      <div class="row edit-row">${logo(x.symbol, x.name, "sm")}
        <div class="who"><div class="t">${x.side === "sell" ? "🔴 Sold" : "🟢 Bought"} ${+Number(x.shares).toFixed(6)} ${esc(x.symbol)}</div>
          <div class="s">${nice(x.date, { day: "numeric", month: "short", year: "numeric" })} · ${fmtPrice(Number(x.price), quoteFor(x.symbol)?.currency ?? guessCurrency(x.symbol))} each</div></div>
        <button class="mv" data-trade-edit="${esc(x.id)}" aria-label="Edit">✏️</button>
        <button class="remove" data-trade-del="${esc(x.id)}" aria-label="Delete">✕</button></div>`).join("")}</div>${myTrades.more}` : ""}

    <div class="card backup">
      <p class="hint">🔒 Your trades are saved only on this phone, never online. Make a backup now and then:</p>
      <div class="btn-row"><button class="pill-btn" data-act="pf-export">⬇️ Save backup file</button>
        <label class="pill-btn">⬆️ Restore<input type="file" id="pf-import" accept="application/json,.json" hidden></label></div>
    </div>`;
}

function paperView() {
  const p = state.data.paper;
  if (!p) return `<div class="card empty">Paper trading starts with the next update.</div>`;
  const r = p.rules;
  const posRow = (x) => {
    const q = quoteFor(x.symbol);
    return `<a class="row" href="${q ? `#/s/${q.file}` : "#/portfolio"}">${logo(x.symbol, x.name)}
      <div class="who"><div class="t">${esc(x.name)}</div><div class="s">${nice(x.entry_date, { day: "numeric", month: "short" })} at ${fmtPrice(x.entry_price, q?.currency ?? "")}</div></div>
      <div class="price"><div class="p num">${money(x.value)}</div><span class="pill ${dir(x.pnl)} num">${signedMoney(x.pnl)} · ${fmtPct(x.pnl_pct)}</span></div></a>`;
  };
  const closed = limited("paper-closed", p.trades, 5, 10);
  const why = { "signal": "SELL signal", "stop-loss": "stop-loss", "take-profit": "take profit" };
  return `
    <div class="card pf-total">
      <div class="k">🧪 Paper account (fake money)</div>
      <div class="big num">${money(p.total)}</div>
      <div class="pf-sub num"><span class="${dir(p.pnl)}-text">${signedMoney(p.pnl)} (${fmtPct(p.pnl_pct)}) since start</span>
        · <span class="${dir(p.day_change)}-text">${signedMoney(p.day_change)} today</span></div>
      <div class="pf-grid num">
        <div><span class="k">Cash</span><b>${money(p.cash)}</b></div>
        <div><span class="k">Invested</span><b>${money(p.invested)}</b></div>
        <div><span class="k">Closed trades</span><b>${p.closed}${p.win_rate != null ? ` · ${p.win_rate}% won` : ""}</b></div>
        <div><span class="k">Started</span><b>${p.started ? nice(p.started, { day: "numeric", month: "short" }) : "–"}</b></div>
      </div>
    </div>
    <p class="hint rules">Rules: start ${money(r.start_cash)}, buy ${money(r.per_trade)} on every 🟢 BUY signal, sell on 🔴 SELL / ⛔ DON'T BUY,
      or automatically at −${r.stop_loss}% (stop-loss) or +${r.take_profit}% (take profit).</p>
    <h2 class="section-title">📦 Open positions</h2>
    ${p.positions.length ? `<div class="list">${p.positions.map(posRow).join("")}</div>` : `<div class="card empty">No open positions. The next 🟢 BUY signal opens one.</div>`}
    ${p.trades.length ? `<h2 class="section-title">🧾 Closed trades</h2><div class="list">${closed.items.map((t) => `
      <div class="row">${logo(t.symbol, t.name, "sm")}
        <div class="who"><div class="t">${esc(t.name)}</div><div class="s">${nice(t.entry_date, { day: "numeric", month: "short" })} → ${nice(t.exit_date, { day: "numeric", month: "short" })} · ${why[t.reason] || t.reason}</div></div>
        <span class="pill ${dir(t.pnl)} num">${signedMoney(t.pnl)} · ${fmtPct(t.pnl_pct)}</span></div>`).join("")}</div>${closed.more}` : ""}
    <p class="disclaimer">Amounts are treated as dollars for every market; currency moves are ignored.</p>`;
}

function saveTrade(e) {
  e.preventDefault();
  const val = (id) => document.getElementById(id).value.trim();
  const symbol = val("tr-symbol").toUpperCase();
  const shares = Number(val("tr-shares")), price = Number(val("tr-price"));
  if (!symbol || !(shares > 0) || !(price > 0)) { state.editError = "Please fill in the symbol, shares and price."; render(); return; }
  const name = quoteFor(symbol)?.name || (window.SYMBOLS || []).find((s) => s[0] === symbol)?.[1] || symbol;
  const trade = { id: state.tradeEdit || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    side: val("tr-side"), symbol, name, shares, price, date: val("tr-date") || todayISO(), fee: Number(val("tr-fee")) || 0 };
  const list = book.list().filter((t) => t.id !== trade.id);
  list.push(trade);
  if (!book.save(list)) { state.editError = "This phone didn't allow saving. Turn off private browsing."; render(); return; }
  state.tradeEdit = null; state.editError = "";
  render();
}

function exportTrades() {
  const blob = new Blob([JSON.stringify({ app: "Market Pulse", saved: new Date().toISOString(), trades: book.list() }, null, 1)],
    { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `market-pulse-portfolio-${todayISO()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function importTrades(file) {
  try {
    const data = JSON.parse(await file.text());
    const trades = Array.isArray(data) ? data : data.trades;
    if (!Array.isArray(trades) || !trades.every((t) => t.symbol && t.shares && t.price)) throw new Error();
    if (!confirm(`Replace your trades on this phone with the ${trades.length} trades from the backup?`)) return;
    book.save(trades);
    state.editError = "";
  } catch (e) { state.editError = "That file isn't a Market Pulse backup."; }
  render();
}

// ---------------------------------------------------------------- earnings
const WHEN_SHORT = { bmo: "before open", amc: "after close", dmh: "during the day" };
function daysUntil(iso) { return Math.round((new Date(`${iso}T12:00:00Z`) - new Date(`${todayISO()}T12:00:00Z`)) / 86400000); }
function whenLabel(ev) {
  const d = daysUntil(ev.date);
  return d === 0 ? "today" : d === 1 ? "tomorrow" : `in ${d} days`;
}

function earningsSection() {
  const soon = (state.data.earnings || []).filter((e) => daysUntil(e.date) >= 0 && daysUntil(e.date) <= 14);
  if (!soon.length) return "";
  const page = limited("earnings", soon, 5, 10);
  return `<h2 class="section-title">📅 Earnings soon</h2><div class="list">${page.items.map((ev) => {
    const q = quoteFor(ev.symbol), d = daysUntil(ev.date);
    return `<a class="row" href="${q ? `#/s/${q.file}` : "#/watchlist"}">${logo(ev.symbol, ev.name)}
      <div class="who"><div class="t">${esc(ev.name)}</div><div class="s">${nice(ev.date)}${WHEN_SHORT[ev.hour] ? ` · ${WHEN_SHORT[ev.hour]}` : ""}</div></div>
      <span class="badge ${d <= 1 ? "hold" : "watch"}">${whenLabel(ev)}</span></a>`;
  }).join("")}</div>${page.more}`;
}

function earningsLine(q) {
  const ev = (state.data.earnings || []).find((e) => e.symbol === q.symbol && daysUntil(e.date) >= 0);
  if (!ev) return "";
  return `<div class="card info-line">📅 <b>Next earnings: ${nice(ev.date, { weekday: "long", day: "numeric", month: "long" })}</b>
    ${WHEN_SHORT[ev.hour] ? `(${WHEN_SHORT[ev.hour]})` : ""} · ${whenLabel(ev)}
    ${typeof ev.eps_estimate === "number" ? `<div class="hint">Analysts expect earnings per share of ${ev.eps_estimate.toFixed(2)}.</div>` : ""}</div>`;
}

// ---------------------------------------------------------------- price alerts
// Saved encrypted with your dashboard password (config/price_alerts.json),
// so your targets stay private in the public repository.
function priceAlertCfg() {
  return { moves_enabled: true, move_pct: 5, crypto_move_pct: 8, targets: [], ...(state.data.price_alerts || {}) };
}

function alertsCard(q) {
  if (q.group === "index") return "";
  const mine = priceAlertCfg().targets.filter((a) => a.symbol === q.symbol);
  const cur = q.currency || "";
  return `<h2 class="section-title">🔔 Price alerts</h2>
    <div class="card settings">
      ${mine.length ? `<div class="list flat">${mine.map((a) => {
        const side = "above" in a ? "above" : "below";
        return `<div class="row edit-row"><div class="who"><div class="t">${side === "above" ? "📈 Above" : "📉 Below"} ${fmtPrice(Number(a[side]), cur)}</div>
          <div class="s">${a.fired ? "✅ Triggered, delete it to set a new one" : "⏳ Waiting"}</div></div>
          <button class="remove" data-alert-del="${esc(q.symbol)}|${side}|${a[side]}" aria-label="Delete alert">✕</button></div>`;
      }).join("")}</div>` : `<p class="hint">Get a notification when ${esc(q.name)} crosses a price you choose.</p>`}
      <form id="alert-form" class="alert-form" data-symbol="${esc(q.symbol)}">
        <select id="al-side"><option value="above">📈 goes above</option><option value="below">📉 goes below</option></select>
        <input id="al-price" type="number" inputmode="decimal" step="any" min="0" required placeholder="${fmtPrice(q.last, "")}">
        <button type="submit" class="primary" ${state.saving ? "disabled" : ""}>${state.saving ? "Saving…" : "🔔 Add"}</button>
      </form>
      ${ghKey.get() ? "" : keyField()}
      ${state.editError ? `<p class="lock-error">${esc(state.editError)}</p>` : ""}
      ${state.flash ? `<p class="hint">${esc(state.flash)}</p>` : ""}
    </div>`;
}

// Encrypts with your password in the same format the server reads (analyzer/lock.py).
async function sealForRepo(obj) {
  const pw = lock.password || savedPassword();
  if (!pw || !lock.info?.v) throw new Error("Unlock the app with your password first.");
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: lock.info.iterations, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(obj))));
  const enc = (u8) => btoa(Array.from(u8, (b) => String.fromCharCode(b)).join(""));
  return JSON.stringify({ v: 1, kdf: "PBKDF2-SHA256", iterations: lock.info.iterations, salt: enc(salt), iv: enc(iv), ct: enc(ct) });
}

async function savePriceAlerts(cfg, okMessage) {
  const typed = document.getElementById("gh-key")?.value.trim();
  if (typed) ghKey.set(typed);
  const token = ghKey.get();
  if (!token) { state.editError = "Please paste your GitHub key first."; render(); return false; }
  state.saving = true; state.editError = ""; state.flash = ""; render();
  try {
    const clean = { ...cfg, targets: cfg.targets.map(({ fired, ...a }) => a) };
    await ghSave("config/price_alerts.json", await sealForRepo(clean), "Update price alerts from the app", token);
    state.data.price_alerts = cfg;
    state.flash = okMessage;
    return true;
  } catch (e) {
    state.editError = e.message || "Saving failed. Check your internet connection.";
    return false;
  } finally { state.saving = false; render(); }
}

view.addEventListener("submit", (e) => {
  if (e.target.id === "trade-form") return saveTrade(e);
  if (e.target.id !== "alert-form") return;
  e.preventDefault();
  const symbol = e.target.dataset.symbol, side = document.getElementById("al-side").value;
  const price = Number(document.getElementById("al-price").value);
  if (!(price > 0)) return;
  const cfg = priceAlertCfg();
  cfg.targets = [...cfg.targets.filter((a) => !(a.symbol === symbol && side in a && Number(a[side]) === price)), { symbol, [side]: price }];
  savePriceAlerts(cfg, "✅ Alert saved. It's checked every 15 minutes.");
});

view.addEventListener("change", (e) => {
  if (e.target.id === "pf-import" && e.target.files[0]) importTrades(e.target.files[0]);
});

view.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.alertDel) {
    const [symbol, side, price] = b.dataset.alertDel.split("|");
    const cfg = priceAlertCfg();
    cfg.targets = cfg.targets.filter((a) => !(a.symbol === symbol && side in a && String(a[side]) === price));
    savePriceAlerts(cfg, "🗑️ Alert deleted.");
  }
  if (b.dataset.tradeDel && confirm("Delete this trade?")) { book.save(book.list().filter((t) => t.id !== b.dataset.tradeDel)); render(); }
  if (b.dataset.tradeEdit) { state.tradeEdit = b.dataset.tradeEdit; render(); document.getElementById("trade-form-title")?.scrollIntoView({ behavior: "smooth" }); }
  if (b.dataset.act === "trade-cancel") { state.tradeEdit = null; render(); }
  if (b.dataset.act === "pf-export") exportTrades();
  const seg = b.closest("[data-seg]");
  if (seg?.dataset.seg === "pf") {
    state.pfTab = b.dataset.v;
    if (location.hash.startsWith("#/calc")) location.hash = "#/portfolio"; else render();
  }
  if (seg?.dataset.seg === "side") {
    document.getElementById("tr-side").value = b.dataset.v;
    seg.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
  }
});

// ---------------------------------------------------------------- inbox (🔔) and iPhone notifications
// Every alert, the morning digest and the evening recap land in data/inbox.json
// (encrypted like everything else). Notifications come through sw.js.

const APP_URL = `${location.origin}${location.pathname.replace(/[^/]*$/, "")}`;
const KIND = {
  digest: ["☀️", "Morning digest"], recap: ["🌙", "Evening recap"], news: ["📰", "News alert"],
  price: ["🎯", "Price alert"], move: ["🚀", "Big move"], earnings: ["📅", "Earnings"], system: ["ℹ️", "Notice"],
};
const inboxSeen = {
  get() { try { return localStorage.getItem("inboxSeen") || ""; } catch (e) { return ""; } },
  set(v) { try { localStorage.setItem("inboxSeen", v); } catch (e) { /* ignore */ } },
};

async function loadInbox() {
  let items = [];
  try { items = (await getJSON("data/inbox.json")).items || []; } catch (e) { items = state.inbox || []; }
  // Messages that just arrived as a notification but aren't in the data files yet.
  try {
    const cache = await caches.open("mp-inbox");
    for (const req of await cache.keys()) {
      if (!req.url.includes("/pushed/")) continue;
      const it = await (await cache.match(req)).json();
      if (items.some((x) => x.id === it.id)) await cache.delete(req); else items.push(it);
    }
  } catch (e) { /* no cache support */ }
  items.sort((a, b) => b.id.localeCompare(a.id));  // ids start with the date and time
  state.inbox = items;
  updateBell();
}

function unreadCount() {
  const seen = inboxSeen.get();
  return (state.inbox || []).filter((i) => i.id > seen).length;
}

function updateBell() {
  const n = unreadCount();
  const el = document.getElementById("bell-count");
  if (el) { el.hidden = !n; el.textContent = n > 9 ? "9+" : String(n); }
  try { n ? navigator.setAppBadge?.(n) : navigator.clearAppBadge?.(); } catch (e) { /* optional */ }
}

function markInboxRead() {
  const newest = state.inbox?.[0]?.id;
  if (newest && newest > inboxSeen.get()) inboxSeen.set(newest);
  window.caches?.open("mp-inbox").then((c) => c.delete("badge")).catch(() => {});
  updateBell();
}

// Only simple formatting from our own messages is shown: bold, italic, links, line breaks.
function safeHtml(src) {
  const tpl = document.createElement("template");
  tpl.innerHTML = String(src || "").replace(/\n/g, "<br>");
  const ok = new Set(["B", "I", "U", "EM", "STRONG", "A", "BR", "BLOCKQUOTE", "CODE"]);
  const clean = (node) => {
    for (const el of [...node.children]) {
      clean(el);
      if (["SCRIPT", "STYLE", "IFRAME", "OBJECT"].includes(el.tagName)) { el.remove(); continue; }
      if (!ok.has(el.tagName)) { el.replaceWith(...el.childNodes); continue; }
      const href = el.getAttribute("href") || "";
      for (const at of [...el.attributes]) el.removeAttribute(at.name);
      if (el.tagName !== "A") continue;
      const h = href.startsWith(APP_URL) ? href.slice(APP_URL.length) : href;
      if (/^#\//.test(h)) el.setAttribute("href", h);
      else if (/^https?:\/\//i.test(h)) { el.setAttribute("href", h); el.target = "_blank"; el.rel = "noopener"; }
    }
  };
  clean(tpl.content);
  return tpl.innerHTML;
}
const plain = (html) => { const d = document.createElement("div"); d.innerHTML = safeHtml(html).replace(/<br>/g, " · "); return d.textContent; };
const itemTime = (it) => new Date(it.ts).toLocaleString("en-GB", { timeZone: TZ, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function pageInbox() {
  const items = state.inbox || [];
  const seen = state.inboxSeenBefore ?? inboxSeen.get();
  const f = state.inboxFilter || "all";
  const shown = items.filter((i) => f === "all" || (f === "reports" ? ["digest", "recap"].includes(i.kind) : !["digest", "recap"].includes(i.kind)));
  const seg = `<div class="seg wide" data-seg="inbox">
      <button data-v="all" class="${f === "all" ? "on" : ""}">All</button>
      <button data-v="alerts" class="${f === "alerts" ? "on" : ""}">🚨 Alerts</button>
      <button data-v="reports" class="${f === "reports" ? "on" : ""}">☀️ Reports</button></div>`;
  const rowHtml = (i) => {
    const [icon] = KIND[i.kind] || KIND.system;
    return `<a class="row inbox-row ${i.id > seen ? "unread" : ""}" href="#/inbox/${encodeURIComponent(i.id)}">
      ${i.symbol ? logo(i.symbol, i.symbol) : `<span class="kind-icon">${icon}</span>`}
      <div class="who"><div class="t">${esc(i.title)}</div><div class="s">${esc(plain(i.html).slice(0, 140))}</div></div>
      <div class="when">${timeAgo(new Date(i.ts).getTime() / 1000)}${i.id > seen ? `<span class="dot-new" aria-label="new"></span>` : ""}</div></a>`;
  };
  // New (unread) messages always show; older ones wait behind "Show more".
  const unread = shown.filter((i) => i.id > seen).length;
  const page = limited(`inbox-${f}`, shown, Math.max(5, unread), 10, true);
  return `${pushNudge()}${seg}
    ${shown.length ? `<div class="list">${page.items.map(rowHtml).join("")}</div>${page.more}`
      : `<div class="card empty">Nothing here yet. Alerts, your morning digest and the evening recap will show up here.</div>`}
    <p class="disclaimer">Messages are kept for 30 days.</p>`;
}

function pageInboxItem(id) {
  const it = (state.inbox || []).find((i) => i.id === id);
  if (!it) return `<a class="back" href="#/inbox">‹ Inbox</a>
    <div class="card empty">This message is on its way. It shows up within a few minutes; tap ↻ to check.</div>`;
  const [icon, label] = KIND[it.kind] || KIND.system;
  const link = (l) => {
    const h = l.url.startsWith(APP_URL) ? l.url.slice(APP_URL.length) : l.url;
    return /^#\//.test(h) ? `<a class="pill-btn" href="${esc(h)}">${esc(l.text)}</a>`
      : /^https?:\/\//i.test(h) ? `<a class="pill-btn" href="${esc(h)}" target="_blank" rel="noopener">${esc(l.text)}</a>` : "";
  };
  return `<a class="back" href="#/inbox">‹ Inbox</a>
    <article class="card message">
      <div class="msg-kind">${icon} ${esc(label)} · ${esc(itemTime(it))}</div>
      <h2>${esc(it.title)}</h2>
      <div class="msg-body">${safeHtml(it.html)}</div>
      ${it.links?.length ? `<div class="btn-row">${it.links.map(link).join("")}</div>` : ""}
    </article>`;
}

// ---- notifications on this phone
const push = {
  supported: () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window,
  isIOS: () => /iPhone|iPad|iPod/.test(navigator.userAgent),
  standalone: () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true,
  saved() { try { return localStorage.getItem("pushSaved") || ""; } catch (e) { return ""; } },
  setSaved(v) { try { v ? localStorage.setItem("pushSaved", v) : localStorage.removeItem("pushSaved"); } catch (e) { /* ignore */ } },
};
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.open) location.hash = e.data.open;
    if (e.data?.pushed) loadInbox().then(() => { if ((location.hash || "").startsWith("#/inbox")) render(); });
  });
}

async function pushStatus() {
  if (!push.supported()) return push.isIOS() && !push.standalone() ? "install" : "unsupported";
  if (Notification.permission === "denied") return "denied";
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub && push.saved() === sub.endpoint && Notification.permission === "granted") return "on";
  } catch (e) { /* treat as off */ }
  return "off";
}

// A small hint on the inbox while notifications are off on this phone.
function pushNudge() {
  if (push.supported() && Notification.permission === "granted" && push.saved()) return "";
  return `<a class="card notice nudge" href="#/settings">📲 Get these as notifications on your iPhone: turn them on in ⚙️ Settings.</a>`;
}

function pushCard() {
  return `<h2 class="section-title">📲 Notifications on this phone</h2>
    <div class="card settings" id="push-card"><p class="hint">Checking…</p></div>`;
}

async function fillPushCard() {
  const el = document.getElementById("push-card");
  if (!el) return;
  const s = await pushStatus();
  const phones = state.data.push?.phones || 0;
  const busy = state.pushBusy ? "disabled" : "";
  el.innerHTML = {
    install: `<p><b>First add the app to your Home Screen.</b></p>
      <p class="hint">iPhones only allow notifications for apps on the Home Screen (iOS 16.4 or newer):
      in Safari tap Share <b>⬆︎</b> › <b>Add to Home Screen</b>, then open Market Pulse from that icon and come back here.</p>`,
    unsupported: `<p class="hint">This browser can't show notifications. On iPhone, use the Market Pulse icon on your Home Screen.</p>`,
    denied: `<p><b>Notifications are blocked.</b></p><p class="hint">Allow them in iPhone Settings › Notifications › Market Pulse, then come back here.</p>`,
    on: `<p><b>✅ On for this phone</b></p>
      <p class="hint">You get the morning digest, news, price and earnings alerts and the evening recap.
      During your quiet time they wait silently in the 🔔 inbox. ${phones > 1 ? `${phones} phones have notifications on.` : ""}</p>
      <div class="btn-row"><button class="pill-btn" data-act="push-off" ${busy}>Turn off</button></div>`,
    off: `<p class="hint">Get the morning digest, alerts and the evening recap as real iPhone notifications.
      Needs your GitHub key once (at the bottom of this page).</p>
      <button class="primary" data-act="push-on" ${busy}>${state.pushBusy ? "Turning on…" : "🔔 Turn on notifications"}</button>`,
  }[s];
}

const b64url = (s) => b64(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
async function shortHash(text) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(d.slice(0, 6), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Deletes one file in the repository with your GitHub key.
async function ghDelete(path, message, token) {
  const url = `https://api.github.com/repos/${REPO.owner}/${REPO.name}/contents/${path}`;
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" };
  const cur = await fetch(`${url}?ref=main`, { headers, cache: "no-store" });
  if (cur.status === 404) return;
  if (!cur.ok) throw new Error(`GitHub error ${cur.status}. Check your key.`);
  const del = await fetch(url, { method: "DELETE", headers, body: JSON.stringify({ message, sha: (await cur.json()).sha, branch: "main" }) });
  if (!del.ok) throw new Error(`Removing failed (error ${del.status}).`);
}

async function enablePush(permission) {
  const typed = document.getElementById("gh-key")?.value.trim();
  if (typed) ghKey.set(typed);
  const token = ghKey.get();
  state.editError = ""; state.flash = "";
  try {
    if ((await permission) !== "granted") throw new Error("Notifications weren't allowed. You can allow them in iPhone Settings › Notifications › Market Pulse.");
    if (!token) throw new Error("Please paste your GitHub key at the bottom of this page first, then tap the button again.");
    const key = state.data.push?.key;
    if (!key) throw new Error("Notifications aren't ready yet. Try again after the next update (within 15 minutes).");
    state.pushBusy = true; fillPushCard();
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    const wanted = b64url(key);
    const has = sub?.options?.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
    if (sub && has && has.join() !== wanted.join()) { await sub.unsubscribe(); sub = null; }
    sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: wanted });
    const json = sub.toJSON();
    await ghSave(`config/push/${await shortHash(json.endpoint)}.json`,
      await sealForRepo({ endpoint: json.endpoint, keys: json.keys, added: new Date().toISOString() }),
      "Turn on notifications for a phone", token);
    push.setSaved(json.endpoint);
    state.flash = "✅ Notifications are on. A test notification arrives in about 3 minutes.";
  } catch (e) {
    state.editError = e.message || "That didn't work. Try again.";
  } finally {
    state.pushBusy = false; render();
  }
}

async function disablePush() {
  const token = ghKey.get();
  state.editError = ""; state.flash = ""; state.pushBusy = true; fillPushCard();
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      if (token) await ghDelete(`config/push/${await shortHash(sub.endpoint)}.json`, "Turn off notifications for a phone", token);
      await sub.unsubscribe();
    }
    push.setSaved("");
    state.flash = "🔕 Notifications are off for this phone. Everything still lands in the 🔔 inbox.";
  } catch (e) {
    state.editError = e.message || "That didn't work. Try again.";
  } finally { state.pushBusy = false; render(); }
}

view.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  // Ask for permission right away: iPhones only allow it directly after a tap.
  if (b.dataset.act === "push-on") enablePush(Notification.requestPermission());
  if (b.dataset.act === "push-off") disablePush();
  const seg = b.closest("[data-seg]");
  if (seg?.dataset.seg === "inbox") { state.inboxFilter = b.dataset.v; render(); }
});

// ---------------------------------------------------------------- dividend planner
// Uses your trades (on this phone) and the dividend history of your watchlist
// stocks (data.dividends). The next 12 months repeat last year's payments at the
// latest amount, unless the company already announced the next date.

const addDays = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
const FREQ = { 12: "monthly", 4: "quarterly", 3: "3× a year", 2: "twice a year", 1: "yearly" };

function dividendPlan() {
  const divs = state.data.dividends || {};
  const today = todayISO(), end = addDays(today, 365);
  const payments = [], perHolding = [], none = [], missing = [];
  for (const r of holdings().open) {
    if (isCrypto(r.symbol)) continue;
    const d = divs[r.symbol];
    if (!d) { (quoteFor(r.symbol) ? none : missing).push(r); continue; }
    const hist = d.history || [];
    const lastYear = hist.filter(([dt]) => dt > addDays(today, -365));
    const latest = hist.length ? hist[hist.length - 1][1] : 0;
    const lag = d.next_ex && d.next_pay ? Math.max(0, daysBetween(d.next_ex, d.next_pay)) : (/\.[A-Z]+$/.test(r.symbol) ? 3 : 14);
    let plan = lastYear.map(([dt]) => ({ ex: addDays(dt, 365), amount: latest, est: true }));
    // Already past the ex-date but not paid yet: you get this one too.
    hist.filter(([dt]) => dt <= today && addDays(dt, lag) >= today).forEach(([dt, amt]) => plan.push({ ex: dt, amount: amt, est: !d.next_pay }));
    if (d.next_ex && d.next_ex >= today) {
      const known = { ex: d.next_ex, pay: d.next_pay, amount: latest, est: false };
      const i = plan.findIndex((p) => p.est && Math.abs(daysBetween(p.ex, d.next_ex)) < 45);
      if (i >= 0) plan[i] = known; else plan.push(known);
    }
    if (!plan.length || !latest) { none.push(r); continue; }
    let year = 0;
    for (const p of plan) {
      const pay = p.pay && p.pay >= p.ex ? p.pay : addDays(p.ex, lag);
      if (pay < today || pay > end) continue;
      const total = p.amount * r.shares;
      year += total;
      payments.push({ r, ex: p.ex, pay, perShare: p.amount, total, est: p.est });
    }
    perHolding.push({ r, year, freq: FREQ[lastYear.length] || `${lastYear.length}× a year`,
      yieldNow: r.last ? (latest * lastYear.length) / r.last * 100 : null,
      yieldCost: r.avg ? (latest * lastYear.length) / r.avg * 100 : null });
  }
  payments.sort((a, b) => a.pay.localeCompare(b.pay));
  return { payments, perHolding: perHolding.sort((a, b) => b.year - a.year), none, missing };
}

function dividendView() {
  const tax = Number(state.data.dividend_cfg?.tax_pct ?? 27.5);
  const { payments, perHolding, none, missing } = dividendPlan();
  if (!holdings().open.length) return `<div class="card empty">Add your trades under 💼 My portfolio first. Then you see the dividends you can expect here.</div>`;
  const byCur = {};
  payments.forEach((p) => { (byCur[p.r.cur] ||= { cur: p.r.cur, total: 0, cost: 0 }).total += p.total; });
  perHolding.forEach((h) => { if (byCur[h.r.cur]) byCur[h.r.cur].cost += h.r.cost; });
  const curs = Object.values(byCur).sort((a, b) => b.total - a.total);
  const main = curs[0];
  const months = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(`${todayISO().slice(0, 7)}-15T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + i);
    return d.toISOString().slice(0, 7);
  });
  const perMonth = months.map((m) => payments.filter((p) => p.r.cur === main?.cur && p.pay.startsWith(m)).reduce((s, p) => s + p.total, 0));
  const max = Math.max(...perMonth, 0.0001);
  const nextPay = limited("div-payments", payments, 5, 10);
  const totals = curs.map((c) => `<div class="card pf-total">
      <div class="k">💰 Expected dividends · next 12 months${curs.length > 1 ? ` · ${esc(c.cur.trim())}` : ""}</div>
      <div class="big num">${money(c.total, c.cur)}</div>
      <div class="pf-sub num">≈ ${money(c.total / 12, c.cur)} a month on average</div>
      <div class="pf-grid num">
        <div><span class="k">After ${tax}% tax (estimate)</span><b>${money(c.total * (1 - tax / 100), c.cur)}</b></div>
        <div><span class="k">Yield on what you paid</span><b>${c.cost ? `${(c.total / c.cost * 100).toFixed(2)}%` : "–"}</b></div>
      </div></div>`).join("");
  const chart = main ? `<h2 class="section-title">📊 Per month${curs.length > 1 ? ` (${esc(main.cur.trim())})` : ""}</h2>
    <div class="card div-chart">${months.map((m, i) => `<div class="bar-col" title="${money(perMonth[i], main.cur)}">
        <span class="bar-val num">${perMonth[i] ? money(perMonth[i], main.cur).replace(/\.\d\d$/, "") : ""}</span>
        <span class="bar" style="height:${Math.round(perMonth[i] / max * 100)}%"></span>
        <span class="bar-m">${new Date(`${m}-15T12:00:00Z`).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" })}</span></div>`).join("")}</div>` : "";
  const payRow = (p) => `<a class="row" href="${p.r.q ? `#/s/${p.r.q.file}` : "#/portfolio"}">${logo(p.r.symbol, p.r.name)}
      <div class="who"><div class="t">${esc(p.r.name)}</div>
        <div class="s wrap">Paid ${p.est ? "≈ " : ""}${nice(p.pay)} · ex-date ${nice(p.ex, { day: "numeric", month: "short" })}</div></div>
      <div class="price"><div class="p num">${money(p.total, p.r.cur)}</div>
        <span class="hint num">${money(p.perShare, p.r.cur)} × ${+p.r.shares.toFixed(4)}${p.est ? " · est." : ""}</span></div></a>`;
  const holdRow = (h) => `<div class="row">${logo(h.r.symbol, h.r.name, "sm")}
      <div class="who"><div class="t">${esc(h.r.name)}</div>
        <div class="s wrap">Pays ${h.freq}${h.yieldNow != null ? ` · yield ${h.yieldNow.toFixed(2)}%` : ""}${h.yieldCost != null ? ` · ${h.yieldCost.toFixed(2)}% on your cost` : ""}</div></div>
      <div class="price"><div class="p num">${money(h.year, h.r.cur)}</div><span class="hint">a year</span></div></div>`;
  return `${totals || `<div class="card empty">None of your holdings is expected to pay a dividend in the next 12 months.</div>`}
    ${chart}
    ${payments.length ? `<h2 class="section-title">📅 Next payments</h2><div class="list">${nextPay.items.map(payRow).join("")}</div>${nextPay.more}` : ""}
    ${perHolding.length ? `<h2 class="section-title">📦 Per holding</h2><div class="list">${perHolding.map(holdRow).join("")}</div>` : ""}
    ${none.length ? `<p class="hint rules">No dividends: ${none.map((r) => esc(r.name)).join(", ")}.</p>` : ""}
    ${missing.length ? `<p class="hint rules">⚠️ Add ${missing.map((r) => esc(r.symbol)).join(", ")} to your watchlist to see ${missing.length > 1 ? "their" : "its"} dividends.</p>` : ""}
    <p class="disclaimer">Estimates from the last 12 months of payments; companies can raise, cut or skip dividends.
      Ex-date: you must own the shares before that day to get the payment. Amounts are before tax;
      the after-tax figure uses ${tax}% (Austrian KESt). Change it in config/settings.yaml.</p>`;
}

function dividendLine(q) {
  const d = (state.data.dividends || {})[q.symbol];
  if (!d?.history?.length) return "";
  const today = todayISO();
  const lastYear = d.history.filter(([dt]) => dt > addDays(today, -365));
  const latest = d.history[d.history.length - 1][1];
  const yearly = latest * lastYear.length;
  return `<div class="card info-line">💰 <b>Dividend: ${money(latest, q.currency || "")} ${FREQ[lastYear.length] || ""}</b>
    ${q.last && yearly ? ` · yield ${(yearly / q.last * 100).toFixed(2)}%` : ""}
    ${d.next_ex && d.next_ex >= today ? `<div class="hint">Next: own it before ${nice(d.next_ex)}${d.next_pay ? `, paid ${nice(d.next_pay)}` : ""}.</div>` : ""}</div>`;
}

// ---------------------------------------------------------------- ⚖️ compare
// Put 2 to 4 symbols side by side: one chart where every line starts at 0%
// (so a $4 stock and a $400 stock can be compared fairly), then a table with
// their numbers next to each other. 🏆 marks the better value in each row.
// The address holds the choice (#/compare/NVDA,AMD), so you can bookmark it.

const CMP_MAX = 4;
const CMP_COLORS = ["--cmp1", "--cmp2", "--cmp3", "--cmp4"];
const RANGE_DAYS = { "1M": 31, "3M": 92, "6M": 183, "1Y": 366, "2Y": 732 };

const cmpSaved = {
  get() { try { return JSON.parse(localStorage.getItem("compare") || "[]"); } catch (e) { return []; } },
  set(l) { try { localStorage.setItem("compare", JSON.stringify(l)); } catch (e) { /* ignore */ } },
};

// Which symbols to compare: from the address, else the last ones you compared.
function compareList(arg) {
  let files = arg ? decodeURIComponent(arg).split(",") : cmpSaved.get();
  if (!arg && !files.length) {  // first visit: your first two favorites, else the first two stocks
    const stocks = state.data.quotes.filter((x) => x.group === "stock").map((x) => x.symbol);
    files = [...favs.list(), ...stocks].slice(0, 2);
  }
  const out = [];
  for (const f of files) {
    const q = state.data.quotes.find((x) => x.file === f || x.symbol === f);
    if (q && !out.includes(q) && out.length < CMP_MAX) out.push(q);
  }
  return out;
}
const compareHref = (qs) => `#/compare/${qs.map((q) => q.file).join(",")}`;

// A good first partner for one symbol: its market's index, or Bitcoin for coins.
function comparePartner(q) {
  const tags = q.tags || [];
  const pick = q.group === "crypto" ? (q.symbol === "BTC-USD" ? "ETH-USD" : "BTC-USD")
    : q.group === "index" ? (q.symbol === "^GSPC" ? "^IXIC" : "^GSPC")
    : tags.includes("europe") ? (q.symbol.endsWith(".DE") ? "^GDAXI" : "^STOXX50E") : "^GSPC";
  return quoteFor(pick) || state.data.quotes.find((x) => x !== q && x.group === q.group);
}

// --- numbers from the price history (candles: [date, open, high, low, close, volume])

const closeOnOrBefore = (candles, iso) => {
  for (let i = candles.length - 1; i >= 0; i--) if (candles[i][0] <= iso) return candles[i][4];
  return null;
};
const isoMinus = (iso, days) => new Date(Date.parse(`${iso}T12:00:00Z`) - days * 86400000).toISOString().slice(0, 10);

function backReturn(candles, days) {
  const last = candles[candles.length - 1];
  const from = isoMinus(last[0], days);
  if (candles[0][0] > from) return null;  // not enough history
  const base = closeOnOrBefore(candles, from);
  return base ? (last[4] / base - 1) * 100 : null;
}

// Everything that depends on the chosen range (1M … 2Y).
function rangeStats(candles, from, crypto) {
  const c = candles.filter((x) => x[0] >= from);
  if (c.length < 3) return {};
  const rets = c.slice(1).map((x, i) => x[4] / c[i][4] - 1);
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1));
  let peak = c[0][4], maxDrop = 0;
  for (const x of c) { peak = Math.max(peak, x[4]); maxDrop = Math.min(maxDrop, x[4] / peak - 1); }
  return {
    ret: (c[c.length - 1][4] / c[0][4] - 1) * 100,
    vol: sd * Math.sqrt(crypto ? 365 : 252) * 100,   // "volatility": typical yearly swing
    maxDrop: maxDrop * 100,
    best: Math.max(...rets) * 100,
    worst: Math.min(...rets) * 100,
    upDays: rets.filter((r) => r > 0).length / rets.length * 100,
  };
}

// How much two symbols move together, from -1 (opposite) to +1 (in lockstep).
function correlation(a, b, from) {
  const daily = (candles) => {
    const m = new Map(), c = candles.filter((x) => x[0] >= from);
    c.slice(1).forEach((x, i) => m.set(x[0], x[4] / c[i][4] - 1));
    return m;
  };
  const A = daily(a), B = daily(b), xs = [], ys = [];
  A.forEach((v, d) => { if (B.has(d)) { xs.push(v); ys.push(B.get(d)); } });
  if (xs.length < 10) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / xs.length, my = ys.reduce((s, v) => s + v, 0) / ys.length;
  let sxy = 0, sxx = 0, syy = 0;
  xs.forEach((x, i) => { sxy += (x - mx) * (ys[i] - my); sxx += (x - mx) ** 2; syy += (ys[i] - my) ** 2; });
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

function yearHighLow(candles) {
  const from = isoMinus(candles[candles.length - 1][0], 365);
  const c = candles.filter((x) => x[0] >= from);
  return { high: Math.max(...c.map((x) => x[2])), low: Math.min(...c.map((x) => x[3])) };
}

// --- the page

function pageCompare(arg) {
  const picked = compareList(arg);
  cmpSaved.set(picked.map((q) => q.file));
  const groups = [["📊 Indices", (x) => x.group === "index"],
    ["🇺🇸 US stocks", (x) => x.group === "stock" && !(x.tags || []).includes("europe")],
    ["🇪🇺 Europe", (x) => x.group === "stock" && (x.tags || []).includes("europe")],
    ["₿ Crypto", (x) => x.group === "crypto"]];
  const options = groups.map(([label, test]) => {
    const items = state.data.quotes.filter(test);
    return items.length ? `<optgroup label="${label}">${items.map((x) =>
      `<option value="${esc(x.file)}" ${picked.includes(x) ? "disabled" : ""}>${esc(x.name)} (${esc(x.symbol)})</option>`).join("")}</optgroup>` : "";
  }).join("");
  const chips = picked.map((q, i) => `<span class="cmp-chip" style="--c:var(${CMP_COLORS[i]})">
      <i class="dot"></i>${logo(q.symbol, q.name, "sm")}<b>${esc(q.symbol.replace(/-USD$/, ""))}</b>
      <button data-cmp-remove="${esc(q.file)}" aria-label="Remove ${esc(q.name)}">✕</button></span>`).join("");
  const adder = picked.length < CMP_MAX ? `<label class="cmp-add pill-btn">＋ Add<select id="cmp-add" aria-label="Add a symbol to compare">
      <option value="" selected disabled>Pick a stock or coin</option>${options}</select></label>` : "";
  const seg = `<div class="seg" data-seg="range">${Object.keys(RANGE_DAYS).map((o) =>
    `<button data-v="${o}" class="${o === state.range ? "on" : ""}">${o}</button>`).join("")}</div>`;

  if (picked.length < 2) {
    return `<div class="cmp-pick">${chips}${adder}</div>
      <div class="card empty">⚖️ Pick ${picked.length ? "one more" : "two or more"} stocks, coins or indices to see them side by side.
        <div class="hint" style="margin-top:8px">Tip: on any stock's page, tap <b>⚖️ Compare</b>.</div></div>`;
  }
  return `<div class="cmp-pick">${chips}${adder}</div>
    <div class="controls">${seg}</div>
    <div class="card" style="padding:10px 6px 6px">
      <div class="legend" id="cmp-legend">${picked.map((q, i) =>
        `<span><i style="background:var(${CMP_COLORS[i]})"></i>${esc(q.name)}</span>`).join("")}</div>
      <div class="readout num" id="readout">Every line starts at 0%. Touch the chart to see values.</div>
      <div id="chart"></div>
    </div>
    <div id="cmp-summary"></div>
    <div id="cmp-table"><div class="empty">Loading…</div></div>
    <details class="card cmp-help"><summary>❓ What do these numbers mean?</summary>
      <p><b>Change</b>: how much the price went up or down over that time.</p>
      <p><b>Volatility</b>: how much the price usually swings in a year. Higher means a bumpier ride (more risk, more chance).</p>
      <p><b>Biggest drop</b>: the worst fall from a high point in the chosen time. It shows how much pain you'd have felt.</p>
      <p><b>Up days</b>: share of days that closed higher than the day before.</p>
      <p><b>Below 1-year high</b>: how far the price is under its highest point of the last 12 months.</p>
      <p><b>RSI</b>: above 70 often means "ran up fast, may cool off"; below 30 means "sold off hard, may bounce".</p>
      <p><b>Market value</b>: what the whole company (or all coins) costs at today's price: price × number of shares. Shown in US dollars so all are comparable.</p>
      <p><b>Yearly sales / profit</b>: money the company took in and kept over the last 12 months. <b>Free cash flow</b>: real cash left after paying for running and investing in the business.</p>
      <p><b>Coins in circulation / max coins</b>: how many coins exist now and the most there can ever be. "Already created" near 100% means few new coins will dilute the price.</p>
      <p><b>P/E</b>: share price ÷ yearly profit per share. "How many years of profit you pay for." Lower is cheaper, but fast growers usually have a high P/E. <b>Forward P/E</b> uses next year's expected profit.</p>
      <p><b>Cash flow yield</b>: free cash flow ÷ market value. 5% means the company makes 5 cents of cash a year for every dollar you pay. Higher is cheaper.</p>
      <p><b>EPS</b>: profit per share, in the share's own currency. <b>EPS growth expected</b>: how much analysts expect it to grow next year.</p>
      <p><b>Gross / operating / profit margin</b>: what's left of every dollar of sales after making the product, after running the company, and at the very end (after interest and tax).</p>
      <p><b>1-year range</b>: the dot shows where today's price sits between the lowest and highest price of the last 12 months.</p>
      <p><b>Traded per day</b>: money that changes hands each day on average. More means easier to buy or sell without moving the price.</p>
      <p><b>P/S</b>: company value ÷ yearly sales. Useful when there's little profit yet.</p>
      <p><b>Profit margin</b>: how many cents of every dollar of sales are kept as profit.</p>
      <p><b>Sales growth</b>: sales compared with the same quarter a year ago.</p>
      <p><b>Return on equity</b>: profit compared with the owners' money in the company. Higher means it uses money well.</p>
      <p><b>Debt / equity</b>: debts compared with the owners' money (100 = equal). Lower is safer.</p>
      <p><b>Beta</b>: how strongly it moves with the whole market. 1 = like the market, 2 = twice as strong.</p>
      <p><b>Move together</b>: +1 means they always move the same way, 0 means no link. Owning two that move together doesn't spread your risk.</p>
    </details>
    <p class="disclaimer">🏆 marks the better number in a row, which is only one part of the picture.
      Changes are in each symbol's own currency; sizes are in US dollars at today's exchange rate. Company numbers from Yahoo Finance, updated daily. Not financial advice.</p>`;
}

function fmtCap(v, cur) {
  if (v == null) return "–";
  const c = (cur || "$").trim();
  const num = Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(v);
  return c.length === 1 ? `${c}${num}` : `${num} ${c}`;
}
// Converts an amount to US dollars with the day's rates (data.fx), so a company
// that reports in euros or Taiwan dollars can be compared with a US one.
const PRICE_CUR = { "$": "USD", "€": "EUR", "DKK": "DKK", "GBp": "GBp", "CHF": "CHF", "SEK": "SEK", "NOK": "NOK" };
function toUSD(v, cur) {
  if (v == null || !cur) return null;
  const pence = cur === "GBp";
  const rate = (state.data.fx || { USD: 1 })[pence ? "GBP" : String(cur).toUpperCase()];
  return rate ? v * rate / (pence ? 100 : 1) : null;
}
const priceCur = (x) => x.f.currency || PRICE_CUR[(x.q.currency || "$").trim()] || "USD";
const usd = (v) => v == null ? "–" : `${v < 0 ? "−" : ""}$${Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(Math.abs(v))}`;
const count = (v) => v == null ? "–" : Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(v);

const RATING = { strong_buy: "🟢 Strong buy", buy: "🟢 Buy", hold: "🟡 Hold", underperform: "🔴 Under­perform", sell: "🔴 Sell", strong_sell: "🔴 Strong sell" };

async function drawCompare(arg) {
  const picked = compareList(arg);
  const el = document.getElementById("chart");
  if (picked.length < 2 || !el || !window.LightweightCharts) return;
  const token = (drawCompare.token = (drawCompare.token || 0) + 1);
  try {
    await Promise.all(picked.map(async (q) => {
      if (!historyCache[q.file]) historyCache[q.file] = (await getJSON(`data/history/${q.file}.json`)).candles;
    }));
  } catch (e) {
    document.getElementById("cmp-table").innerHTML = `<div class="empty">Couldn't load the price history. Tap ↻ to retry.</div>`;
    return;
  }
  if (token !== drawCompare.token || !document.body.contains(el)) return;  // you left the page meanwhile
  const hist = picked.map((q) => historyCache[q.file]);
  const lastDay = hist.map((c) => c[c.length - 1][0]).sort().pop();
  const from = isoMinus(lastDay, RANGE_DAYS[state.range]);

  // Chart: each line shows the % change since the first day of the range.
  if (chart) { chart.remove(); chart = null; }
  chart = LightweightCharts.createChart(el, {
    autoSize: true,
    layout: { background: { type: "solid", color: "transparent" }, textColor: cssVar("--ink-3"), fontSize: 11,
      fontFamily: "-apple-system, BlinkMacSystemFont, Inter, sans-serif" },
    grid: { vertLines: { visible: false }, horzLines: { color: cssVar("--chart-grid") } },
    rightPriceScale: { borderVisible: false },
    timeScale: { borderVisible: false, fixLeftEdge: true, fixRightEdge: true },
    crosshair: { mode: 0, vertLine: { labelVisible: false }, horzLine: { labelVisible: true } },
    localization: { priceFormatter: (v) => `${v > 0 ? "+" : ""}${v.toFixed(Math.abs(v) < 10 ? 1 : 0)}%` },
    handleScale: false, handleScroll: false,
  });
  const series = picked.map((q, i) => {
    const c = hist[i].filter((x) => x[0] >= from);
    const s = chart.addLineSeries({ color: cssVar(CMP_COLORS[i]), lineWidth: 2, priceLineVisible: false,
      lastValueVisible: true, crosshairMarkerRadius: 4 });
    if (c.length) s.setData(c.map((x) => ({ time: x[0], value: (x[4] / c[0][4] - 1) * 100 })));
    return s;
  });
  series[0].createPriceLine({ price: 0, color: cssVar("--ink-3"), lineWidth: 1, lineStyle: 2, axisLabelVisible: false });
  chart.timeScale().fitContent();
  const readout = document.getElementById("readout");
  chart.subscribeCrosshairMove((p) => {
    if (!p.time) { readout.textContent = "Every line starts at 0%. Touch the chart to see values."; return; }
    readout.innerHTML = `${esc(p.time)} · ` + picked.map((q, i) => {
      const d = p.seriesData.get(series[i]);
      return d ? `<span style="color:var(${CMP_COLORS[i]})">●</span> ${esc(q.symbol.replace(/-USD$/, ""))} ${fmtPct(d.value)}` : "";
    }).filter(Boolean).join(" · ");
  });

  // Table: one column per symbol.
  const F = state.data.fundamentals || {}, divs = state.data.dividends || {};
  const cols = picked.map((q, i) => {
    const c = hist[i], f = F[q.symbol] || {}, hl = yearHighLow(c);
    const d = divs[q.symbol], today = todayISO();
    const paid = d?.history?.filter(([dt]) => dt > addDays(today, -365)) || [];
    const latestDiv = d?.history?.length ? d.history[d.history.length - 1][1] : 0;
    const price = current(q).price;
    return {
      q, f, price, ...rangeStats(c, from, q.group === "crypto"),
      r1m: backReturn(c, 30), r3m: backReturn(c, 91), r6m: backReturn(c, 182), r1y: backReturn(c, 365), r2y: backReturn(c, 730),
      fromHigh: hl.high ? (price / hl.high - 1) * 100 : null,
      divYield: q.group === "stock" ? (latestDiv && paid.length && price ? latestDiv * paid.length / price * 100 : 0) : null,
      upside: f.target && price ? (f.target / price - 1) * 100 : null,
      hl, posInYear: hl.high > hl.low ? Math.min(100, Math.max(0, (price - hl.low) / (hl.high - hl.low) * 100)) : null,
      tradedPerDay: q.group === "index" ? null : (() => {  // average money traded per day, last 20 days
        const last = c.slice(-20).filter((x) => x[5] > 0);
        return last.length ? last.reduce((s, x) => s + x[4] * x[5], 0) / last.length : null;
      })(),
      sig: signalFor(q.symbol),
      earn: (state.data.earnings || []).find((e) => e.symbol === q.symbol && daysUntil(e.date) >= 0),
    };
  });

  // better: "high" or "low" wins a 🏆; omitted = no winner (just information).
  const pct = (v) => v == null ? "–" : `<span class="${dir(v)}-text">${fmtPct(v)}</span>`;
  const plain = (v, digits = 1, suffix = "") => v == null ? "–" : `${v.toFixed(digits)}${suffix}`;
  const ratio = (v) => v == null ? "–" : `${(v * 100).toFixed(1)}%`;
  // Same currency for everyone: market value and company numbers in US dollars.
  cols.forEach((x) => {
    const pc = priceCur(x), fc = x.f.financial_currency || pc;
    x.capUSD = toUSD(x.f.market_cap, pc === "GBp" ? "GBP" : pc);
    x.revUSD = toUSD(x.f.revenue, fc);
    x.incomeUSD = toUSD(x.f.net_income, fc);
    x.fcfUSD = toUSD(x.f.free_cash_flow, fc);
    x.tradedUSD = toUSD(x.tradedPerDay, pc);
    x.fcfYield = x.fcfUSD != null && x.capUSD ? x.fcfUSD / x.capUSD * 100 : null;
    x.epsGrowth = x.f.eps > 0 && x.f.forward_eps != null ? (x.f.forward_eps / x.f.eps - 1) * 100 : null;
    x.mined = x.f.supply && x.f.max_supply ? x.f.supply / x.f.max_supply * 100 : null;
  });
  const local = (v, x) => v == null ? "–" : fmtPrice(v, x.q.currency);
  const range = (x) => x.posInYear == null ? "–" : `<div class="rng" title="Where today's price sits in the last 12 months"><i style="left:${x.posInYear.toFixed(0)}%"></i></div>
      <div class="hint">${fmtPrice(x.hl.low)} – ${fmtPrice(x.hl.high)}</div>`;
  const sections = [
    ["📈 Price & change", [
      ["Price", (x) => livePrice(x.q)],
      ["Today", (x) => liveChange(x.q), "high", (x) => current(x.q).chg],
      [`This range (${state.range})`, (x) => pct(x.ret), "high", (x) => x.ret],
      ["1 month", (x) => pct(x.r1m), "high", (x) => x.r1m],
      ["3 months", (x) => pct(x.r3m), "high", (x) => x.r3m],
      ["6 months", (x) => pct(x.r6m), "high", (x) => x.r6m],
      ["1 year", (x) => pct(x.r1y), "high", (x) => x.r1y],
      ["2 years", (x) => pct(x.r2y), "high", (x) => x.r2y],
    ]],
    [`🎢 Risk (${state.range})`, [
      ["Volatility", (x) => plain(x.vol, 0, "%"), "low", (x) => x.vol],
      ["Biggest drop", (x) => pct(x.maxDrop), "high", (x) => x.maxDrop],
      ["Best day", (x) => pct(x.best)],
      ["Worst day", (x) => pct(x.worst), "high", (x) => x.worst],
      ["Up days", (x) => plain(x.upDays, 0, "%"), "high", (x) => x.upDays],
      ["Beta", (x) => plain(x.f.beta, 2)],
    ]],
    ["🔍 Trend", [
      ["Below 1-year high", (x) => pct(x.fromHigh), "high", (x) => x.fromHigh],
      ["vs 50-day avg", (x) => pct(x.q.vs_sma50)],
      ["vs 200-day avg", (x) => pct(x.q.vs_sma200)],
      ["RSI (14)", (x) => x.q.rsi14 == null ? "–" : `${x.q.rsi14.toFixed(0)}${x.q.rsi14 > 70 ? " 🔥" : x.q.rsi14 < 30 ? " 🧊" : ""}`],
      ["Volume vs avg", (x) => plain(x.q.volume_ratio, 1, "×")],
    ]],
    ["🏢 Size", [
      ["Market value", (x) => usd(x.capUSD), "high", (x) => x.capUSD],
      ["In own currency", (x) => priceCur(x) === "USD" || x.f.market_cap == null ? "–" : fmtCap(x.f.market_cap, x.q.currency)],
      ["Yearly sales", (x) => usd(x.revUSD), "high", (x) => x.revUSD],
      ["Yearly profit", (x) => x.incomeUSD == null ? "–" : `<span class="${dir(x.incomeUSD)}-text">${usd(x.incomeUSD)}</span>`, "high", (x) => x.incomeUSD],
      ["Free cash flow", (x) => usd(x.fcfUSD), "high", (x) => x.fcfUSD],
      ["Employees", (x) => count(x.f.employees)],
      ["Shares", (x) => x.q.group === "crypto" ? "–" : count(x.f.shares)],
      ["Coins in circulation", (x) => x.q.group === "crypto" ? count(x.f.supply) : "–"],
      ["Max coins ever", (x) => x.q.group !== "crypto" ? "–" : x.f.max_supply ? count(x.f.max_supply) : x.f.supply ? "no limit" : "–"],
      ["Already created", (x) => plain(x.mined, 0, "%")],
      ["Sector", (x) => esc(x.f.sector || (x.q.group === "crypto" ? "Crypto" : x.q.group === "index" ? "Index" : "–"))],
    ]],
    ["🏷️ Price tag", [
      ["P/E", (x) => plain(x.f.pe, 1), "low", (x) => x.f.pe > 0 ? x.f.pe : null],
      ["Forward P/E", (x) => plain(x.f.forward_pe, 1), "low", (x) => x.f.forward_pe > 0 ? x.f.forward_pe : null],
      ["P/S", (x) => plain(x.f.ps, 1), "low", (x) => x.f.ps],
      ["Cash flow yield", (x) => plain(x.fcfYield, 1, "%"), "high", (x) => x.fcfYield],
      ["Profit per share (EPS)", (x) => local(x.f.eps, x)],
      ["Expected next year", (x) => local(x.f.forward_eps, x)],
      ["EPS growth expected", (x) => pct(x.epsGrowth), "high", (x) => x.epsGrowth],
    ]],
    ["💪 Profit & health", [
      ["Gross margin", (x) => ratio(x.f.gross_margin), "high", (x) => x.f.gross_margin],
      ["Operating margin", (x) => ratio(x.f.operating_margin), "high", (x) => x.f.operating_margin],
      ["Profit margin", (x) => ratio(x.f.margin), "high", (x) => x.f.margin],
      ["Sales growth", (x) => x.f.revenue_growth == null ? "–" : pct(x.f.revenue_growth * 100), "high", (x) => x.f.revenue_growth],
      ["Profit growth", (x) => x.f.earnings_growth == null ? "–" : pct(x.f.earnings_growth * 100), "high", (x) => x.f.earnings_growth],
      ["Return on equity", (x) => ratio(x.f.roe), "high", (x) => x.f.roe],
      ["Debt / equity", (x) => plain(x.f.debt_equity, 0), "low", (x) => x.f.debt_equity],
    ]],
    ["🔄 Trading", [
      ["1-year range", range],
      ["Traded per day", (x) => usd(x.tradedUSD), "high", (x) => x.tradedUSD],
      ["Avg volume", (x) => count(x.f.avg_volume)],
    ]],
    ["💰 Dividend", [
      ["Yield", (x) => x.divYield == null ? "–" : x.divYield ? `${x.divYield.toFixed(2)}%` : "none", "high", (x) => x.divYield || null],
    ]],
    ["🤖 Opinions", [
      ["AI signal today", (x) => x.sig ? `${SIGNAL_EMOJI[x.sig.action] || ""} ${esc(x.sig.label)}${x.sig.confidence ? `<div class="hint">${esc(x.sig.confidence)}</div>` : ""}` : "–"],
      ["Analysts", (x) => x.f.rating ? `${RATING[x.f.rating] || esc(x.f.rating)}${x.f.analysts ? `<div class="hint">${x.f.analysts} analysts</div>` : ""}` : "–"],
      ["Analyst target", (x) => x.upside == null ? "–" : `${fmtPrice(x.f.target, x.q.currency)}<div class="hint">${fmtPct(x.upside)} from now</div>`, "high", (x) => x.upside],
      ["Next earnings", (x) => x.earn ? nice(x.earn.date, { day: "numeric", month: "short" }) : "–"],
    ]],
  ];
  const head = `<tr><th></th>${cols.map((x, i) => `<th style="--c:var(${CMP_COLORS[i]})"><a href="#/s/${x.q.file}">
      ${logo(x.q.symbol, x.q.name, "sm")}<span>${esc(x.q.symbol.replace(/-USD$/, ""))}</span></a></th>`).join("")}</tr>`;
  const body = sections.map(([title, rows]) => {
    const shown = rows.filter(([, show]) => cols.some((x) => show(x) !== "–"));
    if (!shown.length) return "";
    return `<tr class="sec"><th colspan="${cols.length + 1}">${title}</th></tr>` + shown.map(([label, show, better, val]) => {
      const vals = better ? cols.map((x) => val(x)) : [];
      const ok = vals.filter((v) => v != null && Number.isFinite(v));
      const win = ok.length >= 2 && new Set(ok).size > 1 ? (better === "high" ? Math.max(...ok) : Math.min(...ok)) : null;
      return `<tr><th>${label}</th>${cols.map((x, i) => `<td class="num ${win != null && vals[i] === win ? "best" : ""}">${show(x)}</td>`).join("")}</tr>`;
    }).join("");
  }).join("");
  document.getElementById("cmp-table").innerHTML = `<div class="cmp-wrap"><table class="cmp">${head}${body}</table></div>`;

  // A few plain sentences on top.
  const lines = [];
  const byRet = cols.filter((x) => x.ret != null).sort((a, b) => b.ret - a.ret);
  const nm = (x) => `<b>${esc(x.q.name)}</b>`;
  if (byRet.length >= 2) {
    const top = byRet[0], low = byRet[byRet.length - 1];
    lines.push(`📈 Over ${state.range}, ${nm(top)} did best (${fmtPct(top.ret)})${byRet.length > 1 ? `, ${nm(low)} did worst (${fmtPct(low.ret)})` : ""}.`);
  }
  const bySize = cols.filter((x) => x.capUSD).sort((a, b) => b.capUSD - a.capUSD);
  if (bySize.length >= 2) {
    const big = bySize[0], small = bySize[bySize.length - 1], k = big.capUSD / small.capUSD;
    lines.push(k >= 1.3
      ? `🏢 ${nm(big)} is worth about ${k >= 10 ? Math.round(k) : k.toFixed(1)}× as much as ${nm(small)} (${usd(big.capUSD)} vs ${usd(small.capUSD)}).`
      : `🏢 ${nm(big)} and ${nm(small)} are about the same size (${usd(big.capUSD)} vs ${usd(small.capUSD)}).`);
  }
  const byVol = cols.filter((x) => x.vol).sort((a, b) => a.vol - b.vol);
  if (byVol.length >= 2) {
    const calm = byVol[0], wild = byVol[byVol.length - 1], k = wild.vol / calm.vol;
    if (k >= 1.2) lines.push(`🎢 ${nm(wild)} swings about ${k.toFixed(1)}× as much as ${nm(calm)}, so it's the bumpier ride.`);
    else lines.push(`🎢 They swing about the same amount.`);
  }
  if (cols.length === 2) {
    const r = correlation(hist[0], hist[1], from);
    if (r != null) lines.push(`🔗 Move together: <b>${r.toFixed(2)}</b>. ${r > 0.7 ? "They mostly rise and fall together." : r > 0.4 ? "They often move the same way." : r > 0.1 ? "They're only loosely linked." : r > -0.1 ? "They move independently." : "They tend to move in opposite directions."}`);
  } else {
    const pairs = [];
    for (let i = 0; i < cols.length; i++) for (let j = i + 1; j < cols.length; j++) {
      const r = correlation(hist[i], hist[j], from);
      if (r != null) pairs.push(`${esc(cols[i].q.symbol.replace(/-USD$/, ""))}–${esc(cols[j].q.symbol.replace(/-USD$/, ""))} <b>${r.toFixed(2)}</b>`);
    }
    if (pairs.length) lines.push(`🔗 Move together (1 = always): ${pairs.join(" · ")}`);
  }
  document.getElementById("cmp-summary").innerHTML = lines.length ? `<div class="card cmp-summary">${lines.map((l) => `<p>${l}</p>`).join("")}</div>` : "";
}

view.addEventListener("change", (e) => {
  if (e.target.id !== "cmp-add" || !e.target.value) return;
  const picked = compareList(location.hash.split("/")[2]);
  const q = state.data.quotes.find((x) => x.file === e.target.value);
  if (q) location.hash = compareHref([...picked, q]);
});
view.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-cmp-remove]");
  if (!b) return;
  const picked = compareList(location.hash.split("/")[2]).filter((q) => q.file !== b.dataset.cmpRemove);
  location.hash = picked.length ? compareHref(picked) : "#/compare/-";
});

// ---------------------------------------------------------------- router

function render() {
  if (!state.data) return;
  if (chart) { chart.remove(); chart = null; liveChart = null; }
  if (document.getElementById("lock-form")) return;
  const hash = location.hash || "#/";
  const [, page, arg] = hash.split("/");
  const tab = page === "s" ? "watchlist" : page === "calc" ? "portfolio" : page || "today";
  if (tab !== state.lastTab) { shownCount = {}; state.lastTab = tab; }  // lists start short again on a new tab
  const titles = { compare: "Compare", today: "Today", watchlist: "Watchlist", news: "News", videos: "Videos", record: "Track record", settings: "Settings", portfolio: "Portfolio", inbox: "Inbox" };
  document.getElementById("bell-btn")?.classList.toggle("active", tab === "inbox");
  document.getElementById("page-title").textContent = page === "s" ? "" : titles[tab];
  document.querySelectorAll(".tabbar a").forEach((a) => a.classList.toggle("active", a.dataset.tab === tab));

  if (page === "inbox") {
    if (state.inboxSeenBefore == null) state.inboxSeenBefore = inboxSeen.get();  // keep "new" dots during this visit
    view.innerHTML = arg ? pageInboxItem(decodeURIComponent(arg)) : pageInbox();
    markInboxRead();
  } else if (page === "compare") {
    view.innerHTML = pageCompare(arg);
    drawCompare(arg);
  } else if (page === "calc") {
    state.pfTab = "calc";
    view.innerHTML = pagePortfolio();
    openCalc(decodeURIComponent(arg || ""));
  } else if (page === "s") {
    view.innerHTML = pageDetail(decodeURIComponent(arg || ""));
    const q = state.data.quotes.find((x) => x.file === arg);
    if (q) drawChart(q);
  } else {
    view.innerHTML = { today: pageToday, watchlist: pageWatchlist, news: pageNews, videos: pageVideos, record: pageRecord, settings: pageSettings, portfolio: pagePortfolio }[tab]();
    if (tab === "settings") fillPushCard();
    if (tab === "portfolio" && state.pfTab === "calc") openCalc();
  }
  if (page !== "inbox") state.inboxSeenBefore = null;
  tickClocks();
}

// Clicks on buttons inside the page (filters, range, "read more", ...).
view.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.star) { e.preventDefault(); e.stopPropagation(); favs.toggle(b.dataset.star); render(); return; }
  if (b.dataset.move) { favs.move(b.dataset.move, Number(b.dataset.step)); render(); return; }
  if (b.dataset.act === "save-settings") { saveSettings(); return; }
  if (b.dataset.act === "reorder") { state.reorder = true; render(); return; }
  if (b.dataset.act === "reorder-done") { state.reorder = false; render(); return; }
  if (b.dataset.more) {
    const scroll = window.scrollY;
    shownCount[b.dataset.more] = Number(b.dataset.n);
    render(); window.scrollTo(0, scroll);
    return;
  }
  if (b.dataset.filter) { state.newsFilter = b.dataset.filter; render(); }
  if (b.dataset.vsort) { state.videoSort = b.dataset.vsort; render(); }
  if (b.dataset.remove) { state.draft = state.draft.filter((i) => i.symbol !== b.dataset.remove); render(); }
  if (b.dataset.act === "edit") startEditing();
  if (b.dataset.act === "cancel") { state.editing = false; state.flash = ""; render(); }
  if (b.dataset.act === "save") saveWatchlist();
  if (b.dataset.act === "forget-key") { ghKey.set(""); render(); }
  const seg = b.closest("[data-seg]");
  if (seg && (seg.dataset.seg === "range" || seg.dataset.seg === "type")) {
    if (seg.dataset.seg === "range") state.range = b.dataset.v;
    if (seg.dataset.seg === "type") state.chartType = b.dataset.v;
    const scroll = window.scrollY; render(); window.scrollTo(0, scroll);
  }
  if (b.id === "more") {
    const br = document.getElementById("briefing");
    br.classList.toggle("collapsed");
    b.textContent = br.classList.contains("collapsed") ? "Read the full briefing" : "Show less";
  }
  if (b.id === "install-x") {
    try { localStorage.setItem("installHintDismissed", "1"); } catch (err) { /* ignore */ }
    document.getElementById("install").remove();
  }
});

window.addEventListener("hashchange", () => {
  state.flash = ""; state.editError = ""; state.tradeEdit = null;  // messages belong to the page they were shown on
  render(); window.scrollTo(0, 0);
});
document.getElementById("refresh").addEventListener("click", () => load());
// Reload fresh data when you come back to the app (unless the lock screen is showing).
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") { stopLive(); return; }  // save battery in the background
  if (!document.getElementById("lock-form") && !state.editing) load();
});
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);

load();

// ---------------------------------------------------------------- app updates
// Each data file says which app version built it. If your phone still runs an
// older (cached) version, fetch the new page and reload once.
function checkForNewVersion() {
  const mine = document.querySelector('meta[name="app-version"]')?.content;
  const latest = state.data?.app_version;
  if (!latest || !mine || mine === "dev" || mine === latest) return false;
  try {
    if (sessionStorage.getItem("reloadedFor") === latest) return false;  // never loop
    sessionStorage.setItem("reloadedFor", latest);
  } catch (e) { return false; }
  fetch(`./?v=${latest}`, { cache: "reload" }).catch(() => {}).finally(() => location.reload());
  return true;
}

// ---------------------------------------------------------------- opening animation
// The splash in index.html animates by itself (CSS); here we just remove it afterwards.
(function splash() {
  const el = document.getElementById("splash");
  if (!el) return;
  const hide = () => { el.classList.add("out"); setTimeout(() => el.remove(), 400); };
  const timer = setTimeout(hide, matchMedia("(prefers-reduced-motion: reduce)").matches ? 300 : 1700);
  el.addEventListener("click", () => { clearTimeout(timer); hide(); });  // tap to skip
})();
