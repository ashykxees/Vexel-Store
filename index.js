require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL, URLSearchParams } = require('url');

const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
  AttachmentBuilder,
  MessageFlags,
} = require('discord.js');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID || '';

const VOUCH_CHANNEL_ID = process.env.VOUCH_CHANNEL_ID || '1550871579087609886';
const AUTO_REACT_CHANNEL_ID = process.env.AUTO_REACT_CHANNEL_ID || '1550871609588457544';
const AUTO_REACT_EMOJI = process.env.AUTO_REACT_EMOJI || '✅';

const PAYMENT_PING_ROLE_ID = process.env.PAYMENT_PING_ROLE_ID || '1550868852911644794';
const PROTECTED_ROLE_IDS = (process.env.PROTECTED_ROLE_IDS || '1550868852911644794,1550868762176004099')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const CASHAPP_TAG = process.env.CASHAPP_TAG || '';

const VERIFY_CHANNEL_ID = process.env.VERIFY_CHANNEL_ID || '';
const VERIFIED_ROLE_ID = process.env.VERIFIED_ROLE_ID || '';
const UNVERIFIED_ROLE_ID = process.env.UNVERIFIED_ROLE_ID || '';

const CLIENT_SECRET = process.env.CLIENT_SECRET || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const DATABASE_URL = process.env.DATABASE_URL || '';

const EMBED_COLOR = parseInt((process.env.EMBED_COLOR || '2b2d31').replace('#', ''), 16);
const PORT = process.env.PORT || 3000;

if (!DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN is required.');
  process.exit(1);
}
if (!CLIENT_SECRET || !PUBLIC_URL) {
  console.warn('CLIENT_SECRET and PUBLIC_URL are required for OAuth verification and /transfer.');
}

// ---------------------------------------------------------------------------
// Persistence: OAuth tokens (Postgres if DATABASE_URL, else data.json)
// ---------------------------------------------------------------------------
const DATA_FILE = path.join(__dirname, 'data.json');
let pgPool = null;
if (DATABASE_URL) {
  try {
    const { Pool } = require('pg');
    pgPool = new Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_URL.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined,
    });
  } catch (err) {
    console.warn('Failed to initialize PostgreSQL:', err.message);
  }
}

// userId -> { accessToken, refreshToken, expiresAt, guildId }
let tokens = {};

async function loadData() {
  try {
    if (pgPool) {
      await pgPool.query('CREATE TABLE IF NOT EXISTS bot_state (key TEXT PRIMARY KEY, value JSONB NOT NULL)');
      const res = await pgPool.query('SELECT value FROM bot_state WHERE key = $1', ['tokens']);
      tokens = res.rows[0]?.value || {};
    } else if (fs.existsSync(DATA_FILE)) {
      tokens = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')).tokens || {};
    }
  } catch (err) {
    console.warn('Failed to load data:', err.message);
  }
  console.log(`Loaded ${Object.keys(tokens).length} verified user tokens`);
}

