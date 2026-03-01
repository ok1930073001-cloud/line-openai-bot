// index.js
// LINE x OpenAI (Responses API) with real-time web_search
// Works on Render Web Service

const express = require("express");
const line = require("@line/bot-sdk");
const axios = require("axios");

// =========================
// 1) ENV
// =========================
const PORT = process.env.PORT || 10000;

const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!LINE_ACCESS_TOKEN) throw new Error("Missing LINE_ACCESS_TOKEN");
if (!LINE_CHANNEL_SECRET) throw new Error("Missing LINE_CHANNEL_SECRET");
if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

// =========================
// 2) LINE client + Express
// =========================
const config = {
  channelAccessToken: LINE_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET,
};

const client = new line.Client(config);
const app = express();

// Health check
app.get("/", (req, res) => res.send("OK"));

// Webhook (ONLY keep one)
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events || [];
    await Promise.all(events.map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error("webhook error:", err);
    // LINE 建議就算錯也回 200，避免重送造成更多問題
    res.status(200).end();
  }
});

// =========================
// 3) Helpers
// =========================
function safeText(s) {
  return String(s ?? "")
    .replace(/\u0000/g, "")
    .trim();
}

// LINE text limit is large, but keep it safe
function truncateForLine(s, maxLen = 4500) {
  const t = safeText(s);
  if (t.length <= maxLen) return t;
  return t.slice(0, maxLen) + "\n…(內容過長已截斷)";
}

/**
 * 判斷是否需要即時查網路：
 * - 有指令：/查詢、/搜尋、/web、/股價、/匯率、/天氣、/新聞
 * - 或文字包含：今天、現在、最新、股價、匯率、天氣、新聞、價格、幾點、開盤、收盤
 */
function needsWebSearch(text) {
  const t = safeText(text);
  if (!t) return false;

  // Command triggers
  if (
    t.startsWith("/查詢") ||
    t.startsWith("/搜尋") ||
    t.startsWith("/web") ||
    t.startsWith("/股價") ||
    t.startsWith("/匯率") ||
    t.startsWith("/天氣") ||
    t.startsWith("/新聞")
  ) return true;

  // Keyword triggers
  const keywords = [
    "今天",
    "現在",
    "最新",
    "剛剛",
    "股價",
    "匯率",
    "天氣",
    "新聞",
    "價格",
    "即時",
    "開盤",
    "收盤",
    "盤中",
    "漲跌",
  ];
  return keywords.some((k) => t.includes(k));
}

/**
 * 把指令轉成更清楚的 query
 */
function normalizeQuery(text) {
  let t = safeText(text);

  // Remove command prefix
  const prefixes = ["/查詢", "/搜尋", "/web", "/股價", "/匯率", "/天氣", "/新聞"];
  for (const p of prefixes) {
    if (t.startsWith(p)) {
      t = t.slice(p.length).trim();
      break;
    }
  }

  // If user typed "/股價 台積電" -> "台積電 股價"
  if (text.startsWith("/股價")) {
    t = t ? `${t} 股價` : "台灣股票 股價";
  }
  if (text.startsWith("/匯率")) {
    t = t ? `${t} 匯率` : "台幣 匯率";
  }
  if (text.startsWith("/天氣")) {
    t = t ? `${t} 天氣` : "台灣 天氣";
  }
  if (text.startsWith("/新聞")) {
    t = t ? `${t} 最新新聞` : "台灣 最新新聞";
  }

  return t || safeText(text);
}

// =========================
// 4) OpenAI call (Responses API)
// =========================
async function askOpenAI({ userText, useWeb }) {
  const query = safeText(userText);

  // 專業版：統一輸出格式 + 需要時列出來源
  const systemPrompt = `
你是「專業版 AI 查詢系統」(繁體中文)。
規則：
1) 一律用繁體中文，語氣專業、清楚、可直接使用。
2) 若有即時資訊需求（股價/匯率/天氣/新聞/價格/今天/現在/最新），請使用 web_search。
3) 有使用 web_search 時：請在答案末尾加上「資料來源：」列出 2~5 個來源（用條列、簡短即可）。
4) 沒有 web_search 時：請明確說明你是根據一般知識推論，並給出下一步建議。
5) 盡量用條列，避免長篇廢話。
`;

  const body = {
    model: "gpt-4.1-mini",
    input: [
      { role: "system", content: systemPrompt.trim() },
      { role: "user", content: query },
    ],
  };

  // ✅ 關鍵：要指定 tools + tool_choice 才穩
  if (useWeb) {
    body.tools = [{ type: "web_search" }];
    body.tool_choice = "auto";
  }

  const resp = await axios.post("https://api.openai.com/v1/responses", body, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    timeout: 60000,
  });

  // 取出文字（兼容不同回傳格式）
  const data = resp.data || {};
  const outputText =
    data.output_text ??
    data.output?.[0]?.content?.[0]?.text ??
    data.output?.[0]?.content?.map((c) => c?.text).filter(Boolean).join("\n") ??
    "";

  return safeText(outputText) || "（我目前沒有拿到回覆內容）";
}

// =========================
// 5) Event handler
// =========================
async function handleEvent(event) {
  try {
    if (event.type !== "message") return null;
    if (event.message.type !== "text") return null;

    const text = safeText(event.message.text);
    if (!text) return null;

    // 小幫助指令
    if (text === "/help" || text === "help" || text === "幫助") {
      const helpMsg =
        "✅ 專業版 AI 查詢系統已啟用\n" +
        "你可以用這些指令：\n" +
        "• /查詢 內容（強制即時查網路）\n" +
        "• /搜尋 內容（同上）\n" +
        "• /股價 台積電\n" +
        "• /匯率 美金對台幣\n" +
        "• /天氣 屏東\n" +
        "• /新聞 AI 產業\n" +
        "或直接輸入問題（系統會自動判斷是否需要即時查詢）";
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: helpMsg,
      });
    }

    const useWeb = needsWebSearch(text);
    const query = normalizeQuery(text);

    const reply = await askOpenAI({ userText: query, useWeb });

    return client.replyMessage(event.replyToken, {
      type: "text",
      text: truncateForLine(reply),
    });
  } catch (err) {
    const status = err?.response?.status;
    const data = err?.response?.data;
    console.error("handleEvent error:", status, data || err?.message || err);

    // 避免 LINE 顯示空白，回傳一個固定訊息
    if (event?.replyToken) {
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "我剛剛有點忙不過來，請你再傳一次～",
      });
    }
    return null;
  }
}

// =========================
// 6) Start server
// =========================
app.listen(PORT, () => {
  console.log(`LINE bot webhook listening on port ${PORT}`);
});
app.listen(PORT, () => {
  console.log(`LINE bot webhook listening on port ${PORT}`);
});
