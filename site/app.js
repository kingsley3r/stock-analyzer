// Market Pulse dashboard.
// Plain JavaScript, no build step: the browser runs this file as it is.
//
// How it works:
//   1. load() downloads data/latest.json (written by analyzer/dashboard_data.py).
//   2. The part after "#" in the address decides which page to show (the "route"):
//        #/            Today        #/watchlist   Watchlist
//        #/news        News         #/videos      Videos
//        #/s/NVDA      Detail page with a chart for one symbol
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
        lock.keySalt = lock.info.salt;
      }
    }
    try {
      state.data = await getJSON("data/latest.json");
      if (checkForNewVersion()) return;
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
    <h2 class="section-title first">🎯 Today's signals${digest ? ` <span class="sub">${istanbulTime(digest.sent_at)}</span>` : ""}</h2>
    ${signals.length ? signals.map(signalCard).join("") :
      `<div class="card empty">No signals yet today. They appear after the morning digest.</div>`}

    <h2 class="section-title">🔥 Biggest moves</h2>
    <div class="list">${movers.map((q) => row(q)).join("")}</div>

    ${recordTeaser()}

    <h2 class="section-title">📊 Indices</h2>
    <div class="chips">${indices.map((q) => `
      <a class="chip" href="#/s/${q.file}">
        <div class="label">${INDEX_FLAG[q.symbol] || "📊"} ${esc(q.name)}</div>
        <div class="value num">${livePrice(q, false)}</div>
        <div class="num" style="font-size:13px;font-weight:600">${liveChange(q)}</div>
      </a>`).join("")}
    </div>
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
    favBlock + block(`🇺🇸 US stocks ${marketTag("us")}`, us) + block(`🇪🇺 Europe ${marketTag("de")}`, eu) + block("₿ Crypto", crypto) +
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
  return `<div class="filters">${btn("all", "All")}${btn("mine", "📈 My stocks")}${btn("ai", "🤖 AI")}${btn("crypto", "₿ Crypto")}</div>
    <div class="list">${items.length ? items.map((n) => `
      <a class="news-item" href="${esc(n.link)}" target="_blank" rel="noopener">
        ${newsLogo(n)}<div class="nbody"><div class="meta">${esc(n.source.replace(/^Yahoo \(.*\)$/, "Yahoo Finance"))} · ${timeAgo(n.ts)}${newsSymbol(n) ? `<span class="tag">${esc(newsSymbol(n))}</span>` : ""}</div>
        <div class="title">${esc(n.title)}</div></div>
      </a>`).join("") : `<div class="empty">No articles for this filter.</div>`}</div>`;
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

  return `<div class="filters">${btn("new", "🕒 Newest")}${btn("views", "👁 Most viewed")}${btn("hot", "🔥 Trending")}</div>
    <div class="list">${list.length ? list.map((x) => `
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
      </a>`).join("") : `<div class="empty">No new videos in the last 3 days.</div>`}</div>
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
  const days = [...new Set(r.items.map((i) => i.date))];
  const dayLabel = (d) => new Date(d + "T12:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

  return `
    <div class="score-grid">
      ${summary("🟢 BUY calls", r.buy, "moved")}
      ${summary("🔴 SELL & ⛔ DON'T BUY", r.sell, "moved")}
    </div>
    <p class="explain">A <b>BUY</b> counts as ✅ right if the price is higher one week later.
      A <b>SELL</b> or <b>DON'T BUY</b> is right if the price is lower. HOLD and WATCH are shown but not scored.
      Changes are measured from the last closing price before the signal. Tracking since ${esc(dayLabel(r.since))}.</p>
    ${days.map((d) => `
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
      </div>`).join("")}
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

    <div class="controls">${seg("range", ["1M", "3M", "6M", "1Y", "2Y"], state.range)}${seg("type", ["line", "candles"], state.chartType)}</div>
    <div class="card" style="padding:10px 6px 6px">
      <div class="legend"><span><i style="background:var(--ink-2)"></i>Price</span>
        <span><i style="background:var(--sma50)"></i>50-day average</span>
        <span><i style="background:var(--sma200)"></i>200-day average</span></div>
      <div class="readout num" id="readout">Touch the chart to see values.</div>
      <div id="chart"></div>
    </div>

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
  const a = { enabled: true, quiet_enabled: true, quiet_from: "23:00", quiet_to: "07:00", quiet_mode: "silent", ...(state.data.alerts || {}) };
  const t = (v) => typeof v === "number" ? `${String(Math.floor(v / 60) % 24).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}` : String(v).padStart(5, "0");
  const toggle = (id, on, label, hint) => `<label class="toggle-row"><span><b>${label}</b>${hint ? `<span class="hint">${hint}</span>` : ""}</span>
    <input type="checkbox" id="${id}" ${on ? "checked" : ""}><span class="switch" aria-hidden="true"></span></label>`;
  return `
    <h2 class="section-title">🚨 News alerts on Telegram</h2>
    <form class="card settings" id="settings-form">
      ${toggle("al-on", a.enabled, "Send news alerts", "Important news about your stocks and coins, checked every 15 minutes.")}
      <div class="sep"></div>
      ${toggle("al-quiet", a.quiet_enabled, "🌙 Quiet time", "Times are Istanbul time.")}
      <div class="quiet-box" ${a.quiet_enabled ? "" : "hidden"}>
        <div class="time-row"><label>From <input type="time" id="al-from" value="${esc(t(a.quiet_from))}" step="300"></label>
          <label>To <input type="time" id="al-to" value="${esc(t(a.quiet_to))}" step="300"></label></div>
        <label class="k" for="al-mode">During quiet time</label>
        <select id="al-mode">
          <option value="silent" ${a.quiet_mode !== "skip" ? "selected" : ""}>🔕 Send without sound</option>
          <option value="skip" ${a.quiet_mode === "skip" ? "selected" : ""}>⛔ Don't send at all</option>
        </select>
      </div>
    </form>
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
  if (!token) { state.editError = "Please paste your GitHub key first."; render(); return; }
  state.saving = true; state.editError = ""; state.flash = ""; render();
  const yaml = `# News alert settings, saved from the app (⚙️ Settings) on ${new Date().toISOString().slice(0, 10)}.
# Times are Istanbul time. quiet_mode: silent = no sound, skip = not sent.
enabled: ${cfg.enabled}
quiet_enabled: ${cfg.quiet_enabled}
quiet_from: "${cfg.quiet_from}"
quiet_to: "${cfg.quiet_to}"
quiet_mode: ${cfg.quiet_mode}
`;
  try {
    await ghSave("config/alerts.yaml", yaml, "Update alert settings from the app", token);
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

// ---------------------------------------------------------------- router

function render() {
  if (!state.data) return;
  if (chart) { chart.remove(); chart = null; liveChart = null; }
  if (document.getElementById("lock-form")) return;
  const hash = location.hash || "#/";
  const [, page, arg] = hash.split("/");
  const tab = page === "s" ? "watchlist" : page || "today";
  const titles = { today: "Today", watchlist: "Watchlist", news: "News", videos: "Videos", record: "Track record", settings: "Settings" };
  document.getElementById("page-title").textContent = page === "s" ? "" : titles[tab];
  document.querySelectorAll(".tabbar a").forEach((a) => a.classList.toggle("active", a.dataset.tab === tab));

  if (page === "s") {
    view.innerHTML = pageDetail(decodeURIComponent(arg || ""));
    const q = state.data.quotes.find((x) => x.file === arg);
    if (q) drawChart(q);
  } else {
    view.innerHTML = { today: pageToday, watchlist: pageWatchlist, news: pageNews, videos: pageVideos, record: pageRecord, settings: pageSettings }[tab]();
  }
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
  if (b.dataset.filter) { state.newsFilter = b.dataset.filter; render(); }
  if (b.dataset.vsort) { state.videoSort = b.dataset.vsort; render(); }
  if (b.dataset.remove) { state.draft = state.draft.filter((i) => i.symbol !== b.dataset.remove); render(); }
  if (b.dataset.act === "edit") startEditing();
  if (b.dataset.act === "cancel") { state.editing = false; state.flash = ""; render(); }
  if (b.dataset.act === "save") saveWatchlist();
  if (b.dataset.act === "forget-key") { ghKey.set(""); render(); }
  const seg = b.closest("[data-seg]");
  if (seg) {
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

window.addEventListener("hashchange", () => { render(); window.scrollTo(0, 0); });
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
