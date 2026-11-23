// 🧮 ETF calculator: "What could my money grow to?"
// Lives under Portfolio (#/calc, or #/calc/VWCE.DE to start with one ETF).
//
// How the estimate works (month by month):
//   1. You put in a one-time amount at the start, then the monthly amount every month.
//   2. The ETF's price grows by (expected yearly return − dividend yield).
//   3. The fund's yearly cost (TER) is taken off the value bit by bit.
//   4. Dividends: reinvested (bought more of the ETF) or paid out to you.
//   5. Austrian tax (KESt 27.5%): on dividends every year, and on the profit when you sell.
// The result is an ESTIMATE. Real markets go up and down; the "bad years" and
// "good years" lines show the same plan with 3% less or 3% more per year.
//
// Uses from app.js: state, view, chart, esc, cssVar, money, logo, render, TZ.

// Popular ETFs. "ret" = rough long-term yearly average of the index the ETF follows,
// with dividends, before costs (past results, not a promise). "yld" = dividend yield,
// "ter" = yearly cost. Numbers are rounded on purpose.
const CALC_ETFS = [
  { s: "VWCE.DE", n: "Vanguard FTSE All-World (Acc)", cur: "€", ret: 8, ter: 0.19, yld: 1.8, acc: true, about: "about 4,000 companies worldwide" },
  { s: "EUNL.DE", n: "iShares Core MSCI World (Acc)", cur: "€", ret: 8.5, ter: 0.20, yld: 1.6, acc: true, about: "about 1,400 big companies in 23 rich countries" },
  { s: "SXR8.DE", n: "iShares Core S&P 500 (Acc)", cur: "€", ret: 10, ter: 0.07, yld: 1.3, acc: true, about: "the 500 biggest US companies" },
  { s: "VUSA.DE", n: "Vanguard S&P 500 (Dist)", cur: "€", ret: 10, ter: 0.07, yld: 1.2, acc: false, about: "the 500 biggest US companies, pays dividends out" },
  { s: "SXRV.DE", n: "iShares Nasdaq 100 (Acc)", cur: "€", ret: 12, ter: 0.30, yld: 0.6, acc: true, about: "100 big US tech-heavy companies, bigger swings" },
  { s: "EQQQ.DE", n: "Invesco Nasdaq-100 (Dist)", cur: "€", ret: 12, ter: 0.30, yld: 0.5, acc: false, about: "100 big US tech-heavy companies, bigger swings" },
  { s: "IS3N.DE", n: "iShares Core MSCI EM IMI (Acc)", cur: "€", ret: 7, ter: 0.18, yld: 2.5, acc: true, about: "emerging markets like China, India, Taiwan" },
  { s: "VGWD.DE", n: "Vanguard FTSE All-World High Dividend (Dist)", cur: "€", ret: 7.5, ter: 0.29, yld: 3.2, acc: false, about: "high-dividend companies worldwide" },
  { s: "EXSA.DE", n: "iShares STOXX Europe 600 (Dist)", cur: "€", ret: 7, ter: 0.20, yld: 3.0, acc: false, about: "600 European companies" },
  { s: "VOO", n: "Vanguard S&P 500 ETF", cur: "$", ret: 10, ter: 0.03, yld: 1.3, acc: false, about: "US-listed; often not buyable for EU investors" },
  { s: "QQQ", n: "Invesco QQQ (Nasdaq-100)", cur: "$", ret: 12, ter: 0.20, yld: 0.6, acc: false, about: "US-listed; often not buyable for EU investors" },
  { s: "VTI", n: "Vanguard Total Stock Market ETF", cur: "$", ret: 9.5, ter: 0.03, yld: 1.3, acc: false, about: "US-listed; often not buyable for EU investors" },
];
const CALC_TAX = 27.5, CALC_SPREAD = 3, CALC_INFLATION = 2;
const CALC_DEFAULTS = { etf: "VWCE.DE", initial: 1000, monthly: 100, years: 20, reinvest: true, tax: true, real: false };

