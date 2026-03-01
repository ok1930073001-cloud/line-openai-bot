"use strict";

require("dotenv").config();

const express = require("express");
const line = require("@line/bot-sdk");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

// =====================
// Env
// =====================
const PORT = process.env.PORT || 10000;
const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;

const SERPAPI_KEY = process.env.SERPAPI_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

// 掃描頻率（毫秒）
// 5分鐘 = 300000；你要更快例如2分鐘 = 120000
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS || 300000);

// 同一股票同一種提醒冷卻（避免洗版）
const ALERT_COOLDOWN_MS = Number(process.env.ALERT_COOLDOWN_MS || 30 * 60 * 1000);

if (!LINE_ACCESS_TOKEN || !LINE_CHANNEL_SECRET) {
  console.error("Missing LINE_ACCESS_TOKEN or LINE_CHANNEL_SECRET");
  process.exit(1);
}

// =====================
// LINE SDK
// =====================
const config = {
  channelAccessToken: LINE_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET,
};
const client = new line.Client(config);

// =====================
// Express
// =====================
const app = express();

app.get("/", (req, res) => res.send("OK"));

app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events || [];
    await Promise.all(events.map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error("webhook error:", err);
    res.status(200).end();
  }
});

app.listen(PORT, () => {
  console.log(`LINE bot webhook listening on port ${PORT}`);
});

// =====================
// Storage (Watchlist)
// =====================
// 建議 Render 掛 Disk 到 /data（最穩）
// 沒掛 disk 也能跑，只是重啟可能會清空
const DATA_DIR = process.env.DATA_DIR || "/data"; // 若沒掛 disk 也沒關係，會 fallback
const FALLBACK_DIR = path.join(__dirname, "data");
let STORE_DIR = DATA_DIR;

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch (_) {
    return false;
  }
}

if (!ensureDir(STORE_DIR)) {
  STORE_DIR = FALLBACK_DIR;
  ensureDir(STORE_DIR);
}

const STORE_FILE = path.join(STORE_DIR, "watchlist.json");

// 結構：
// {
//   users: {
//     "<userId>": {
//        tickers: ["2330.TW", "AAPL"],
//        prefs: { volumeBoost: 1.5, lookback: 20 }
//     }
//   }
// }
let store = { users: {} };

// 記錄上次提醒時間： key = `${userId}::${ticker}::${type}`
const lastAlertAt = new Map();

function loadStore() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const raw = fs.readFileSync(STORE_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") store = parsed;
    }
  } catch (e) {
    console.error("loadStore error:", e);
  }
}

function saveStore() {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), "utf-8");
  } catch (e) {
    console.error("saveStore error:", e);
  }
}

loadStore();

// =====================
// Helpers
// =====================
function safeText(s) {
  return String(s || "").replace(/\u0000/g, "").trim();
}

function isCommand(text) {
  const t = safeText(text);
  return t.startsWith("/") || t.startsWith("／");
}

function normalizeCommand(text) {
  let t = safeText(text).replace(/^／/, "/");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

function toTicker(raw) {
  let t = safeText(raw).toUpperCase().trim();
  if (/^\d+$/.test(t)) return `${t}.TW`;
  if (/^\d+TW$/.test(t)) return `${t.slice(0, -2)}.TW`;
  t = t.replace(/\.TW$/i, ".TW");
  return t;
}

function fmtNum(n, digits = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return Number(n).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function fmtInt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function clampText(text, max = 4500) {
  const t = safeText(text);
  if (t.length <= max) return t;
  return t.slice(0, max - 10) + "\n...(內容過長已截斷)";
}

function nowMs() {
  return Date.now();
}

function canAlert(userId, ticker, type) {
  const key = `${userId}::${ticker}::${type}`;
  const last = lastAlertAt.get(key) || 0;
  return nowMs() - last >= ALERT_COOLDOWN_MS;
}

function markAlert(userId, ticker, type) {
  const key = `${userId}::${ticker}::${type}`;
  lastAlertAt.set(key, nowMs());
}

// =====================
// Indicators
// =====================
function SMA(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i];
  return sum / period;
}

function RSI(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += -diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// =====================
// Data Fetch (Stooq + SerpApi)
// =====================
async function fetchStooqQuote(ticker) {
  const s = ticker.toLowerCase();
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(s)}&i=d`;
  const { data } = await axios.get(url, { timeout: 15000 });

  const lines = String(data).trim().split("\n");
  if (lines.length < 2) return null;

  const headers = lines[0].split(",").map((x) => x.trim());
  const vals = lines[1].split(",").map((x) => x.trim());
  const obj = {};
  headers.forEach((h, i) => (obj[h] = vals[i]));

  const close = parseFloat(obj.Close);
  if (!Number.isFinite(close)) return null;

  return {
    symbol: obj.Symbol,
    date: obj.Date,
    time: obj.Time,
    open: parseFloat(obj.Open),
    high: parseFloat(obj.High),
    low: parseFloat(obj.Low),
    close: close,
    volume: parseFloat(obj.Volume),
  };
}

async function fetchStooqHistory(ticker, limit = 140) {
  const s = ticker.toLowerCase();
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(s)}&i=d`;
  const { data } = await axios.get(url, { timeout: 20000 });

  const lines = String(data).trim().split("\n");
  if (lines.length < 5) return null;

  const header = lines[0].split(",").map((x) => x.trim().toLowerCase());
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",").map((x) => x.trim());
    if (parts.length < 6) continue;
    const row = {};
    header.forEach((h, idx) => (row[h] = parts[idx]));

    const close = parseFloat(row.close);
    const high = parseFloat(row.high);
    const low = parseFloat(row.low);
    const vol = parseFloat(row.volume);

    if (!Number.isFinite(close) || !Number.isFinite(high) || !Number.isFinite(low)) continue;

    rows.push({
      date: row.date,
      open: parseFloat(row.open),
      high,
      low,
      close,
      volume: Number.isFinite(vol) ? vol : 0,
    });
  }

  if (rows.length === 0) return null;
  return rows.slice(-limit); // 舊到新
}

