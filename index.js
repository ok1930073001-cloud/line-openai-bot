"use strict";

require("dotenv").config();

const express = require("express");
const line = require("@line/bot-sdk");
const axios = require("axios");

// =====================
// Env
// =====================
const PORT = process.env.PORT || 10000;
const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;

const SERPAPI_KEY = process.env.SERPAPI_KEY || ""; // 用於 /web 即時搜尋（你已經設好了）
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ""; // 需要一般聊天走 OpenAI 才用（可留空）

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
    res.status(200).end(); // LINE 要求回 200，避免重送爆量
  }
});

app.listen(PORT, () => {
  console.log(`LINE bot webhook listening on port ${PORT}`);
});

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
  // 多空白整理
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

function toTicker(raw) {
  let t = safeText(raw).toUpperCase().trim();
  // 常見輸入：2330 / 2330.TW / 2330.tw / TSLA / AAPL
  // 若純數字 => 台股 .TW
  if (/^\d+$/.test(t)) return `${t}.TW`;
  // 若像 2330TW 也補點
  if (/^\d+TW$/.test(t)) return `${t.slice(0, -2)}.TW`;
  // 2330.TW / 2330.tw => 2330.TW
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

// =====================
// Technical Indicators
// =====================
function SMA(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i];
  return sum / period;
}

function EMA(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const k = 2 / (period + 1);
  let ema = values[0];
  for (let i = 1; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

function RSI(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  // 用最近 period 根計算
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

function MACD(closes) {
  // MACD(12,26,9)
  if (!Array.isArray(closes) || closes.length < 35) return null;

  // 先算序列 EMA12/EMA26（用簡單方式重建）
  const emaSeries = (period) => {
    const k = 2 / (period + 1);
    let ema = closes[0];
    const out = [ema];
    for (let i = 1; i < closes.length; i++) {
      ema = closes[i] * k + ema * (1 - k);
      out.push(ema);
    }
    return out;
  };

  const ema12 = emaSeries(12);
  const ema26 = emaSeries(26);
  const macdLine = ema12.map((v, i) => v - ema26[i]);

  // signal line EMA9 of macdLine
  const k = 2 / (9 + 1);
  let signal = macdLine[0];
  const signalSeries = [signal];
  for (let i = 1; i < macdLine.length; i++) {
    signal = macdLine[i] * k + signal * (1 - k);
    signalSeries.push(signal);
  }

  const lastMacd = macdLine[macdLine.length - 1];
  const lastSignal = signalSeries[signalSeries.length - 1];
  const hist = lastMacd - lastSignal;

  return { macd: lastMacd, signal: lastSignal, hist };
}

// =====================
// Data Fetch (Stooq + SerpApi)
// =====================
// quote: https://stooq.com/q/l/?s=2330.tw&i=d  (CSV 1 row)
// history: https://stooq.com/q/d/l/?s=2330.tw&i=d (CSV many rows)

async function fetchStooqQuote(ticker) {
  const s = ticker.toLowerCase(); // stooq 用小寫
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(s)}&i=d`;
  const { data } = await axios.get(url, { timeout: 15000 });
  // CSV header: Symbol,Date,Time,Open,High,Low,Close,Volume
  const lines = String(data).trim().split("\n");
  if (lines.length < 2) return null;

  const headers = lines[0].split(",").map((x) => x.trim());
  const vals = lines[1].split(",").map((x) => x.trim());
  const obj = {};
  headers.forEach((h, i) => (obj[h] = vals[i]));

  // 有時回傳 "N/D"
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

async function fetchStooqHistory(ticker, limit = 120) {
  const s = ticker.toLowerCase();
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(s)}&i=d`;
  const { data } = await axios.get(url, { timeout: 20000 });

  const lines = String(data).trim().split("\n");
  if (lines.length < 5) return null;

  // header: Date,Open,High,Low,Close,Volume
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
    if (!Number.isFinite(close) || !Number.isFinite(high) || !Number.isFinite(low)) continue;

    rows.push({
      date: row.date,
      open: parseFloat(row.open),
      high,
      low,
      close,
      volume: parseFloat(row.volume),
    });
  }

  // stooq 歷史是由舊到新
  if (rows.length === 0) return null;

  const sliced = rows.slice(-limit);
  return sliced;
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
// Stock Report
// =====================
function classifyTrend(lastClose, ma5, ma20) {
  if (ma5 === null || ma20 === null) return "資料不足";
  if (lastClose > ma5 && ma5 > ma20) return "偏多（多頭排列）";
  if (lastClose < ma5 && ma5 < ma20) return "偏空（空頭排列）";
  if (lastClose >= ma20 && lastClose <= ma5) return "震盪偏多";
  if (lastClose <= ma20 && lastClose >= ma5) return "震盪偏空";
  return "震盪整理";
}

function supportResistance(history, lookback = 30) {
  if (!history || history.length < lookback) return null;
  const recent = history.slice(-lookback);
  const lows = recent.map((r) => r.low);
  const highs = recent.map((r) => r.high);

  const support = Math.min(...lows);
  const resistance = Math.max(...highs);

  return { support, resistance, lookback };
}

async function getStockReport(rawTicker) {
  const ticker = toTicker(rawTicker);

  const quote = await fetchStooqQuote(ticker);
  if (!quote) {
    return `⚠️ 無法取得股價資料：${ticker}\n可能原因：代號不支援 / 來源暫時不穩 / 交易時間外。\n你可再試：/股價 2330 或 /股價 2330.TW 或 /web ${ticker} 股價`;
  }

  const history = await fetchStooqHistory(ticker, 140); // 夠算 MACD/RSI/MA
  if (!history || history.length < 40) {
    // 至少給基本報價
    return [
      `📌 ${ticker} 即時/最近收盤`,
      `收盤：${fmtNum(quote.close)}  開：${fmtNum(quote.open)}  高：${fmtNum(quote.high)}  低：${fmtNum(quote.low)}`,
      `量：${fmtInt(quote.volume)}  時間：${quote.date} ${quote.time}`,
      `（技術分析資料不足）`,
    ].join("\n");
  }

  const closes = history.map((r) => r.close);
  const last = history[history.length - 1];
  const prev = history[history.length - 2];

  const chg = last.close - prev.close;
  const chgPct = (chg / prev.close) * 100;

  const ma5 = SMA(closes, 5);
  const ma20 = SMA(closes, 20);
  const ma60 = SMA(closes, 60);

  const rsi14 = RSI(closes, 14);
  const macd = MACD(closes);

  const trend = classifyTrend(last.close, ma5, ma20);
  const sr = supportResistance(history, 30);

  // 訊號判斷
  const rsiSignal =
    rsi14 === null
      ? "RSI 資料不足"
      : rsi14 >= 70
      ? "RSI 過熱（≥70）→ 留意回檔"
      : rsi14 <= 30
      ? "RSI 過冷（≤30）→ 留意反彈"
      : "RSI 中性（30~70）";

  let macdSignal = "MACD 資料不足";
  if (macd) {
    macdSignal =
      macd.hist > 0
        ? "MACD 柱狀體>0（偏多）"
        : macd.hist < 0
        ? "MACD 柱狀體<0（偏空）"
        : "MACD 盤整";
  }

  const lines = [];
  lines.push(`📈 股價智能分析｜${ticker}`);
  lines.push(`時間：${quote.date} ${quote.time}`);
  lines.push(
    `收盤/現價：${fmtNum(quote.close)}（較前日 ${chg >= 0 ? "▲" : "▼"}${fmtNum(chg)} / ${fmtNum(chgPct, 2)
