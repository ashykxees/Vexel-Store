# Vexel Store Discord Bot

Discord bot for Vexel Store. All slash commands are **Administrator-only** (hidden from and blocked for everyone else).

## Features

| Feature | How it works |
| --- | --- |
| `/vouch comment image rating` | Posts an embed titled `<username> Vouch` with the comment, image and a 1-5 star rating to the vouch channel (`1550871579087609886`). |
| Auto-react | Every message in channel `1550871609588457544` gets a ✅ reaction. |
| `/payment` | Posts an embed with **Stripe**, **Cashapp** and **Giftcard** buttons. Stripe/Giftcard post a second embed with a **Respond** button and ping `@1550868852911644794`. Staff click **Respond**, fill in the link/giftcard in a popup, and the bot posts it with a green **I've Paid** button. Clicking **I've Paid** pings the role again. Cashapp shows `CASHAPP_TAG` (if set) with an **I've Paid** button. |
| Protected role pings | Any non-admin who pings `@1550868852911644794` or `@1550868762176004099` is kicked and the message is deleted. |
| Verification | New members are greeted in `VERIFY_CHANNEL_ID` (or DM) with a **Verify** button that grants `VERIFIED_ROLE_ID` (and removes `UNVERIFIED_ROLE_ID` if set). `/verifypanel` posts a permanent Verify panel in the current channel. |
| `/transfer invite [message]` | DMs every human member an invite to the new server and reports how many were delivered. |

> Discord does not allow a bot to move users into another server without each user granting OAuth2 `guilds.join` access, so `/transfer` works by DMing an invite link.

## Setup

1. Create an application at <https://discord.com/developers/applications>, add a bot, and enable the **Server Members Intent** and **Message Content Intent**.
2. Invite the bot with the `bot` + `applications.commands` scopes and these permissions: Kick Members, Manage Roles, Send Messages, Embed Links, Attach Files, Add Reactions, Manage Messages, Read Message History.
3. Make sure the bot's role is **above** the verified/unverified roles and above members it should be able to kick.
4. Copy `.env.example` to `.env` and fill in the values.
5. Run:

```bash
npm install
npm start
```

Setting `GUILD_ID` registers commands instantly to that server; without it, global commands can take up to an hour to appear.

## Deploy

`render.yaml` is included for a Render background worker. Any Node host (Railway, VPS, etc.) works with `npm start`. The bot exposes an HTTP health endpoint on `PORT` (default 3000).
