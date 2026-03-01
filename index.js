const express = require("express");
const line = require("@line/bot-sdk");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;

// ====== LINE Config ======
const config = {
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.Client(config);

// ====== Settings (你可調整) ======
const TZ_OFFSET_HOURS = 8;                 // Taiwan UTC+8
const WATCH_CHECK_MS = 2 * 60 * 1000;      // 追蹤輪詢頻率：2分鐘
const WATCH_ALERT_PCT = 1.5;               // 漲跌幅 >= 1.5% 推播（可改）
const REMINDER_TICK_MS = 3000;             // 提醒檢查：3秒

// ====== State Persistence ======
const STATE_FILE = path.join(__dirname, "bot_state.json");
/**
 * state schema:
 * {
 *   watchlists: { [toId]: { items: [{symbol,name}], last: { [symbol]: {price, ts} } } },
 *   reminders:  { [toId]: [{ id, atMs, text, createdMs }] }
 * }
 */
let state = loadState();

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, "utf8");
      const parsed = JSON.parse(raw);
      return {
        watchlists: parsed.watchlists || {},
        reminders: parsed.reminders || {},
      };
    }
  } catch (e) {
    console.error("loadState error:", e);
  }
  return { watchlists: {}, reminders: {} };
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (e) {
    console.error("saveState error:", e);
  }
}

// ====== Helpers ======
function safeText(s) {
  return String(s ?? "").replace(/\u0000/g, "").trim();
}

function isCommand(text) {
  return text.startsWith("/") || text.startsWith("／");
}
function stripCommandPrefix(text) {
  return safeText(text).replace(/^[/／]\s*/, "");
}

