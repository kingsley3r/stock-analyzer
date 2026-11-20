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
  } catch (e) {
    document.getElementById("updated").textContent = "Couldn't load data. Tap ↻ to retry.";
    if (!state.data) view.innerHTML = `<div class="empty">No data yet. It appears after the first update run.</div>`;
  } finally {
    btn.classList.remove("spin");
  }
}

// ---------------------------------------------------------------- pages

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
        <div class="label">${esc(q.name)}</div>
        <div class="value num">${fmtPrice(q.last)}</div>
        <div class="${dir(q.change_1d)}-text num" style="font-size:13px;font-weight:600">${arrow(q.change_1d)} ${fmtPct(q.change_1d)}</div>
      </a>`).join("")}
    </div>

    <h2 class="section-title">🎯 Today's signals</h2>
    ${signals.length ? signals.map(signalCard).join("") :
      `<div class="card empty">No signals yet today. They appear after the morning digest.</div>`}

    ${recordTeaser()}

    <h2 class="section-title">🔥 Biggest moves</h2>
    <div class="list">${movers.map(row).join("")}</div>

    <h2 class="section-title">☀️ Morning briefing${digest ? ` · ${istanbulTime(digest.sent_at)}` : ""}</h2>
    ${digest ? `<div class="card"><div class="briefing collapsed" id="briefing">${digest.html}</div>
      <button class="more" id="more">Read the full briefing</button></div>`
      : `<div class="card empty">The briefing appears here after the morning digest.</div>`}
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
      <span class="badge ${s.action}">${SIGNAL_EMOJI[s.action] || ""} ${esc(s.label)}</span>
      <span class="sym">${esc(s.symbol)}</span><span class="name">${esc(s.name || q?.name || "")}</span>
      ${s.confidence ? `<span class="conf">${"⭐".repeat({ Low: 1, Medium: 2, High: 3 }[s.confidence] || 0)} ${esc(s.confidence)}</span>` : ""}
    </div>
    ${q ? `<div class="num" style="margin-top:6px;font-size:14px">${fmtPrice(q.last, q.currency)} &nbsp;${pill(q.change_1d)}</div>` : ""}
    ${s.reasons ? `<p class="why">${esc(s.reasons)}</p>` : ""}
  </a>`;
}

function row(q) {
  const sig = signalFor(q.symbol);
  return `<a class="row" href="#/s/${q.file}">
    <div class="who">
      <div class="t">${sig ? SIGNAL_EMOJI[sig.action] + " " : ""}${esc(q.name)}</div>
      <div class="s">${esc(q.symbol)}</div>
    </div>
    ${sparkline(q.spark, q.change_1m)}
    <div class="price">
      <div class="p num">${fmtPrice(q.last, q.currency)}</div>
      ${pill(q.change_1d)}
    </div>
  </a>`;
}

function pageWatchlist() {
  const q = state.data.quotes;
  const us = q.filter((x) => x.group === "stock" && !(x.tags || []).includes("europe"));
  const eu = q.filter((x) => x.group === "stock" && (x.tags || []).includes("europe"));
  const crypto = q.filter((x) => x.group === "crypto");
  const block = (title, items) => items.length ? `<h2 class="section-title">${title}</h2><div class="list">${items.map(row).join("")}</div>` : "";
  return block("🇺🇸 US stocks", us) + block("🇪🇺 Europe", eu) + block("₿ Crypto", crypto) +
    `<p class="disclaimer">Prices from Yahoo Finance, end of day or delayed. Edit the list in config/watchlist.yaml.</p>`;
}

function pageNews() {
  const all = state.data.news;
  const cryptoWords = /bitcoin|crypto|ethereum|solana|btc|eth\b|coin/i;
  const filters = {
    all: () => true,
    mine: (n) => n.symbol,
    crypto: (n) => cryptoWords.test(n.title) || /coin/i.test(n.source),
    ai: (n) => /\bAI\b|artificial intelligence|nvidia|openai|chip/i.test(n.title),
  };
  const items = all.filter(filters[state.newsFilter]);
  const btn = (k, label) => `<button data-filter="${k}" class="${state.newsFilter === k ? "on" : ""}">${label}</button>`;
  return `<div class="filters">${btn("all", "All")}${btn("mine", "📈 My stocks")}${btn("ai", "🤖 AI")}${btn("crypto", "₿ Crypto")}</div>
    <div class="list">${items.length ? items.map((n) => `
      <a class="news-item" href="${esc(n.link)}" target="_blank" rel="noopener">
        <div class="meta">${esc(n.source.replace(/^Yahoo \(.*\)$/, "Yahoo Finance"))} · ${timeAgo(n.ts)}${n.symbol ? `<span class="tag">${esc(n.symbol)}</span>` : ""}</div>
        <div class="title">${esc(n.title)}</div>
      </a>`).join("") : `<div class="empty">No articles for this filter.</div>`}</div>`;
}

function pageVideos() {
  const v = state.data.videos;
  return `<h2 class="section-title">🎥 New in the last 24 hours</h2>
    <div class="list">${v.length ? v.map((x) => `
      <a class="video" href="${esc(x.link)}" target="_blank" rel="noopener">
        ${x.id ? `<img loading="lazy" alt="" src="https://i.ytimg.com/vi/${esc(x.id)}/mqdefault.jpg">` : ""}
        <div><div class="title">${esc(x.title)}</div>
        <div class="meta">${esc(x.channel)} · ${esc(x.topic)}</div></div>
      </a>`).join("") : `<div class="empty">No new videos yet today.</div>`}</div>`;
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
      <div style="color:var(--ink-3);font-size:14px">${esc(q.symbol)} · ${esc(q.name)}</div>
      <div class="big num">${fmtPrice(q.last, q.currency)}</div>
      <div class="chg ${dir(q.change_1d)}-text num">${arrow(q.change_1d)} ${fmtPct(q.change_1d)} today · closed ${esc(q.last_date)}</div>
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

// ---------------------------------------------------------------- router

function render() {
  if (!state.data) return;
  if (chart) { chart.remove(); chart = null; }
  if (document.getElementById("lock-form")) return;
  const hash = location.hash || "#/";
  const [, page, arg] = hash.split("/");
  const tab = page === "s" ? "watchlist" : page || "today";
  const titles = { today: "Today", watchlist: "Watchlist", news: "News", videos: "Videos", record: "Track record" };
  document.getElementById("page-title").textContent = page === "s" ? "" : titles[tab];
  document.querySelectorAll(".tabbar a").forEach((a) => a.classList.toggle("active", a.dataset.tab === tab));

  if (page === "s") {
    view.innerHTML = pageDetail(decodeURIComponent(arg || ""));
    const q = state.data.quotes.find((x) => x.file === arg);
    if (q) drawChart(q);
  } else {
    view.innerHTML = { today: pageToday, watchlist: pageWatchlist, news: pageNews, videos: pageVideos, record: pageRecord }[tab]();
  }
}

// Clicks on buttons inside the page (filters, range, "read more", ...).
view.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.filter) { state.newsFilter = b.dataset.filter; render(); }
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
  if (document.visibilityState === "visible" && !document.getElementById("lock-form")) load();
});
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);

load();
