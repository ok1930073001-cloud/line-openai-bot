"use strict";

require("dotenv").config();

const express = require("express");
const line = require("@line/bot-sdk");
const axios = require("axios");

const app = express();

const config = {
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.Client(config);

app.get("/", (req, res) => res.send("OK"));

app.post("/webhook", line.middleware(config), async (req, res) => {
  const events = req.body.events;

  for (const event of events) {
    if (event.type === "message" && event.message.type === "text") {
      const userId = event.source.userId;
      const text = event.message.text;

      try {
        await client.pushMessage(userId, {
          type: "text",
          text: "你剛剛說的是：" + text,
        });
      } catch (err) {
        console.error(err);
      }
    }
  }

  res.status(200).end();
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
