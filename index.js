'use strict';

require('dotenv').config();

const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 10000;

// ===== LINE Config =====
const lineConfig = {
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

if (!lineConfig.channelAccessToken || !lineConfig.channelSecret) {
  console.error('Missing LINE env: LINE_ACCESS_TOKEN / LINE_CHANNEL_SECRET');
}

const client = new line.Client(lineConfig);

// ===== Helpers =====
function safeText(s) {
  return String(s ?? '').replace(/\u0000/g, '').trim();
}

function isCommand(text) {
  return safeText(text).startsWith('/');
}

function normalizeQuery(text) {
  let t = safeText(text);
  const prefixes = ['/查', '/搜尋', '/web', '/股票', '/匯率', '/天氣', '/新聞'];
  for (const p of prefixes) {
    if (t.startsWith(p)) {
      t = t.slice(p.length).trim();
      break;
    }
  }
  return t;
}

function needWebSearch(text) {
  const t = safeText(text).toLowerCase();
  const keywords = [
    '最新', '現在', '今日', '今天', '即時', '新聞', '天氣', '匯率',
    '股價', '股票', '台積電', 'tsmc', 'usd', 'jpy', 'eur',
  ];
  return keywords.some(k => t.includes(k));
}

// ===== OpenAI (simple, stable) =====
async function askOpenAI(userText) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return '我這邊沒有設定 OPENAI_API_KEY，所以無法使用 AI 回覆。';

  try {
    // 使用 Chat Completions（你原本也用這個）
    const resp = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: '你是專業查詢型AI助理。回答要清楚、精準、以繁體中文為主。' },
          { role: 'user', content: userText },
        ],
        temperature: 0.2,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 60000,
      }
    );

    const text = resp?.data?.choices?.[0]?.message?.content;
    return safeText(text) || '（沒有取得回覆內容）';
  } catch (err) {
    const status = err?.response?.status;
    const data = err?.response?.data;
    console.error('OpenAI error:', status, data || err.message);
    return '我剛剛連線 AI 失敗了，請稍後再試一次。';
  }
}

// ===== Web Search via SerpApi (recommended) =====
async function webSearch(query) {
  const key = process.env.SERPAPI_KEY;
  if (!key) {
    return '⚠️ 目前未設定 SERPAPI_KEY，所以無法即時查詢網頁。\n請到 Render → Environment 加上 SERPAPI_KEY 後再試。';
  }

  const q = safeText(query);
  if (!q) return '請輸入要查詢的內容。';

  try {
    const url = 'https://serpapi.com/search.json';
    const resp = await axios.get(url, {
      params: {
        engine: 'google',
        q,
        hl: 'zh-TW',
        gl: 'tw',
        api_key: key,
        num: 5,
      },
      timeout: 60000,
    });

    const data = resp.data || {};
    const results = data.organic_results || [];
    if (!results.length) return `找不到「${q}」的結果。`;

    // 摘要前 3 筆
    const top = results.slice(0, 3).map((r, i) => {
      const title = r.title || '(無標題)';
      const link = r.link || '';
      const snippet = r.snippet || '';
      return `【${i + 1}】${title}\n${snippet}\n${link}`.trim();
    });

    return `🔎 即時查詢：${q}\n\n${top.join('\n\n')}`;
  } catch (err) {
    const status = err?.response?.status;
    const data = err?.response?.data;
    console.error('SerpApi error:', status, data || err.message);
    return '即時查詢失敗（SerpApi 連線錯誤）。請稍後再試。';
  }
}

