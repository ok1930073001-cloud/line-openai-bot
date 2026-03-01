"use strict";

require("dotenv").config();

const express = require("express");
const line = require("@line/bot-sdk");
const axios = require("axios");

const PORT = process.env.PORT || 10000;

const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!LINE_ACCESS_TOKEN || !LINE_CHANNEL_SECRET) {
  console.error("Missing LINE credentials");
  process.exit(1);
}

const config = {
  channelAccessToken: LINE_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET,
};

const client = new line.Client(config);
const app = express();

app.get("/", (req, res) => {
  res.send("OK");
});

app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events;
    await Promise.all(events.map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error(err);
    res.status(200).end();
  }
});

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});

// =======================
// OpenAI 回答
// =======================

async function askOpenAI(userText) {
  if (!OPENAI_API_KEY) {
    return "⚠️ OPENAI_API_KEY 未設定";
  }

  const response = await axios.post(
    "https://api.openai.com/v1/responses",
    {
      model: "gpt-4o-mini",
      input: userText
    },
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      }
    }
  );

  if (response.data.output_text) {
    return response.data.output_text;
  }

  return "（沒有取得回應）";
}

// =======================
// LINE 處理
// =======================

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") {
    return null;
  }

  const userText = event.message.text;

  // 指令測試
  if (userText === "/help") {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "機器人正常運作 ✅"
    });
  }

  // 其他全部交給 OpenAI
  const reply = await askOpenAI(userText);

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: reply
  });
}