async function saveData() {
  try {
    if (pgPool) {
      await pgPool.query(
        'INSERT INTO bot_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
        ['tokens', JSON.stringify(tokens)]
      );
    } else {
      fs.writeFileSync(DATA_FILE, JSON.stringify({ tokens }, null, 2));
    }
  } catch (err) {
    console.warn('Failed to save data:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// ---------------------------------------------------------------------------
// Slash commands (all admin-only)
// ---------------------------------------------------------------------------
const commands = [
  new SlashCommandBuilder()
    .setName('vouch')
    .setDescription('Post a vouch to the vouch channel')
    .addStringOption((o) => o.setName('comment').setDescription('Your comment').setRequired(true).setMaxLength(1024))
    .addAttachmentOption((o) => o.setName('image').setDescription('Proof image').setRequired(true))
    .addIntegerOption((o) =>
      o.setName('rating').setDescription('Star rating (1-5)').setRequired(true).setMinValue(1).setMaxValue(5)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName('payment')
    .setDescription('Post the payment method picker')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName('verifypanel')
    .setDescription('Post the verification panel in this channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName('transfer')
    .setDescription('Add every verified member to another server')
    .addStringOption((o) =>
      o.setName('invite').setDescription('Invite link to the destination server').setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName('dmall')
    .setDescription('DM every member of this server a message')
    .addStringOption((o) => o.setName('message').setDescription('Message to send').setRequired(true).setMaxLength(2000))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
    console.log(`Registered ${commands.length} guild commands in ${GUILD_ID}`);
  } else {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log(`Registered ${commands.length} global commands`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function isAdmin(interaction) {
  return interaction.inGuild() && interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
}

function stars(n) {
  return '⭐'.repeat(n) + '☆'.repeat(5 - n);
}

function baseEmbed() {
  return new EmbedBuilder().setColor(EMBED_COLOR);
}

async function rejectNonAdmin(interaction) {
  await interaction.reply({ content: 'Only administrators can use this command.', flags: MessageFlags.Ephemeral });
}

// ---------------------------------------------------------------------------
// /vouch
// ---------------------------------------------------------------------------
async function handleVouch(interaction) {
  const comment = interaction.options.getString('comment', true);
  const image = interaction.options.getAttachment('image', true);
  const rating = interaction.options.getInteger('rating', true);

  if (!image.contentType?.startsWith('image/')) {
    return interaction.reply({ content: 'The image must be an image file.', flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const channel = await client.channels.fetch(VOUCH_CHANNEL_ID).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    return interaction.editReply('Vouch channel not found. Check VOUCH_CHANNEL_ID.');
  }

  const ext = (image.name && image.name.split('.').pop()) || 'png';
  const fileName = `vouch.${ext}`;
  const file = new AttachmentBuilder(image.url, { name: fileName });

  const embed = baseEmbed()
    .setTitle(`${interaction.user.username} Vouch`)
    .setDescription(`${comment}\n\n${stars(rating)}`)
    .setImage(`attachment://${fileName}`)
    .setFooter({ text: `${rating}/5 stars` })
    .setTimestamp();

  await channel.send({ embeds: [embed], files: [file] });
  await interaction.editReply(`Vouch posted in <#${VOUCH_CHANNEL_ID}>.`);
}

// ---------------------------------------------------------------------------
// /payment flow
// ---------------------------------------------------------------------------
async function handlePayment(interaction) {
  const embed = baseEmbed()
    .setTitle('Payment')
    .setDescription('Choose a payment method below.');

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('pay_stripe').setLabel('Stripe').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('pay_cashapp').setLabel('Cashapp').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('pay_giftcard').setLabel('Giftcard').setStyle(ButtonStyle.Secondary)
  );

  await interaction.reply({ embeds: [embed], components: [row] });
}

const METHOD_LABELS = { stripe: 'Stripe', giftcard: 'Giftcard', cashapp: 'Cashapp' };

async function handlePaymentMethod(interaction, method) {
  const label = METHOD_LABELS[method];

  if (method === 'cashapp') {
    const embed = baseEmbed()
      .setTitle('Cashapp Payment')
      .setDescription(
        CASHAPP_TAG
          ? `Send your payment to **${CASHAPP_TAG}**, then press **I've Paid** below.`
          : 'A staff member will send you the Cashapp details shortly. Press **I\'ve Paid** once you have sent the payment.'
      );
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('pay_paid').setLabel("I've Paid").setStyle(ButtonStyle.Success)
    );
    return interaction.reply({
      content: `<@&${PAYMENT_PING_ROLE_ID}> ${interaction.user} selected **Cashapp**.`,
      embeds: [embed],
      components: [row],
    });
  }

  const embed = baseEmbed()
    .setTitle(`${label} Payment`)
    .setDescription(
      `${interaction.user} selected **${label}**.\nA staff member will respond with your ${
        method === 'stripe' ? 'payment link' : 'giftcard instructions'
      } shortly.`
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`pay_respond_${method}`).setLabel('Respond').setStyle(ButtonStyle.Primary)
  );

  await interaction.reply({
    content: `<@&${PAYMENT_PING_ROLE_ID}>`,
    embeds: [embed],
    components: [row],
  });
}

async function handleRespond(interaction, method) {
  if (!isAdmin(interaction) && !interaction.member?.roles?.cache?.has(PAYMENT_PING_ROLE_ID)) {
    return interaction.reply({ content: 'Only staff can respond to payment requests.', flags: MessageFlags.Ephemeral });
  }

  const modal = new ModalBuilder()
    .setCustomId(`pay_modal_${method}`)
    .setTitle(`${METHOD_LABELS[method]} Response`);

  const input = new TextInputBuilder()
    .setCustomId('pay_value')
    .setLabel(method === 'stripe' ? 'Payment link' : 'Giftcard details')
    .setStyle(method === 'stripe' ? TextInputStyle.Short : TextInputStyle.Paragraph)
    .setPlaceholder(method === 'stripe' ? 'https://buy.stripe.com/...' : 'Which giftcard / amount / instructions')
    .setRequired(true)
    .setMaxLength(1000);

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  await interaction.showModal(modal);
}

async function handlePaymentModal(interaction, method) {
  const value = interaction.fields.getTextInputValue('pay_value').trim();
  const label = METHOD_LABELS[method];

  const embed = baseEmbed()
    .setTitle(`${label} Payment Details`)
    .setDescription(method === 'stripe' ? `**Payment link:**\n${value}` : `**Giftcard:**\n${value}`)
    .setFooter({ text: `Sent by ${interaction.user.tag}` })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('pay_paid').setLabel("I've Paid").setStyle(ButtonStyle.Success)
  );

  await interaction.reply({ embeds: [embed], components: [row] });
}

async function handlePaid(interaction) {
  const embed = baseEmbed()
    .setTitle('Payment Sent')
    .setDescription(`${interaction.user} has marked their payment as sent. Please verify.`)
    .setTimestamp();

  await interaction.reply({ content: `<@&${PAYMENT_PING_ROLE_ID}>`, embeds: [embed] });
}

// ---------------------------------------------------------------------------
// Verification (OAuth2 with identify + guilds.join)
// ---------------------------------------------------------------------------
const OAUTH_SCOPES = 'identify guilds.join';
const REDIRECT_URI = `${PUBLIC_URL}/callback`;
const pendingStates = new Map(); // state -> { guildId, createdAt }

function verifyUrl(guildId) {
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, { guildId, createdAt: Date.now() });
  const params = new URLSearchParams({
    client_id: client.user.id,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: OAUTH_SCOPES,
    state,
    prompt: 'consent',
  });
  return `https://discord.com/oauth2/authorize?${params}`;
}

setInterval(() => {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [state, info] of pendingStates) if (info.createdAt < cutoff) pendingStates.delete(state);
}, 60 * 1000).unref();

function verifyRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('verify_me').setLabel('Verify').setStyle(ButtonStyle.Success).setEmoji('✅')
  );
}

function verifyEmbed(guildName) {
  return baseEmbed()
    .setTitle(`Welcome to ${guildName}`)
    .setDescription('You must verify before you can access the server. Click **Verify** below.');
}

async function handleVerifyPanel(interaction) {
  if (!VERIFIED_ROLE_ID) {
    return interaction.reply({ content: 'VERIFIED_ROLE_ID is not configured.', flags: MessageFlags.Ephemeral });
  }
  const embed = baseEmbed()
    .setTitle('Verification')
    .setDescription('Click the button below to verify and unlock the server.');
  await interaction.channel.send({ embeds: [embed], components: [verifyRow()] });
  await interaction.reply({ content: 'Verification panel posted.', flags: MessageFlags.Ephemeral });
}

async function handleVerifyButton(interaction) {
  if (!VERIFIED_ROLE_ID || !CLIENT_SECRET || !PUBLIC_URL) {
    return interaction.reply({ content: 'Verification is not configured.', flags: MessageFlags.Ephemeral });
  }
  const url = verifyUrl(interaction.guildId);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel('Open Verification').setStyle(ButtonStyle.Link).setURL(url)
  );
  await interaction.reply({
    content: 'Click below to complete verification. You will be asked to authorize the bot.',
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
}

async function discordApi(endpoint, options = {}) {
  const res = await fetch(`https://discord.com/api/v10${endpoint}`, options);
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { ok: res.ok, status: res.status, body };
}

async function exchangeCode(code) {
  return discordApi('/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: client.user.id,
      client_secret: CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
    }),
  });
}

