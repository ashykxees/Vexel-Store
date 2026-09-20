# Vexel Store Discord Bot

Discord bot for Vexel Store. All slash commands are **Administrator-only** (hidden from and blocked for everyone else).

## Features

| Feature | How it works |
| --- | --- |
| `/vouch comment image rating` | Posts an embed titled `<username> Vouch` with the comment, image and a 1-5 star rating to the vouch channel (`1550871579087609886`). |
| Auto-react | Every message in channel `1550871609588457544` gets a ✅ reaction. |
| `/payment` | Posts an embed with **Stripe**, **Cashapp** and **Giftcard** buttons. Stripe/Giftcard post a second embed with a **Respond** button and ping `@1550868852911644794`. Staff click **Respond**, fill in the link/giftcard in a popup, and the bot posts it with a green **I've Paid** button. Clicking **I've Paid** pings the role again. Cashapp shows `CASHAPP_TAG` (if set) with an **I've Paid** button. |
| Protected role pings | Any non-admin who pings `@1550868852911644794` or `@1550868762176004099` is kicked and the message is deleted. |
| Verification | New members are greeted in `VERIFY_CHANNEL_ID` (or DM) with a **Verify** button. It opens a Discord OAuth2 page asking for **identify** + **Join servers for you**. On completion the user gets `VERIFIED_ROLE_ID` (and loses `UNVERIFIED_ROLE_ID` if set) and their token is stored. `/verifypanel` posts a permanent Verify panel in the current channel. |
| `/transfer invite` | Adds every verified member of the current server directly into the server behind the invite link (via `guilds.join`). The bot must be in the destination server with **Create Invite** permission. Members who never verified cannot be moved and are reported in the summary. |
| `/dmall message` | DMs every human member the given message and reports delivered/failed counts. |

## Setup

1. Create an application at <https://discord.com/developers/applications>, add a bot, and enable the **Server Members Intent** and **Message Content Intent**.
2. Invite the bot with the `bot` + `applications.commands` scopes and these permissions: Kick Members, Manage Roles, Send Messages, Embed Links, Attach Files, Add Reactions, Manage Messages, Read Message History.
3. Make sure the bot's role is **above** the verified/unverified roles and above members it should be able to kick.
4. **OAuth2 → General**: copy the **Client Secret** into `CLIENT_SECRET`, and add `https://<your-public-url>/callback` under **Redirects**. Set `PUBLIC_URL` to the same public URL (Railway/Render give you one under the service's networking/domain settings).
5. Copy `.env.example` to `.env` and fill in the values. Set `DATABASE_URL` (Postgres) if you want verified users to survive redeploys; otherwise they are kept in `data.json`.
6. Run:

```bash
npm install
npm start
```

Setting `GUILD_ID` registers commands instantly to that server; without it, global commands can take up to an hour to appear.

## Deploy

`render.yaml` is included for Render. Any Node host (Railway, VPS, etc.) works with `npm start`. The bot serves HTTP on `PORT` (default 3000) for the OAuth callback (`/callback`) and health checks, so the service must be publicly reachable at `PUBLIC_URL`.

## Ticket bot (Botivo)

A second, separate Discord bot lives in [`ticket-bot/`](ticket-bot/README.md). Deploy it as its own service on this repo with `BOT_MODE=ticket` set.