async function serpSearch(query) {
  if (!SERPAPI_KEY) return null;

  const url = "https://serpapi.com/search.json";
  const params = {
    engine: "google",
    q: query,
    hl: "zh-tw",
    gl: "tw",
    api_key: SERPAPI_KEY,
    num: 5,
  };

  const { data } = await axios.get(url, { params, timeout: 20000 });

  const results = [];
  const organic = data.organic_results || [];
  for (const r of organic.slice(0, 5)) {
    if (!r.title || !r.link) continue;
    results.push({ title: r.title, link: r.link });
  }
  return results;
}

// =====================
// Stock Report (for /股價)
// =====================
function supportResistance(history, lookback = 30) {
  if (!history || history.length < lookback) return null;
  const recent = history.slice(-lookback);
  const support = Math.min(...recent.map((r) => r.low));
  const resistance = Math.max(...recent.map((r) => r.high));
  return { support, resistance, lookback };
}

async function getStockReport(rawTicker) {
  const ticker = toTicker(rawTicker);

  const quote = await fetchStooqQuote(ticker);
  if (!quote) {
    return `⚠️ 無法取得股價資料：${ticker}\n你可再試：/股價 2330 或 /web ${ticker} 股價`;
  }

  const history = await fetchStooqHistory(ticker, 160);
  if (!history || history.length < 40) {
    return [
      `📌 ${ticker} 最近收盤`,
      `收盤：${fmtNum(quote.close)}  開：${fmtNum(quote.open)}  高：${fmtNum(quote.high)}  低：${fmtNum(quote.low)}`,
      `量：${fmtInt(quote.volume)}  時間：${quote.date} ${quote.time}`,
      `（技術分析資料不足）`,
    ].join("\n");
  }

  const closes = history.map((r) => r.close);
  const vols = history.map((r) => r.volume);
  const last = history[history.length - 1];
  const prev = history[history.length - 2];

  const chg = last.close - prev.close;
  const chgPct = (chg / prev.close) * 100;

  const ma5 = SMA(closes, 5);
  const ma20 = SMA(closes, 20);
  const ma60 = SMA(closes, 60);
  const rsi14 = RSI(closes, 14);

  const sr = supportResistance(history, 30);

  const lines = [];
  lines.push(`📈 股價分析｜${ticker}`);
  lines.push(`時間：${quote.date} ${quote.time}`);
  lines.push(
    `收盤/現價：${fmtNum(quote.close)}（較前日 ${chg >= 0 ? "▲" : "▼"}${fmtNum(chg)} / ${fmtNum(chgPct, 2)}%）`
  );
  lines.push(`區間：高 ${fmtNum(quote.high)}｜低 ${fmtNum(quote.low)}｜開 ${fmtNum(quote.open)}｜量 ${fmtInt(quote.volume)}`);
  lines.push("");
  lines.push(`MA5：${fmtNum(ma5)}  MA20：${fmtNum(ma20)}  MA60：${fmtNum(ma60)}`);
  lines.push(`RSI14：${fmtNum(rsi14, 1)}`);

  // 量能提示（近20日平均）
  const avg20Vol = SMA(vols, 20);
  if (avg20Vol) {
    const volRatio = quote.volume / avg20Vol;
    lines.push(`量能：今日/近20均量 = ${fmtNum(volRatio, 2)}x`);
  }

  if (sr) {
    lines.push("");
    lines.push(`近${sr.lookback}日支撐/壓力（粗估）`);
    lines.push(`支撐：約 ${fmtNum(sr.support)}  ｜ 壓力：約 ${fmtNum(sr.resistance)}`);
  }

  lines.push("");
  lines.push("指令：/追蹤 