async function refreshToken(userId) {
  const entry = tokens[userId];
  if (!entry?.refreshToken) return null;
  const res = await discordApi('/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: client.user.id,
      client_secret: CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: entry.refreshToken,
    }),
  });
  if (!res.ok) {
    console.warn(`Refresh failed for ${userId}:`, res.status);
    return null;
  }
  tokens[userId] = {
    ...entry,
    accessToken: res.body.access_token,
    refreshToken: res.body.refresh_token,
    expiresAt: Date.now() + res.body.expires_in * 1000,
  };
  await saveData();
  return tokens[userId].accessToken;
}

async function getAccessToken(userId) {
  const entry = tokens[userId];
  if (!entry) return null;
  if (entry.expiresAt - Date.now() > 60 * 1000) return entry.accessToken;
  return refreshToken(userId);
}

function htmlPage(title, message) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{background:#2b2d31;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{background:#313338;padding:32px 40px;border-radius:12px;text-align:center;max-width:420px}h1{margin:0 0 12px;font-size:22px}p{color:#b5bac1;margin:0}</style></head>
<body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`;
}

async function handleOAuthCallback(reqUrl, res) {
  const code = reqUrl.searchParams.get('code');
  const state = reqUrl.searchParams.get('state');
  const pending = state && pendingStates.get(state);

  const send = (status, title, message) => {
    res.writeHead(status, { 'Content-Type': 'text/html' });
    res.end(htmlPage(title, message));
  };

  if (!code || !pending) return send(400, 'Verification failed', 'Invalid or expired link. Click Verify again in Discord.');
  pendingStates.delete(state);

  const tokenRes = await exchangeCode(code);
  if (!tokenRes.ok) {
    console.warn('Token exchange failed:', tokenRes.status, tokenRes.body);
    return send(400, 'Verification failed', 'Could not authorize with Discord. Please try again.');
  }

  const userRes = await discordApi('/users/@me', {
    headers: { Authorization: `Bearer ${tokenRes.body.access_token}` },
  });
  if (!userRes.ok) return send(400, 'Verification failed', 'Could not fetch your Discord account.');

  const userId = userRes.body.id;
  tokens[userId] = {
    accessToken: tokenRes.body.access_token,
    refreshToken: tokenRes.body.refresh_token,
    expiresAt: Date.now() + tokenRes.body.expires_in * 1000,
    guildId: pending.guildId,
  };
  await saveData();

  const guild = await client.guilds.fetch(pending.guildId).catch(() => null);
  const member = guild && (await guild.members.fetch(userId).catch(() => null));
  if (member) {
    try {
      await member.roles.add(VERIFIED_ROLE_ID, 'Verified via OAuth');
      if (UNVERIFIED_ROLE_ID && member.roles.cache.has(UNVERIFIED_ROLE_ID)) {
        await member.roles.remove(UNVERIFIED_ROLE_ID, 'Verified via OAuth');
      }
    } catch (err) {
      console.error('Role assign failed:', err.message);
      return send(500, 'Almost there', 'You authorized, but the verified role could not be assigned. Contact staff.');
    }
  }

  send(200, 'You are verified!', 'You can close this tab and return to Discord.');
}

client.on('guildMemberAdd', async (member) => {
  if (member.user.bot) return;
  if (UNVERIFIED_ROLE_ID) {
    await member.roles.add(UNVERIFIED_ROLE_ID, 'New member').catch((e) => console.warn('Unverified role:', e.message));
  }

  const embed = verifyEmbed(member.guild.name);
  let notified = false;
  if (VERIFY_CHANNEL_ID) {
    const channel = await member.guild.channels.fetch(VERIFY_CHANNEL_ID).catch(() => null);
    if (channel && channel.isTextBased()) {
      await channel
        .send({ content: `${member}`, embeds: [embed], components: [verifyRow()] })
        .then(() => (notified = true))
        .catch((e) => console.warn('Verify channel send failed:', e.message));
    }
  }
  if (!notified) {
    await member.send({ embeds: [embed], components: [verifyRow()] }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// /transfer — add every verified member to the invite's server via guilds.join
// ---------------------------------------------------------------------------
async function handleTransfer(interaction) {
  const inviteInput = interaction.options.getString('invite', true).trim();
  const match = inviteInput.match(/(?:discord\.gg|discord(?:app)?\.com\/invite)\/([\w-]+)/i) || [null, inviteInput];
  const inviteCode = match[1];

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const invite = await client.fetchInvite(inviteCode).catch(() => null);
  if (!invite?.guild) return interaction.editReply('Invalid invite link.');

  const target = await client.guilds.fetch(invite.guild.id).catch(() => null);
  if (!target) {
    return interaction.editReply(`The bot is not in **${invite.guild.name}**. Invite the bot there first (with Create Invite permission).`);
  }
  if (!target.members.me?.permissions.has(PermissionFlagsBits.CreateInstantInvite)) {
    return interaction.editReply(`The bot needs **Create Invite** permission in **${target.name}**.`);
  }

  const members = await interaction.guild.members.fetch();
  const humans = members.filter((m) => !m.user.bot);

  let added = 0;
  let already = 0;
  let noToken = 0;
  let failed = 0;

  for (const member of humans.values()) {
    const accessToken = await getAccessToken(member.id);
    if (!accessToken) {
      noToken++;
      continue;
    }
    const res = await discordApi(`/guilds/${target.id}/members/${member.id}`, {
      method: 'PUT',
      headers: { Authorization: `Bot ${DISCORD_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token: accessToken }),
    });
    if (res.status === 201) added++;
    else if (res.status === 204) already++;
    else {
      failed++;
      console.warn(`Join failed for ${member.user.tag}:`, res.status, res.body);
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  await interaction.editReply(
    `Transfer to **${target.name}** complete.\n` +
      `Added: **${added}** · Already there: **${already}** · Not verified (no permission): **${noToken}** · Failed: **${failed}**`
  );
}

