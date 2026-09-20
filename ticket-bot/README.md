# Botivo Ticket Bot

A separate Discord bot (own application + token) living in the same repo as the Vexel Store bot.

## Features

- `/ticketpanel` (admin) posts the 🎫 Ticket Panel embed with a dropdown: 💰 Order, ❓ General Support, 📦 Claim Order.
- Each option opens a modal form; on submit a private ticket channel is created (opener + support role only) with a **Close** button.
- `/close` or the Close button closes the ticket: an HTML transcript is sent to the log channel and DM'd to the ticket opener, then the channel is deleted.
- If `PANEL_CHANNEL_ID` is set, the panel is auto-posted on startup when missing.

## Setup

1. Developer Portal → **New Application** (e.g. "Botivo Tickets") → Bot → Reset Token → `DISCORD_TOKEN`.
   No privileged intents are required for this bot.
2. OAuth2 → URL Generator: scopes `bot` + `applications.commands`; permissions Manage Channels, Send Messages, Embed Links, Attach Files, Read Message History (or Administrator). Invite it to your server.
3. Copy `.env.example` → `.env` and fill `SUPPORT_ROLE_ID`, `TICKET_LOG_CHANNEL_ID`, and optionally `TICKET_CATEGORY_ID`, `PANEL_CHANNEL_ID`, `WEBSITE_URL`.
4. `npm install && npm start` (from this `ticket-bot/` folder).

## Railway

Add a **second service** in the same Railway project pointing at this repo (no root-directory change needed) and set the variable `BOT_MODE=ticket` — the root `npm start` will then launch this bot. Give it its own variables (the ticket bot's token, not the Vexel Store one).