// ===== Quote (stock) via SerpApi =====
// 支援：/股價 2330 或 /股價 2330.TW 或 /股價 AAPL
async function getQuote(symbolRaw) {
  const key = process.env.SERPAPI_KEY;
  if (!key) {
    return '⚠️ 查股價需要 SERPAPI_KEY。\n請到 Render → Environment 加上 SERPAPI_KEY。';
  }

  let sym = safeText(symbolRaw);
  if (!sym) return '請輸入股票代號，例如：/股價 2330 或 /股價 2330.TW 或 /股價 AAPL';

  // 如果是純數字，預設台股 .TW
  if (/^\d+$/.test(sym)) sym = `${sym}.TW`;

  try {
    // SerpApi 的 Google Finance 結果通常很好抓
    const resp = await axios.get('https://serpapi.com/search.json', {
      params: {
        engine: 'google_finance',
        q: sym,
        api_key: key,
      },
      timeout: 60000,
    });

    const gf = resp?.data?.summary || resp?.data?.stock;
    // 不同 engine 回傳可能不同，保守處理
    const price =
      resp?.data?.price ||
      resp?.data?.summary?.price ||
      resp?.data?.stock?.price ||
      resp?.data?.markets?.[0]?.price;

    const title =
      resp?.data?.title ||
      resp?.data?.summary?.title ||
      resp?.data?.stock?.title ||
      sym;

    if (!price) {
      // fallback: 用一般 google 搜尋抓 “sym 股價”
      const fallback = await axios.get('https://serpapi.com/search.json', {
        params: {
          engine: 'google',
          q: `${sym} 股價`,
          hl: 'zh-TW',
          gl: 'tw',
          api_key: key,
          num: 5,
        },
        timeout: 60000,
      });

      const ans = fallback?.data?.answer_box;
      const organic = fallback?.data?.organic_results?.[0];
      const p =
        ans?.price ||
        ans?.answer ||
        ans?.snippet ||
        organic?.snippet;

      if (!p) return `找不到 ${sym} 的股價資料。`;
      return `📈 ${sym}\n${p}`;
    }

    return `📈 ${title}\n即時價格：${price}\n代號：${sym}`;
  } catch (err) {
    const status = err?.response?.status;
    const data = err?.response?.data;
    console.error('getQuote error:', status, data || err.message);
    return '⚠️ 無法取得股價資料（查詢來源失敗）。';
  }
}

// ===== Command Router =====
async function handleCommand(text) {
  const raw = safeText(text);

  // /股價 2330 或 /股價 2330.TW
  if (raw.startsWith('/股價') || raw.startsWith('/股票')) {
    const q = normalizeQuery(raw);
    return await getQuote(q);
  }

  // /web 查 台積電 最新新聞
  if (raw.startsWith('/web') || raw.startsWith('/查') || raw.startsWith('/搜尋') || raw.startsWith('/新聞') || raw.startsWith('/天氣') || raw.startsWith('/匯率')) {
    const q = normalizeQuery(raw);
    return await webSearch(q);
  }

  // 未知指令
  return '指令用法：\n/股價 2330\n/web 查 台積電 最新新聞\n/天氣 台北\n/匯率 USD TWD';
}

// ===== LINE Webhook =====
app.get('/healthz', (req, res) => res.status(200).send('OK'));

app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  try {
    const events = req.body.events || [];
    await Promise.all(events.map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error('webhook error:', err);
    res.status(200).end();
  }
});

async function handleEvent(event) {
  if (event.type !== 'message') return;
  if (event.message.type !== 'text') return;

  const userText = safeText(event.message.text);
  if (!userText) return;

  let reply = '';

  // 指令模式
  if (isCommand(userText)) {
    reply = await handleCommand(userText);
  } else {
    // 非指令：如果判斷需要即時查詢，先給 webSearch，再交給 AI 摘要
    if (needWebSearch(userText)) {
      const web = await webSearch(userText);
      // 如果沒有 SERPAPI_KEY，就直接回提示，不硬接 AI
      if (web.includes('未設定 SERPAPI_KEY')) {
        reply = web;
      } else {
        const ai = await askOpenAI(`根據以下即時查詢結果，用繁中整理重點並回答使用者問題。\n\n使用者問題：${userText}\n\n查詢結果：\n${web}`);
        reply = ai;
      }
    } else {
      // 一般聊天：直接 AI
      reply = await askOpenAI(userText);
    }
  }

  reply = safeText(reply) || '（沒有取得回覆內容）';

  return client.replyMessage(event.replyToken, {
    type: 'text',
    text: reply,
  });
}

// ===== Start =====
app.listen(PORT, () => {
  console.log(`LINE bot webhook listening on port ${PORT}`);
});