const calcSaved = {
  get() { try { return JSON.parse(localStorage.getItem("calc") || "{}"); } catch (e) { return {}; } },
  set(v) { try { localStorage.setItem("calc", JSON.stringify(v)); } catch (e) { /* private mode */ } },
};

// ETFs you follow on the watchlist but that aren't in the list above: their
// numbers come from the app's data (only ~2 years of prices, so less reliable).
function calcWatchlistEtfs() {
  const known = new Set(CALC_ETFS.map((e) => e.s));
  return (state.data?.quotes || []).filter((q) => !known.has(q.symbol) &&
    (q.group === "etf" || /\bETF\b|UCITS|iShares|Vanguard|Xtrackers|SPDR|Amundi/i.test(q.name || "")));
}

function calcEtfInfo(symbol) {
  const preset = CALC_ETFS.find((e) => e.s === symbol);
  if (preset) return { ...preset, src: "preset" };
  const q = (state.data?.quotes || []).find((x) => x.symbol === symbol);
  if (!q) return null;
  // Yearly growth over the price history we have, plus last year's dividends.
  const candles = historyCache[q.file];
  let ret = null;
  if (candles?.length > 200) {
    const first = candles[0], last = candles[candles.length - 1];
    const yrs = (Date.parse(last[0]) - Date.parse(first[0])) / (365.25 * 86400000);
    if (first[4] > 0 && yrs > 0.8) ret = (Math.pow(last[4] / first[4], 1 / yrs) - 1) * 100;
  }
  // Fund numbers from Yahoo (fractions: 0.002 = 0.2%), when the app has them.
  const f = (state.data.fundamentals || {})[symbol] || {};
  const ter = f.fee != null ? f.fee * 100 : 0.2;
  if (f.return_5y != null) {  // the fund's own 5-year average, after its costs
    const yld5 = f.fund_yield != null ? f.fund_yield * 100 : 0;
    return { s: symbol, n: q.name, cur: q.currency || "€", file: q.file, ret: +(f.return_5y * 100 + ter).toFixed(1),
      ter: +ter.toFixed(2), yld: +yld5.toFixed(2), acc: yld5 === 0, src: "5y", about: "" };
  }
  const d = (state.data.dividends || {})[symbol];
  let yld = f.fund_yield != null ? f.fund_yield * 100 : 0;
  if (!yld && d?.history?.length && q.last) {
    const yearAgo = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
    yld = d.history.filter(([dt]) => dt > yearAgo).reduce((s, [, a]) => s + a, 0) / q.last * 100;
  }
  return { s: symbol, n: q.name, cur: q.currency || "€", file: q.file,
    ret: ret == null ? 8 : +(ret + yld + ter).toFixed(1), ter: +ter.toFixed(2), yld: +yld.toFixed(2),
    acc: yld === 0, src: ret == null ? "guess" : "history", about: "" };
}

// The month-by-month estimate. Returns one point per year.
function calcSimulate(p) {
  const months = p.years * 12;
  const growth = Math.pow(1 + (p.ret - p.yld) / 100, 1 / 12);       // price growth per month
  const feeCut = 1 - Math.pow(1 - p.ter / 100, 1 / 12);              // share of value lost to costs each month
  const divRate = p.yld / 100 / 12, taxRate = p.tax ? CALC_TAX / 100 : 0;
  let value = p.initial + p.monthly, basis = value, putIn = value;   // first monthly saving goes in right away
  let fees = 0, divGross = 0, divTax = 0, paidOut = 0;
  const points = [{ y: 0, value, putIn, paidOut }];
  for (let m = 1; m <= months; m++) {
    value *= growth;
    const fee = value * feeCut; value -= fee; fees += fee;
    const div = value * divRate, tax = div * taxRate;
    divGross += div; divTax += tax;
    if (p.reinvest) { value += div - tax; basis += div - tax; } else paidOut += div - tax;
    if (m % 12 === 0) points.push({ y: m / 12, value, putIn, paidOut });
    if (m < months) { value += p.monthly; basis += p.monthly; putIn += p.monthly; }  // next month's saving
  }
  const saleTax = Math.max(0, value - basis) * taxRate;
  return { points, value, putIn, fees, divGross, divTax, paidOut, saleTax, net: value - saleTax };
}

