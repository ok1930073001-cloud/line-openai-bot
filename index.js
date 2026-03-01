"use strict";

require("dotenv").config();
const express = require("express");
const line = require("@line/bot-sdk");
const axios = require("axios");

const PORT = process.env.PORT || 10000;
const LINE_ACCESS_TOKEN = process.env.LINE_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const SERPAPI_KEY = process.env.SERPAPI_KEY || "";

const config = {
  channelAccessToken: LINE_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET,
};
const client = new line.Client(config);

const app = express();

app.get("/", (req, res) => res.send("OK"));

app.post("/webhook", line.middleware(config), async (req, res) => {
  const events = req.body.events || [];
  await Promise.all(events.map(handleEvent));
  res.status(200).end();
});

app.listen(PORT, () => {
  console.log(`Running on ${PORT}`);
});

function toTicker(t) {
  t = t.toUpperCase().trim();
  if (/^\d+$/.test(t)) return t + ".TW";
  return t.replace(/\.TW$/i, ".TW");
}

async function fetchHistory(ticker) {
  const url = `https://stooq.com/q/d/l/?s=${ticker.toLowerCase()}&i=d`;
  const { data } = await axios.get(url);
  const rows = data.split("\n").slice(1).map(r => r.split(","));
  return rows
    .filter(r => r.length >= 6)
    .map(r => ({
      date: r[0],
      high: parseFloat(r[2]),
      low: parseFloat(r[3]),
      close: parseFloat(r[4]),
      volume: parseFloat(r[5])
    }));
}

function SMA(arr, n) {
  if (arr.length < n) return null;
  return arr.slice(-n).reduce((a,b)=>a+b,0)/n;
}

async function scanStock(raw) {
  const ticker = toTicker(raw);
  const data = await fetchHistory(ticker);
  if (!data || data.length < 30) return "資料不足";

  const last = data[data.length - 1];
  const closes = data.map(d=>d.close);
  const highs = data.slice(-21,-1).map(d=>d.high);
  const lows = data.slice(-21,-1).map(d=>d.low);

  const ma20 = SMA(closes,20);
  const refHigh = Math.max(...highs);
  const refLow = Math.min(...lows);

  let msg = `📊 ${ticker}\n收盤: ${last.close}\n`;

  if (last.close > refHigh) {
    msg += `🚀 突破近20日高點 ${refHigh}\n`;
  }
  if (last.close < refLow) {
    msg += `🧨 跌破近20日低點 ${refLow}\n`;
  }
  if (ma20) {
    if (last.close > ma20) msg += `📈 站上 MA20 (${ma20})\n`;
    else msg += `📉 跌破 MA20 (${ma20})\n`;
  }

  msg += "\n指令: /掃描 2330";

  return msg;
}

async function webSearch(q) {
  if (!SERPAPI_KEY) return "未設定 SERPAPI_KEY";
  const { data } = await axios.get("https://serpapi.com/search.json", {
    params: {
      engine: "google",
      q,
      hl: "zh-tw",
      gl: "tw",
      api_key: SERPAPI_KEY
    }
  });
  const results = data.organic_results || [];
  return results.slice(0,3)
    .map(r=>`• ${r.title}\n${r.link}`)
    .join("\n\n");
}

async function handleEvent(event) {
  if (event.type !== "message") return;
  const text = event.message.text.trim();

  if (text.startsWith("/掃描")) {
    const t = text.replace("/掃描","").trim();
    const result = await scanStock(t);
    return client.replyMessage(event.replyToken,{type:"text",text:result});
  }

  if (text.startsWith("/web")) {
    const q = text.replace("/web","").trim();
    const result = await webSearch(q);
    return client.replyMessage(event.replyToken,{type:"text",text:result});
  }

  return client.replyMessage(event.replyToken,{
    type:"text",
    text:"指令:\n/掃描 2330\n/web 台積電 最新新聞"
  });
}