// ---------------------------------------------------------------------------
// /dmall
// ---------------------------------------------------------------------------
async function handleDmAll(interaction) {
  const text = interaction.options.getString('message', true);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const members = await interaction.guild.members.fetch();
  const humans = members.filter((m) => !m.user.bot);

  const embed = baseEmbed().setAuthor({ name: interaction.guild.name, iconURL: interaction.guild.iconURL() || undefined }).setDescription(text);

  let sent = 0;
  let failed = 0;
  for (const member of humans.values()) {
    try {
      await member.send({ embeds: [embed] });
      sent++;
    } catch {
      failed++;
    }
    await new Promise((r) => setTimeout(r, 1100));
  }
  await interaction.editReply(`DM sent to **${sent}** members, **${failed}** failed (DMs closed).`);
}

// ---------------------------------------------------------------------------
// Messages: auto-react + protected role pings
// ---------------------------------------------------------------------------
client.on('messageCreate', async (message) => {
  if (!message.guild || message.author.bot) return;

  if (message.channelId === AUTO_REACT_CHANNEL_ID) {
    await message.react(AUTO_REACT_EMOJI).catch((e) => console.warn('React failed:', e.message));
  }

  const pingedProtected = PROTECTED_ROLE_IDS.some((id) => message.mentions.roles.has(id));
  if (!pingedProtected) return;

  const member = message.member || (await message.guild.members.fetch(message.author.id).catch(() => null));
  if (!member) return;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return;
  if (!member.kickable) {
    console.warn(`Cannot kick ${member.user.tag} (role hierarchy).`);
    return;
  }

  await member.send(`You were kicked from **${message.guild.name}** for pinging a protected role.`).catch(() => {});
  await member.kick('Pinged a protected role').catch((e) => console.warn('Kick failed:', e.message));
  await message.delete().catch(() => {});
});