function chunkText(text, max = 4000) {
  const s = safeText(text);
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

async function reply(token, text) {
  return client.replyMessage(token, { type: "text", text: chunkText(text) });
}

async function push(to, text) {
  try {
    await client.pushMessage(to, { type: "text", text: chunkText(text) });
  } catch (e) {
    console.error("push error:", e?.message || e);
  }
}

function getToId(event) {
  // 優先推到群/房（如果是在群/房）不然推到 userId
  const src = event?.source || {};
  return src.groupId || src.roomId || src.userId || null;
}

// Taiwan time parsing (把「台灣時間」轉 epoch ms)
function makeTaipeiEpoch(y, m, d, hh, mm) {
  // 將「台灣時間」轉成 UTC epoch：UTC = 台灣時間 - 8 小時
  return Date.UTC(y, m - 1, d, hh - TZ_OFFSET_HOURS, mm, 0, 0);
}

function nowMs() {
  return Date.now();
}

// ====== Yahoo Finance: Symbol Resolve + Quote ======
async function resolveSymbol(query) {
  const q = safeText(query);
  if (!q) return null;

  // 台股代碼
  if (/^\d{4,6}$/.test(q)) return `${q}.TW`;

  // 美股/常見代碼
  if (/^[A-Za-z.\-^=]{1,15}$/.test(q)) return q.toUpperCase();

  // 中文/公司名 -> Yahoo search
  try {
    const url = "https://query2.finance.yahoo.com/v1/finance/search";
    const resp = await axios.get(url, { params: { q, quotesCount: 6, newsCount: 0 }, timeout: 15000 });
    const quotes = resp.data?.quotes || [];
    const preferred = quotes.find((x) => ["EQUITY", "ETF"].includes(x.quoteType));
    const best = preferred || quotes[0];
    return best?.symbol || null;
  } catch {
    return null;
  }
}

async function getQuote(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`;
    const resp = await axios.get(url, { timeout: 15000 });
    const data = resp.data?.quoteResponse?.result?.[0];
    if (!data) return null;

    return {
      symbol: data.symbol,
      name: data.longName || data.shortName || data.symbol,
      price: data.regularMarketPrice,
      change: data.regularMarketChange,
      percent: data.regularMarketChangePercent,
      currency: data.currency || "",
      marketState: data.marketState || "",
      ts: data.regularMarketTime ? data.regularMarketTime * 1000 : Date.now(),
    };
  } catch {
    return null;
  }
}

// ====== GPT (Responses API) ======
async function askGPT(input) {
  try {
    const resp = await axios.post(
      "https://api.openai.com/v1/responses",
      { model: "gpt-4.1-mini", input },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 30000,
      }
    );
    return resp.data?.output_text?.trim() || "（沒有取得回覆）";
  } catch {
    return "⚠️ GPT 發生錯誤（請確認 OPENAI_API_KEY / 方案餘額 / 服務狀態）";
  }
}

// ====== Reminder Time Parser ======
/**
 * 支援：
 *  - 10m / 2h / 1d
 *  - 30分鐘後 / 1小時後 / 2天後
 *  - 明天 09:00 / 今天 18:30 / 今晚 9點
 *  - 3/5 14:30（預設今年）
 *  - 2026/03/05 14:30 or 2026-03-05 14:30
 */
function parseReminderTime(input) {
  const s = safeText(input);
  if (!s) return null;

  const now = new Date();
  const nowY = now.getUTCFullYear(); // 用 UTC year，但我們會用台灣時間計算 epoch
  const baseMs = nowMs();

  // 10m / 2h / 1d
  let m = s.match(/^(\d+)\s*(m|min|分鐘|h|hr|小時|d|天)\s*(後)?$/i);
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2].toLowerCase();
    let add = 0;
    if (unit === "m" || unit === "min" || unit === "分鐘") add = n * 60 * 1000;
    else if (unit === "h" || unit === "hr" || unit === "小時") add = n * 60 * 60 * 1000;
    else if (unit === "d" || unit === "天") add = n * 24 * 60 * 60 * 1000;
    return baseMs + add;
  }

  // 30分鐘後 / 1小時後 / 2天後
  m = s.match(/^(\d+)\s*(分鐘|小時|天)\s*後$/);
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2];
    let add = 0;
    if (unit === "分鐘") add = n * 60 * 1000;
    if (unit === "小時") add = n * 60 * 60 * 1000;
    if (unit === "天") add = n * 24 * 60 * 60 * 1000;
    return baseMs + add;
  }

  // 明天/今天/今晚 + 時間
  // 明天 09:00 / 今天 18:30 / 今晚 9點 / 明天9點
  m = s.match(/^(今天|明天|今晚)\s*(\d{1,2})(?:[:：](\d{2}))?\s*(點)?$/);
  if (m) {
    const dayWord = m[1];
    let hh = parseInt(m[2], 10);
    let mm = m[3] ? parseInt(m[3], 10) : 0;
    if (dayWord === "今晚" && hh < 12) hh += 12;

    // 取「台灣日期」
    const taipeiNow = new Date(baseMs + TZ_OFFSET_HOURS * 3600 * 1000);
    let y = taipeiNow.getUTCFullYear();
    let mon = taipeiNow.getUTCMonth() + 1;
    let d = taipeiNow.getUTCDate();

    if (dayWord === "明天") {
      const t = new Date(makeTaipeiEpoch(y, mon, d, 0, 0) + 24 * 3600 * 1000);
      y = t.getUTCFullYear();
      mon = t.getUTCMonth() + 1;
      d = t.getUTCDate();
    }
    return makeTaipeiEpoch(y, mon, d, hh, mm);
  }

  // 3/5 14:30（預設今年）
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})\s+(\d{1,2})(?:[:：](\d{2}))$/);
  if (m) {
    const mon = parseInt(m[1], 10);
    const d = parseInt(m[2], 10);
    const hh = parseInt(m[3], 10);
    const mm = parseInt(m[4], 10);
    // 用台灣當下年份
    const taipeiNow = new Date(baseMs + TZ_OFFSET_HOURS * 3600 * 1000);
    const y = taipeiNow.getUTCFullYear();
    return makeTaipeiEpoch(y, mon, d, hh, mm);
  }

  // 2026/03/05 14:30 or 2026-03-05 14:30
  m = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})\s+(\d{1,2})(?:[:：](\d{2}))$/);
  if (m) {
    const y = parseInt(m[1], 10);
    const mon = parseInt(m[2], 10);
    const d = parseInt(m[3], 10);
    const hh = parseInt(m[4], 10);
    const mm = parseInt(m[5], 10);
    return makeTaipeiEpoch(y, mon, d, hh, mm);
  }

  return null;
}

function formatTaipeiTime(epochMs) {
  // 以台灣時間顯示：epoch + 8h 再用 UTC 格式輸出
  const t = new Date(epochMs + TZ_OFFSET_HOURS * 3600 * 1000);
  const y = t.getUTCFullYear();
  const m = String(t.getUTCMonth() + 1).padStart(2, "0");
  const d = String(t.getUTCDate()).padStart(2, "0");
  const hh = String(t.getUTCHours()).padStart(2, "0");
  const mm = String(t.getUTCMinutes()).padStart(2, "0");
  return `${y}-${m}-${d} ${hh}:${mm}（台灣）`;
}

function genId(prefix = "R") {
  return `${prefix}${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

// ====== Watchlist / Reminder Commands ======
function ensureWatchlist(to) {
  if (!state.watchlists[to]) state.watchlists[to] = { items: [], last: {} };
  return state.watchlists[to];
}
function ensureReminders(to) {
  if (!state.reminders[to]) state.reminders[to] = [];
  return state.reminders[to];
}

async function cmdWatchAdd(to, query) {
  if (!query) return "用法：/追蹤 台積電 或 /追蹤 2330 或 /追蹤 AAPL";

  const symbol = await resolveSymbol(query);
  if (!symbol) return `⚠️ 找不到「${query}」對應代碼`;

  const q = await getQuote(symbol);
  const name = q?.name || query;

  const wl = ensureWatchlist(to);
  const exists = wl.items.some((x) => x.symbol === symbol);
  if (exists) return `✅ 已在追蹤清單：${name}（${symbol}）`;

  wl.items.push({ symbol, name });
  // 初始化 last price
  if (q?.price != null) wl.last[symbol] = { price: q.price, ts: q.ts || Date.now() };

  saveState();
  return `✅ 已加入追蹤：${name}（${symbol}）\n（漲跌幅 ≥ ${WATCH_ALERT_PCT}% 會自動推播）`;
}

function cmdWatchList(to) {
  const wl = ensureWatchlist(to);
  if (!wl.items.length) {
    return "（追蹤清單是空的）\n用法：/追蹤 台積電";
  }
  const lines = wl.items.map((x, i) => `${i + 1}. ${x.name}（${x.symbol}）`);
  return `📌 追蹤清單（共 ${wl.items.length} 檔）\n` + lines.join("\n");
}

function cmdWatchRemove(to, query) {
  if (!query) return "用法：/取消追蹤 台積電 或 /取消追蹤 2330.TW";
  const wl = ensureWatchlist(to);
  const q = safeText(query);

  // 允許用 symbol 或 name 片段移除
  const idx = wl.items.findIndex(
    (x) => x.symbol.toUpperCase() === q.toUpperCase() || x.name.includes(q)
  );
  if (idx === -1) return `⚠️ 找不到要移除的追蹤：「${q}」`;

  const removed = wl.items.splice(idx, 1)[0];
  delete wl.last[removed.symbol];
  saveState();
  return `✅ 已取消追蹤：${removed.name}（${removed.symbol}）`;
}

function cmdReminderAdd(to, timeStr, text) {
  const atMs = parseReminderTime(timeStr);
  if (!atMs) {
    return (
      "⚠️ 時間格式看不懂\n" +
      "可用：\n" +
      "1) /提醒 30分鐘後 喝水\n" +
      "2) /提醒 2h 站起來走走\n" +
      "3) /提醒 明天 09:00 開會\n" +
      "4) /提醒 2026-03-05 14:30 回報"
    );
  }
  if (!text) return "⚠️ 請加上提醒內容，例如：/提醒 30分鐘後 喝水";

  const list = 
