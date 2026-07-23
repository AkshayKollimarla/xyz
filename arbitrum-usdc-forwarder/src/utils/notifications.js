'use strict';

const fetch = require('node-fetch');
const config = require('../config');
const logger = require('../logger');

/** Sends a Telegram message if TELEGRAM_BOT_TOKEN/CHAT_ID are configured. */
async function sendTelegram(message) {
  const { botToken, chatId } = config.notifications.telegram;
  if (!botToken || !chatId) return;
  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' }),
    });
    if (!res.ok) {
      logger.warn(`Telegram notification failed with status ${res.status}`);
    }
  } catch (err) {
    logger.warn(`Telegram notification error: ${err.message}`);
  }
}

/** Sends a Discord webhook message if DISCORD_WEBHOOK_URL is configured. */
async function sendDiscord(message) {
  const { discordWebhookUrl } = config.notifications;
  if (!discordWebhookUrl) return;
  try {
    const res = await fetch(discordWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message }),
    });
    if (!res.ok) {
      logger.warn(`Discord notification failed with status ${res.status}`);
    }
  } catch (err) {
    logger.warn(`Discord notification error: ${err.message}`);
  }
}

/** Sends a Slack webhook message if SLACK_WEBHOOK_URL is configured. */
async function sendSlack(message) {
  const { slackWebhookUrl } = config.notifications;
  if (!slackWebhookUrl) return;
  try {
    const res = await fetch(slackWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: message }),
    });
    if (!res.ok) {
      logger.warn(`Slack notification failed with status ${res.status}`);
    }
  } catch (err) {
    logger.warn(`Slack notification error: ${err.message}`);
  }
}

/** Fans a message out to every configured notification channel. */
async function notifyAll(message) {
  await Promise.allSettled([
    sendTelegram(message),
    sendDiscord(message),
    sendSlack(message),
  ]);
}

module.exports = { sendTelegram, sendDiscord, sendSlack, notifyAll };