// ---------------------------------------------------------------------------
// Interactions
// ---------------------------------------------------------------------------
client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (!isAdmin(interaction)) return rejectNonAdmin(interaction);
      switch (interaction.commandName) {
        case 'vouch':
          return handleVouch(interaction);
        case 'payment':
          return handlePayment(interaction);
        case 'verifypanel':
          return handleVerifyPanel(interaction);
        case 'transfer':
          return handleTransfer(interaction);
        case 'dmall':
          return handleDmAll(interaction);
      }
      return;
    }

    if (interaction.isButton()) {
      const id = interaction.customId;
      if (id === 'pay_stripe') return handlePaymentMethod(interaction, 'stripe');
      if (id === 'pay_cashapp') return handlePaymentMethod(interaction, 'cashapp');
      if (id === 'pay_giftcard') return handlePaymentMethod(interaction, 'giftcard');
      if (id.startsWith('pay_respond_')) return handleRespond(interaction, id.replace('pay_respond_', ''));
      if (id === 'pay_paid') return handlePaid(interaction);
      if (id === 'verify_me') return handleVerifyButton(interaction);
      return;
    }

    if (interaction.isModalSubmit()) {
      const id = interaction.customId;
      if (id.startsWith('pay_modal_')) return handlePaymentModal(interaction, id.replace('pay_modal_', ''));
    }
  } catch (err) {
    console.error('Interaction error:', err);
    const payload = { content: 'Something went wrong.', flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(payload).catch(() => {});
    } else {
      await interaction.reply(payload).catch(() => {});
    }
  }
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await loadData();
  try {
    await registerCommands();
  } catch (err) {
    console.error('Command registration failed:', err);
  }
});

http
  .createServer(async (req, res) => {
    const reqUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (reqUrl.pathname === '/callback') {
      if (!client.isReady()) {
        res.writeHead(503, { 'Content-Type': 'text/html' });
        return res.end(htmlPage('Please wait', 'The bot is starting up. Try again in a moment.'));
      }
      try {
        await handleOAuthCallback(reqUrl, res);
      } catch (err) {
        console.error('OAuth callback error:', err);
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(htmlPage('Error', 'Something went wrong. Please try again.'));
      }
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
  })
  .listen(PORT, () => console.log(`HTTP server on :${PORT}`));

client.login(DISCORD_TOKEN);
