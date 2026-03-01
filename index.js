/**
 * LINE 專業版 AI 查詢系統（可直接整份覆蓋 index.js）
 * 功能：
 *  - 一般聊天：走 OpenAI
 *  - /web 查網頁（SerpApi，可選）
 *  - /追蹤 台股/美股 監控（Yahoo + Stooq 備援）
 *  - /清單 查看追蹤清單
 *  - /股價 查股價
 *  - /提醒 設提醒（分鐘/小時/指定時間）
 *  - /提醒清單 /取消提醒
 *
 * 需要 Render 環境變數：
 *  - LINE_ACCESS_TOKEN
 *  - LINE_CHANNEL_SECRET
 *  - OPENAI_API_KEY
 * 可選：
 *  - SERPAPI_KEY   (開啟 /web 即時查詢網頁；沒有也能聊天與股價)
 */

"use strict";

require("dotenv").config();

const express = require("express");
const line = require("@line/bot-sdk");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

// ===================== Config =====================
const PORT = process.env.PORT || 10000;

const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SERPAPI_KEY = process.env.SERPAPI_KEY || "";

// 監控設定
const TZ_OFFSET_HOURS = 8; // 台灣 UTC+8
const WATCH_CHECK_MS = 2 * 60 * 1000; // 每 2 分鐘檢查一次（Render free 可能休眠）
const WATCH_ALERT_PCT = 1.5; // 漲跌超過 1.5% 推播
const REMINDER_TICK_MS = 30 * 1000; // 每 30 秒掃描提醒

// 台灣常用公司名對照（你可自行加）
const TW_NAME_MAP = {
  "台積電": "2330.TW",
  "tsmc": "2330.TW",
  "聯發科": "2454.TW",
  "鴻海": "2317.TW",
  "富邦金": "2881.TW",
  "國泰金": "2882.TW",
  "中華電": "2412.TW",
  "台達電": "2308.TW",
};

// ===================== Safety checks =====================
if (!LINE_ACCESS_TOKEN) throw new Error("Missing LINE_ACCESS_TOKEN");
if (!LINE_CHANNEL_SECRET) throw new Error("Missing LINE_CHANNEL_SECRET");
if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

// LINE client
const config = {
  channelAccessToken: LINE_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET,
};
const client = new line.Client(config);

// Express
const app = express();

// ===================== Persistence =====================
const DATA_PATH = path.join(__dirname, "data.json");

const state = {
  users: {
    // userId: { watch: { "2330.TW": { lastPrice, lastNotifiedPrice, lastCheckedMs } }, reminders: [ ... ] }
  },
};

function loadState() {
  try {
    if (fs.existsSync(DATA_PATH)) {
      const raw = fs.readFileSync(DATA_PATH, "utf8");
      const obj = JSON.parse(raw);
      if (obj && typeof obj === "object") {
        if (obj.users && typeof obj.users === "object") state.users = obj.users;
      }
    }
  } catch (e) {
    console.error("Failed to load data.json:", e?.message || e);
  }
}
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(DATA_PATH, JSON.stringify(state, null, 2), "utf8");
    } catch (e) {
      console.error("Failed to save data.json:", e?.message || e);
    }
  }, 600);
}
function ensureUser(userId) {
  if (!state.users[userId]) state.users[userId] = { watch: {}, reminders: [] };
  return state.users[userId];
}

loadState();

// ===================== Helpers =====================
function safeText(s) {
  return String(s || "").replace(/\u0000/g, "").trim();
}

function nowMs() {
  return Date.now();
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function toTaipeiDate(ms) {
  // 轉成台灣時間（不依賴伺服器時區）
  const d = new Date(ms + TZ_OFFSET_HOURS * 3600 * 1000);
  return d;
}

function formatTaipei(ms) {
  const d = toTaipeiDate(ms);
  const y = d.getUTCFullYear();
  const m = pad2(d.getUTCMonth() + 1);
  const dd = pad2(d.getUTCDate());
  const hh = pad2(d.getUTCHours());
  const mm = pad2(d.getUTCMinutes());
  return `${y}-${m}-${dd} ${hh}:${mm}`;
}

function percentDiff(a, b) {
  if (typeof a !== "number" || typeof b !== "number" || a === 0) return 0;
  return ((b - a) / a) * 100;
}

function normalizeSymbol(input) {
  const q = safeText(input);
  if (!q) return null;

  // 命中中文別名
  const hit = TW_NAME_MAP[q] || TW_NAME_MAP[q.toLowerCase()];
  if (hit) return hit;

  // 2330 -> 2330.TW（台股常用）
  if (/^\d{4}$/.test(q)) return `${q}.TW`;

  // 已包含 .TW / .TWO / .US / .HK 等
  if (/^[A-Za-z0-9.\-]+$/.test(q)) {
    // 大寫比較好看
    return q.toUpperCase();
  }

  return null;
}

function isCommand(text) {
  return safeText(text).startsWith("/");
}

function needsWebSearch(text) {
  const t = safeText(text).toLowerCase();
  const keywords = [
    "最新",
    "新聞",
    "現在",
    "查詢",
    "搜尋",
    "web",
    "資料",
    "匯率",
    "天氣",
    "股價",
    "價格",
    "幾點",
    "哪裡",
  ];
  return keywords.some((k) => t.includes(k));
}

function parseDurationToMs(token) {
  // 支援：10m / 2h / 1d / 30分鐘 / 2小時 / 1天
  const t = safeText(token).toLowerCase();
  if (!t) return null;

  let m = t.match(/^(\d+)\s*(m|min|分鐘)$/);
  if (m) return Number(m[1]) * 60 * 1000;

  m = t.match(/^(\d+)\s*(h|hr|hour|小時)$/);
  if (m) return Number(m[1]) * 60 * 60 * 1000;

  m = t.match(/^(\d+)\s*(d|day|天)$/);
  if (m) return Number(m[1]) * 24 * 60 * 60 * 1000;

  // 只有數字：預設分鐘
  m = t.match(/^(\d+)$/);
  if (m) return Number(m[1]) * 60 * 1000;

  return null;
}

function parseTaipeiTimeToMs(spec) {
  // 支援：HH:MM（今天/明天如果已過）
  // 支援：明天 HH:MM
  // 支援：YYYY-MM-DD HH:MM
  const s = safeText(spec);
  if (!s) return null;

  // YYYY-MM-DD HH:MM
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})$/);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const hh = Number(m[4]);
    const mm = Number(m[5]);
    // 轉成 UTC ms：台北時間 = UTC+8
    const utcMs = Date.UTC(y, mo - 1, d, hh - TZ_OFFSET_HOURS, mm, 0, 0);
    return utcMs;
  }

  // 明天 HH:MM
  m = s.match(/^明天\s*(\d{1,2}):(\d{2})$/);
  if (m) {
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    const now = toTaipeiDate(nowMs());
    const y = now.getUTCFullYear();
    const mo = now.getUTCMonth();
    const d = now.getUTCDate() + 1;
    return Date.UTC(y, mo, d, hh - TZ_OFFSET_HOURS, mm, 0, 0);
  }

  // HH:MM（今天或明天）
  m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    const now = toTaipeiDate(nowMs());
    const y = now.getUTCFullYear();
    const mo = now.getUTCMonth();
    const d = now.getUTCDate();

    let target = Date.UTC(y, mo, d, hh - TZ_OFFSET_HOURS, mm, 0, 0);
    // 如果今天已過，就排明天
    if (target <= nowMs()) {
      target = Date.UTC(y, mo, d + 1, hh - TZ_OFFSET_HOURS, mm, 0, 0);
    }
    return target;
  }

  return null;
}