function calcParams() {
  const c = state.calc;
  const info = calcEtfInfo(c.etf) || { ...CALC_ETFS[0], src: "preset" };
  return { info, initial: Math.max(0, c.initial || 0), monthly: Math.max(0, c.monthly || 0),
    years: Math.min(50, Math.max(1, Math.round(c.years || 1))),
    ret: c.ret ?? info.ret, ter: c.ter ?? info.ter, yld: info.yld, reinvest: c.reinvest, tax: c.tax, real: c.real };
}

function calcView() {
  if (!state.calc) state.calc = { ...CALC_DEFAULTS, ...calcSaved.get() };
  const c = state.calc, p = calcParams(), e = p.info;
  const own = calcWatchlistEtfs();
  const option = (s, n) => `<option value="${esc(s)}" ${s === c.etf ? "selected" : ""}>${esc(n)} · ${esc(s)}</option>`;
  const num = (id, label, v, extra = "") => `<label>${label}<input id="${id}" type="number" inputmode="decimal" step="any" min="0" value="${v}" ${extra}></label>`;
  const onWatchlist = (state.data?.quotes || []).find((q) => q.symbol === e.s);
  const srcNote = e.src === "preset" ? `is about the long-term average of what it tracks (${esc(e.about)})`
    : e.src === "5y" ? "comes from this fund's last 5 years (before its costs); 5 years is short, so long-term averages are often lower"
    : e.src === "history" ? "comes from the last ~2 years of prices only, so take it with a pinch of salt"
    : "is a general guess (no price history yet)";
  return `
    <p class="hint calc-intro">🧮 What could your money grow to? Pick an ETF, how much you put in, and for how long.</p>
    <form class="card settings calc-form" id="calc-form" autocomplete="off" onsubmit="return false">
      <label class="k">ETF
        <select id="c-etf">
          <optgroup label="Popular ETFs (buyable at flatex)">${CALC_ETFS.filter((x) => x.cur === "€").map((x) => option(x.s, x.n)).join("")}</optgroup>
          ${own.length ? `<optgroup label="From your watchlist">${own.map((q) => option(q.symbol, q.name)).join("")}</optgroup>` : ""}
          <optgroup label="US-listed">${CALC_ETFS.filter((x) => x.cur === "$").map((x) => option(x.s, x.n)).join("")}</optgroup>
        </select></label>
      <div class="time-row">
        ${num("c-initial", `One-time amount (${esc(e.cur.trim())})`, c.initial)}
        ${num("c-monthly", `Every month (${esc(e.cur.trim())})`, c.monthly)}
      </div>
      <label class="k">For how long: <b id="c-years-v">${p.years} years</b>
        <input id="c-years" type="range" min="1" max="40" step="1" value="${p.years}"></label>
      <div class="time-row">
        ${num("c-ret", "Expected return / year (%)", +p.ret.toFixed(2), 'max="40"')}
        ${num("c-ter", "Yearly cost, TER (%)", +p.ter.toFixed(2), 'max="5"')}
      </div>
      <p class="hint">📈 ${+e.ret.toFixed(2)}% a year ${srcNote}.
        <button type="button" class="link-btn" data-act="calc-reset" ${c.ret != null || c.ter != null ? "" : "hidden"}>↺ Use the ETF's numbers</button>
        ${onWatchlist ? `<a href="#/s/${esc(onWatchlist.file)}">See chart ›</a>` : ""}</p>
      <div class="k">Dividends (≈ ${+p.yld.toFixed(2)}% a year)</div>
      <div class="seg wide" data-seg="calc-div">
        <button type="button" data-v="re" class="${c.reinvest ? "on" : ""}">🔁 Reinvest</button>
        <button type="button" data-v="out" class="${c.reinvest ? "" : "on"}">💶 Pay out to me</button></div>
      <div class="sep"></div>
      <label class="toggle-row"><span><b>🇦🇹 Austrian tax (KESt ${CALC_TAX}%)</b><span class="hint">On dividends every year, and on the profit when you sell.</span></span>
        <input type="checkbox" id="c-tax" ${c.tax ? "checked" : ""}><span class="switch"></span></label>
      <label class="toggle-row"><span><b>🛒 In today's money</b><span class="hint">Takes off ${CALC_INFLATION}% inflation a year, so you see what it could buy today.</span></span>
        <input type="checkbox" id="c-real" ${c.real ? "checked" : ""}><span class="switch"></span></label>
    </form>
    <div id="calc-out"></div>
    <div class="card" style="padding:10px 6px 6px;margin-top:10px">
      <div class="legend"><span><i style="background:var(--up-mark)"></i>Estimated value</span>
        <span><i style="background:var(--ink-2)"></i>Money you put in</span>
        <span><i class="dash"></i>Bad / good years (±${CALC_SPREAD}%)</span></div>
      <div class="readout num" id="calc-readout">Touch the chart to see each year.</div>
      <div id="calc-chart"></div>
    </div>
    <div id="calc-table"></div>
    <p class="disclaimer">⚠️ This is an estimate, not a promise. Markets can fall 30–50% in a bad year and
      stay down for years; the past doesn't guarantee the future. Tax is simplified (flatex AT handles the
      real KESt for you); currency changes and buying fees are not included.</p>`;
}

