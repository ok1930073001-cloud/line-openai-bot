const express = require("express");
const line = require("@line/bot-sdk");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 10000;

const config = {
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.Client(config);

// 健康檢查
app.get("/", (req, res) => res.send("OK"));

app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events || [];
    await Promise.all(events.map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(200).end();
  }
});

function safeText(s) {
  return String(s || "").trim();
}

function needsWebSearch(text) {
  const keywords = [
    "今天",
    "現在",
    "最新",
    "股價",
    "匯率",
    "天氣",
    "新聞",
    "價格",
    "即時",
  ];
  return keywords.some((k) => text.includes(k)) || text.startsWith("/");
}

async function askOpenAI(text) {
  try {
    const useWeb = needsWebSearch(text);

    const body = {
      model: "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content:
            "你是專業即時查詢助理。若問題涉及即時資訊，請使用網路搜尋。用繁體中文回答，條列清楚。",
        },
        { role: "user", content: text },
      ],
    };

    if (useWeb) {
      body.tools = [{ type: "web_search" }];
      body.tool_choice = "auto";
    }

    const resp = await axios.post(
      "https://api.openai.com/v1/responses",
      body,
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const data = resp.data;

    // 🔥 全面掃描 output 取文字（最穩）
    let finalText = "";

    if (data.output_text) {
      finalText = data.output_text;
    } else if (Array.isArray(data.output)) {
      for (const item of data.output) {
        if (item.content && Array.isArray(item.content)) {
          for (const c of item.content) {
            if (c.text) {
              finalText += c.text + "\n";
            }
          }
        }
      }
    }

    finalText = safeText(finalText);

    return finalText || "⚠️ 已呼叫搜尋，但沒有取得文字內容。";
  } catch (err) {
    console.error("OpenAI error:", err.response?.data || err.message);
    return "⚠️ 查詢發生錯誤，請稍後再試。";
  }
}

async function handleEvent(event) {
  if (event.type !== "message") return null;
  if (event.message.type !== "text") return null;

  const userText = safeText(event.message.text);
  if (!userText) return null;

  const reply = await askOpenAI(userText);

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: reply.slice(0, 4000),
  });
}

app.listen(PORT, () => {
  console.log("LINE bot running on port", PORT);
});
app.listen(PORT, () => {
  console.log(`LINE bot webhook listening on port ${PORT}`);
});
