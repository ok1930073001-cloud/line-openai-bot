"use strict";

require("dotenv").config();

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

/* ===========================
   股價查詢 (Yahoo + 備援)
=========================== */

async function getQuote(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbol}`;
    const resp = await axios.get(url, { timeout: 15000 });

    const data = resp.data?.quoteResponse?.result?.[0];
    if (data && data.regularMarketPrice) {
      return {
        symbol: data.symbol,
        name: data.longName || data.shortName,
        price: data.regularMarketPrice,
        change: data.regularMarketChange,
        percent: data.regularMarketChangePercent,
      };
    }
  } catch (e) {}

  return null;
}

/* ===========================
   OpenAI 回覆
=========================== */

async function askOpenAI(text) {
  try {
    const resp = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "請用繁體中文回答。" },
          { role: "user", content: text }
        ],
        temperature: 0.7
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    return resp.data.choices[0].message.content.trim();
  } catch (err) {
    console.error("OpenAI error:", err.response?.data || err.message);
    return "（沒有取得回覆）";
  }
}

/* ===========================
   LINE Webhook
=========================== */

app.get("/", (req, res) => res.send("OK"));

app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events || [];
    await Promise.all(events.map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error(err);
    res.status(200).end();
  }
});

async function handleEvent(event) {
  if (event.type !== "message") return null;
  if (event.message.type !== "text") return null;

  const text = event.message.text.trim();

  if (text.startsWith("/股價")) {
    const parts = text.split(" ");
    const symbol = parts[1] || "2330.TW";

    const q = await getQuote(symbol);
    if (!q) {
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "⚠️ 無法取得股價資料"
      });
    }

    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        `📈 ${q.name} (${q.symbol})\n` +
        `價格：${q.price}\n` +
        `漲跌：${q.change?.toFixed(2)} (${q.percent?.toFixed(2)}%)`
    });
  }

  const reply = await askOpenAI(text);

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: reply
  });
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