// Fills in the numbers and the chart. Runs on every change, without redrawing the form.
function calcUpdate() {
  const p = calcParams(), cur = p.info.cur;
  const base = calcSimulate(p);
  const bad = calcSimulate({ ...p, ret: p.ret - CALC_SPREAD }), good = calcSimulate({ ...p, ret: p.ret + CALC_SPREAD });
  const deflate = (v, y) => (p.real ? v / Math.pow(1 + CALC_INFLATION / 100, y) : v);
  const m0 = (v) => money(v, cur).replace(/\.\d\d$/, "");
  const Y = p.years, d = (v) => deflate(v, Y);
  const growth = base.value - base.putIn;
  const out = document.getElementById("calc-out");
  if (!out) return;
  const reset = document.querySelector("[data-act=calc-reset]");
  if (reset) reset.hidden = state.calc.ret == null && state.calc.ter == null;
  out.innerHTML = `
    <div class="card pf-total calc-result">
      <div class="k">Estimated value after ${Y} year${Y === 1 ? "" : "s"}${p.real ? " · in today's money" : ""}</div>
      <div class="big num">${m0(d(base.value))}</div>
      <div class="pf-sub num">You put in ${m0(base.putIn)} · <span class="up-text">${growth >= 0 ? "+" : ""}${m0(d(growth))} growth</span></div>
      <div class="calc-range num">Bad years: <b>${m0(d(bad.value))}</b> · Good years: <b>${m0(d(good.value))}</b></div>
      <div class="pf-grid num">
        ${p.tax ? `<div><span class="k">If you sell, after tax</span><b>${m0(d(base.net))}</b></div>
          <div><span class="k">Tax when you sell</span><b>${m0(d(base.saleTax))}</b></div>` : ""}
        <div><span class="k">Dividends (before tax)</span><b>${m0(d(base.divGross))}</b></div>
        ${p.reinvest ? `<div><span class="k">Reinvested for you</span><b>${m0(d(base.divGross - base.divTax))}</b></div>`
          : `<div><span class="k">Paid out to you${p.tax ? " (after tax)" : ""}</span><b>${m0(d(base.paidOut))}</b></div>`}
        ${p.tax ? `<div><span class="k">Tax on dividends</span><b>${m0(d(base.divTax))}</b></div>` : ""}
        <div><span class="k">ETF costs (TER)</span><b>${m0(d(base.fees))}</b></div>
      </div>
      ${!p.reinvest && base.paidOut > 0 ? `<p class="hint">💶 In the last year it pays you about ${m0(d(base.points[Y].value * p.yld / 100 * (1 - (p.tax ? CALC_TAX / 100 : 0))))} (≈ ${m0(d(base.points[Y].value * p.yld / 100 * (1 - (p.tax ? CALC_TAX / 100 : 0)) / 12))} a month).</p>` : ""}
    </div>`;

  // Year-by-year table (every 5 years, plus the last one).
  const years = base.points.filter((pt) => pt.y > 0 && (pt.y % 5 === 0 || pt.y === Y || (Y <= 5)));
  document.getElementById("calc-table").innerHTML = `<h2 class="section-title">📅 Year by year</h2>
    <div class="card calc-table-card"><table class="calc-table num">
      <tr><th>Year</th><th>Put in</th><th>Value</th><th>Bad · good</th></tr>
      ${years.map((pt) => `<tr><td>${pt.y}</td><td>${m0(pt.putIn)}</td><td><b>${m0(deflate(pt.value, pt.y))}</b></td>
        <td class="hint">${m0(deflate(bad.points[pt.y].value, pt.y))} · ${m0(deflate(good.points[pt.y].value, pt.y))}</td></tr>`).join("")}
    </table></div>`;

  calcDrawChart(p, base, bad, good, deflate);
}