// ===================== Web Search (SerpApi) =====================
async function webSearch(query) {
  const q = safeText(query);
  if (!q) return { ok: false, error: "空白查詢" };

  if (!SERPAPI_KEY) {
    return {
      ok: false,
      error: "未設定 SERPAPI_KEY（請到 Render Environment 加上 SERPAPI_KEY 才能啟用 /web 即時查詢）",
    };
  }

  try {
    const url = "https://serpapi.com/search.json";
    const resp = await axios.get(url, {
      timeout: 20000,
      params: {
        engine: "google",
        q,
        hl: "zh-tw",
        gl: "tw",
        num: 5,
        api_key: SERPAPI_KEY,
      },
    });

    const results = [];
    const organic = resp.data?.organic_results || [];
    for (const r of organic.slice(0, 5)) {
      results.push({
        title: safeText(r.title),
        snippet: safeText(r.snippet),
        link: safeText(r.link),
      });
    }

    if (results.length === 0) return { ok: false, error: "查無結果或來源限制" };
    return { ok: true, results };
  } catch (e) {
    return { ok: false, error: e?.message || "webSearch 失敗" };
  }
}

// ===================== Stock Quote (Yahoo + Stooq fallback) =====================
async function getQuote(symbol) {
  // 1) Yahoo Finance (primary)
  try {
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`;
    const resp = await axios.get(url, {
      timeout: 15000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
        Accept: "application/json,text/plain,*/*",
        Referer: "https://finance.yahoo.com/",
      },
    });

    const data = resp.data?.quoteResponse?.result?.[0];
    if (data && typeof data.regularMarketPrice === "number") {
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
    }
  } catch (e) {
    // ignore and fallback
  }

  // 2) Stooq fallback (secondary)
  try {
    // Stooq：台股用 2330.tw；美股 AAPL.us
    let stooqSymbol = symbol.toLowerCase();
    if (stooqSymbol.endsWith(".tw")) stooqSymbol = stooqSymbol.replace(".tw", ".tw");
    const url = `https://stooq.com/q/l/?s=${encodeURIComponent(stooqSymbol)}&i=d`;
    const r = await axios.get(url, { timeout: 15000 });

    const lines = String(r.data || "").trim().split("\n");
    if (lines.length >= 2) {
      const headers = lines[0].split(",");
      const values = lines[1].split(",");
      const map = {};
      headers.forEach((h, i) => (map[h.trim()] = (values[i] || "").trim()));

      const close = Number(map["Close"]);
      const name = map["Name"] || symbol;

      if (!Number.isNaN(close) && close > 0) {
        return {
          symbol,
          name,
          price: close,
          change: null,
          percent: null,
          currency: "",
          marketState: "",
          ts: Date.now(),
        };
      }
    }
  } catch (e) {
    // ignore
  }

  return null;
}

// ===================== OpenAI =====================
async function askOpenAI(userText, webContext) {
  const text = safeText(userText);
  if (!text) return "你剛剛沒有輸入內容喔。";

  // 建議：把 webContext（若有）塞進 input
  const system = [
    "你是一個專業的『即時查詢 + 助理』。",
    "回覆請用繁體中文，語氣自然、清楚、條列為主。",
    "如果使用者問的是即時資訊（新聞、股價、匯率、天氣等），優先用我提供的『網頁搜尋摘要』回答；不足時再說明限制。",
    "如果使用者在問提醒/追蹤指令，請提示正確指令用法（例如 /提醒、/追蹤）。",
  ].join("\n");

  let input = `【使用者問題】\n${text}\n`;
  }
  if (!text) return "⚠️ 請加上提醒內容，例如：/提醒 30分鐘後 喝水";

  const list = 
