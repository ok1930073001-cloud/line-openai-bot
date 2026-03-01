const express = require("express");
const line = require("@line/bot-sdk");
const axios = require("axios");

const config = {
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

function safeText(s) {
  return String(s || "").replace(/\u0000/g, "").trim();
}

function isCommand(text) {
  return text.startsWith("/");
}

function needWebSearch(text) {
  // 你可以自行加規則：出現「最新、今天、現在、價格、股價、匯率、天氣、新聞」就偏向查網路
  const t = text.toLowerCase();
  const keywords = [
    "最新",
    "今天",
    "現在",
    "新聞",
    "天氣",
    "匯率",
    "股價",
    "價格",
    "bitcoin",
    "btc",
    "eth",
    "台積電",
    "tsmc",
    "usd",
    "jpy",
    "cny",
  ];
  return keywords.some((k) => t.includes(k));
}

function buildUserPrompt(text) {
  // 指令路由（專業版）
  // 用戶：/新聞 台灣最新AI新聞
  if (isCommand(text)) {
    const [cmd, ...rest] = text.split(" ");
    const query = rest.join(" ").trim();

    switch (cmd) {
      case "/查":
        return `請用網路搜尋查詢以下問題，整理成：\n1) 一句話摘要\n2) 重點條列\n3) 來源(最多3個：標題+連結)\n\n問題：${query || "（未提供問題）"}`;
      case "/新聞":
        return `請用網路搜尋整理最新新聞：${query || "台灣最新要聞"}。\n格式：\n- 摘要\n- 3~6則重點(每則含標題+一行摘要)\n- 來源連結(最多5個)`;
      case "/天氣":
        return `請用網路搜尋查詢天氣：${query || "台灣"}。\n格式：\n- 現況\n- 今日/明日重點\n- 來源連結(最多2個)`;
      case "/匯率":
        return `請用網路搜尋查詢匯率：${query || "USD/TWD"}。\n格式：\n- 現價\n- 今日區間/更新時間\n- 來源連結(最多2個)`;
      case "/股價":
        return `請用網路搜尋查詢股票價格：${query || "台積電"}。\n格式：\n- 現價\n- 漲跌幅\n- 更新時間\n- 來源連結(最多2個)`;
      case "/幣價":
        return `請用網路搜尋查詢加密貨幣價格：${query || "BTC"}。\n格式：\n- 現價\n- 漲跌幅\n- 更新時間\n- 來源連結(最多2個)`;
      default:
        return `使用者輸入了未知指令：${cmd}。\n請回覆可用指令：/查 /新聞 /天氣 /匯率 /股價 /幣價，並示範1個例子。`;
    }
  }

  // 非指令：一般聊天 -> 如果判斷需要即時資訊才查網路
  if (needWebSearch(text)) {
    return `請用網路搜尋取得最新資訊，並用繁體中文回答。\n格式：\n- 一句話結論\n- 重點(條列)\n- 來源(最多3個：標題+連結)\n\n問題：${text}`;
  }

  // 不需要查網路：正常對話
  return `請用繁體中文自然回答使用者問題（不必上網）。\n問題：${text}`;
}

async function askOpenAIPro(userText) {
  const prompt = buildUserPrompt(userText);

  const useWeb = isCommand(userText) || needWebSearch(userText);

  try {
    const body = {
      model: "gpt-4.1",
      input: [
        {
          role: "system",
          content:
            "你是專業版AI查詢系統：回答要清楚、可執行、少廢話。若使用網路搜尋，必須在最後附上來源(標題+網址)。若無法確認就說不確定。",
        },
        { role: "user", content: prompt },
      ],
    };

    if (useWeb) {
      body.tools = [{ type: "web_search" }];
    }

    const resp = await axios.post("https://api.openai.com/v1/responses", body, {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 60000,
    });

    const text =
      resp.data.output_text ??
      resp.data.output?.[0]?.content?.[0]?.text ??
      "（沒有取得回覆內容）";

    // LINE 訊息上限：單則文字有長度限制，太長先截斷避免發送失敗
    const maxLen = 1800;
    return text.length > maxLen ? text.slice(0, maxLen) + "\n\n（內容過長已截斷）" : text;
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    console.error("OpenAI error:", status, data || err.message);
    return "我剛剛查詢失敗了（可能是API Key/額度/請求格式問題）。你可以把 Render Logs 裡的錯誤截圖貼給我，我幫你精準修。";
  }
}

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

async function handleEvent(event) {
  if (event.type !== "message") return null;
  if (event.message.type !== "text") return null;

  const userText = safeText(event.message.text);
  if (!userText) return null;

  const replyText = await askOpenAIPro(userText);

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: replyText,
  });
}

const client = new line.Client(config);
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`LINE bot webhook listening on port ${PORT}`);
});
app.listen(PORT, () => {
  console.log(`LINE bot webhook listening on port ${PORT}`);
});