function calcDrawChart(p, base, bad, good, deflate) {
  const el = document.getElementById("calc-chart");
  if (!el || !window.LightweightCharts) return;
  if (chart) { chart.remove(); chart = null; }
  const start = new Date().getFullYear();
  const t = (y) => `${start + y}-01-01`;
  chart = LightweightCharts.createChart(el, {
    autoSize: true,
    layout: { background: { type: "solid", color: "transparent" }, textColor: cssVar("--ink-3"), fontSize: 11,
      fontFamily: "-apple-system, BlinkMacSystemFont, Inter, sans-serif" },
    grid: { vertLines: { visible: false }, horzLines: { color: cssVar("--chart-grid") } },
    rightPriceScale: { borderVisible: false },
    timeScale: { borderVisible: false, fixLeftEdge: true, fixRightEdge: true, tickMarkFormatter: (time) => String(time.year ?? time).slice(0, 4) },
    localization: { priceFormatter: (v) => money(v, p.info.cur).replace(/\.\d\d$/, "") },
    crosshair: { mode: 0, vertLine: { labelVisible: false }, horzLine: { labelVisible: false } },
    handleScale: false, handleScroll: false,
  });
  const green = cssVar("--up-mark"), ink2 = cssVar("--ink-2"), ink3 = cssVar("--ink-3");
  const thin = { lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, color: ink3 };
  const series = (pts, key = "value") => pts.map((pt) => ({ time: t(pt.y), value: deflate(pt[key], pt.y) }));
  const goodS = chart.addLineSeries(thin); goodS.setData(series(good.points));
  const badS = chart.addLineSeries(thin); badS.setData(series(bad.points));
  const main = chart.addAreaSeries({ lineColor: green, lineWidth: 2, topColor: green + "40", bottomColor: green + "05",
    priceLineVisible: false, crosshairMarkerRadius: 4 });
  main.setData(series(base.points));
  const putIn = chart.addLineSeries({ color: ink2, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  putIn.setData(base.points.map((pt) => ({ time: t(pt.y), value: pt.putIn })));
  chart.timeScale().fitContent();

  const readout = document.getElementById("calc-readout");
  const m0 = (v) => money(v, p.info.cur).replace(/\.\d\d$/, "");
  chart.subscribeCrosshairMove((ev) => {
    const v = ev.time && ev.seriesData.get(main);
    if (!v) { readout.textContent = "Touch the chart to see each year."; return; }
    const y = (ev.time.year ?? Number(String(ev.time).slice(0, 4))) - start;
    readout.textContent = `After ${y} yr: ${m0(v.value)} · put in ${m0(ev.seriesData.get(putIn)?.value ?? 0)} · bad ${m0(ev.seriesData.get(badS)?.value ?? 0)} · good ${m0(ev.seriesData.get(goodS)?.value ?? 0)}`;
  });
}

// Opens the calculator. Called by the router for #/calc and #/calc/<file>.
async function openCalc(file) {
  if (!state.calc) state.calc = { ...CALC_DEFAULTS, ...calcSaved.get() };
  const q = file && file !== "-" ? (state.data.quotes || []).find((x) => x.file === file || x.symbol === file) : null;
  const sym = q?.symbol || (CALC_ETFS.some((e) => e.s === file) ? file : null);
  const here = () => location.hash.startsWith("#/calc") || state.pfTab === "calc";
  if (sym && sym !== state.calc.etf) {
    state.calc.etf = sym; state.calc.ret = null; state.calc.ter = null; calcSaved.set(state.calc);
    view.innerHTML = pagePortfolio();  // the form was drawn for the previous ETF
  }
  // Watchlist ETFs need their price history for the yearly return.
  const wq = (state.data.quotes || []).find((x) => x.symbol === state.calc.etf);
  if (wq && !CALC_ETFS.some((e) => e.s === wq.symbol) && !historyCache[wq.file]) {
    try { historyCache[wq.file] = (await getJSON(`data/history/${wq.file}.json`)).candles; } catch (e) { /* use a guess */ }
    if (!here()) return;
    view.innerHTML = pagePortfolio();
  }
  calcUpdate();
}

function calcRead() {
  const c = state.calc, val = (id) => { const v = document.getElementById(id)?.value; return v === "" || v == null ? null : Number(v); };
  c.initial = val("c-initial") ?? 0; c.monthly = val("c-monthly") ?? 0; c.years = val("c-years") ?? c.years;
  const info = calcEtfInfo(c.etf);
  const r = val("c-ret"), f = val("c-ter");
  c.ret = r != null && info && Math.abs(r - info.ret) > 1e-9 ? r : null;  // null = follow the ETF's number
  c.ter = f != null && info && Math.abs(f - info.ter) > 1e-9 ? f : null;
  c.tax = !!document.getElementById("c-tax")?.checked; c.real = !!document.getElementById("c-real")?.checked;
  calcSaved.set(c);
}

view.addEventListener("input", (e) => {
  if (!e.target.closest("#calc-form") || e.target.id === "c-etf") return;
  calcRead();
  if (e.target.id === "c-years") document.getElementById("c-years-v").textContent = `${state.calc.years} year${state.calc.years === 1 ? "" : "s"}`;
  calcUpdate();
});
view.addEventListener("change", (e) => {
  if (e.target.id === "c-etf") {
    calcRead();
    state.calc.etf = e.target.value; state.calc.ret = null; state.calc.ter = null;
    calcSaved.set(state.calc);
    location.hash = `#/calc/${encodeURIComponent((state.data.quotes || []).find((q) => q.symbol === e.target.value)?.file || e.target.value)}`;
  } else if (e.target.closest("#calc-form")) { calcRead(); calcUpdate(); }
});
view.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b || !b.closest("#calc-form")) return;
  if (b.dataset.act === "calc-reset") {
    state.calc.ret = null; state.calc.ter = null; calcSaved.set(state.calc);
    const scroll = window.scrollY; render(); window.scrollTo(0, scroll);
  }
  const seg = b.closest("[data-seg]");
  if (seg?.dataset.seg === "calc-div") {
    state.calc.reinvest = b.dataset.v === "re"; calcSaved.set(state.calc);
    seg.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    calcUpdate();
  }
});

// Show "🧮 What if I invest?" on the page of an ETF.
function calcIsEtf(q) {
  return q.group === "etf" || CALC_ETFS.some((e) => e.s === q.symbol) || calcWatchlistEtfs().some((x) => x.symbol === q.symbol);
}
