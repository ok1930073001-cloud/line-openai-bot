require("dotenv").config();
const express = require("express");
const axios = require("axios");
const line = require("@line/bot-sdk");

const PORT = process.env.PORT || 3001;

const config = {
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

if (!config.channelAccessToken) throw new Error("Missing LINE_ACCESS_TOKEN");
if (!config.channelSecret) throw new Error("Missing LINE_CHANNEL_SECRET");
if (!process.env.OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

const app = express();
const client = new line.Client(config);

// 健康檢查：打開 ngrok 網址 / 會回 OK
app.get("/", (req, res) => res.send("OK"));

// ✅ 正確的 webhook（只保留一個）
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events || [];
    await Promise.all(events.map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error("webhook error:", err);
    // LINE 建議就算錯也回 200，避免一直重送造成更多問題
    res.status(200).end();
  }
});

async function handleEvent(event) {
  // 只處理文字訊息
  if (event.type !== "message") return null;
  if (event.message.type !== "text") return null;

  const userText = (event.message.text || "").trim();
  if (!userText) return null;

  // 呼叫 OpenAI（用 Responses API）
  const replyText = await askOpenAI(userText);

  // 回覆 LINE
  return client.replyMessage(event.replyToken, {
    type: "text",
    text: replyText,
  });
}

async function askOpenAI(text) {
  try {
    const resp = await axios.post(
      "https://api.openai.com/v1/responses",
      {
        model: "gpt-4.1-mini",
        input: `你是聊天助理。請用繁體中文回答，口吻自然。\n\n使用者：${text}`,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 60000,
      }
    );

    // responses API 可能回 output_text 或 output[0].content...
    const outputText =
      resp.data.output_text ??
      resp.data.output?.[0]?.content?.[0]?.text ??
      "（我剛剛沒有拿到回覆內容）";

    return String(outputText).trim() || "（空白回覆）";
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    console.error("OpenAI error:", status, data || err.message);
    return "我剛剛有點忙不過來，請你再傳一次～";
  }
}

app.listen(PORT, () => {
  console.log(`LINE bot webhook listening on port ${PORT}`);
});
