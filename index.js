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

async function getStockPrice(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbol}`;
    const resp = await axios.get(url);
    const data = resp.data.quoteResponse.result[0];

    if (!data) return null;

    return {
      name: data.longName || data.shortName,
      price: data.regularMarketPrice,
      change: data.regularMarketChange,
      percent: data.regularMarketChangePercent,
      time: new Date(data.regularMarketTime * 1000).toLocaleString(),
    };
  } catch {
    return null;
  }
}

async function getExchangeRate(pair) {
  try {
    const url = `https://api.exchangerate.host/latest?base=${pair}`;
    const resp = await axios.get(url);
    return resp.data.rates;
  } catch {
    return null;
  }
}

async function handleEvent(event) {
  if (event.type !== "message") return null;
  if (event.message.type !== "text") return null;

  const text = event.message.text.trim();

  // 查台積電
  if (text.includes("台積電")) {
    const stock = await getStockPrice("2330.TW");
    if (!stock) {
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "⚠️ 無法取得股價資料",
      });
    }

    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        `📈 ${stock.name}\n` +
        `現價：${stock.price}\n` +
        `漲跌：${stock.change} (${stock.percent}%)\n` +
        `時間：${stock.time}\n` +
        `資料來源：Yahoo Finance`,
    });
  }

  // 查匯率
  if (text.includes("匯率")) {
    const rate = await getExchangeRate("USD");
    if (!rate) {
      return client.replyMessage(event.replyToken, {
        type: "text",
        text: "⚠️ 無法取得匯率資料",
      });
    }

    return client.replyMessage(event.replyToken, {
      type: "text",
      text:
        `💱 美金匯率\n` +
        `USD → TWD：${rate.TWD}\n` +
        `資料來源：ExchangeRate API`,
    });
  }

  // 其他問題交給 GPT
  const reply = await askGPT(text);

  return client.replyMessage(event.replyToken, {
    type: "text",
    text: reply.slice(0, 4000),
  });
}

async function askGPT(text) {
  try {
    const resp = await axios.post(
      "https://api.openai.com/v1/responses",
      {
        model: "gpt-4.1-mini",
        input: text,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    return resp.data.output_text || "（沒有取得回覆）";
  } catch {
    return "⚠️ GPT 回應錯誤";
  }
}

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
