require('dotenv').config();
const http = require('http');
const path = require('path');

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
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
  ChannelType,
  AttachmentBuilder,
  MessageFlags,
} = require('discord.js');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID || '';
const BRAND_NAME = process.env.BRAND_NAME || 'Botivo';
const SUPPORT_ROLE_ID = process.env.SUPPORT_ROLE_ID || '';
const TICKET_CATEGORY_ID = process.env.TICKET_CATEGORY_ID || '';
const TICKET_LOG_CHANNEL_ID = process.env.TICKET_LOG_CHANNEL_ID || '';
const PANEL_CHANNEL_ID = process.env.PANEL_CHANNEL_ID || '';
const WEBSITE_URL = process.env.WEBSITE_URL || '';
const EMBED_COLOR = parseInt((process.env.EMBED_COLOR || '1e90ff').replace('#', ''), 16);
const PORT = process.env.PORT || 3000;

if (!DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN is required.');
  process.exit(1);
}

const ASSETS = path.join(__dirname, 'assets');
const LOGO_FILE = 'logo.png';
const BANNER_FILE = 'banner.png';
const TOPIC_PREFIX = 'ticket:'; // channel topic stores "ticket:<type>:<openerId>"

const TICKET_TYPES = {
  order: {
    label: 'Order',
    emoji: '💰',
    description: 'Click here to purchase something that is not available on our website.',
    title: 'Order Ticket',
    fields: [
      { id: 'item', label: 'What would you like to purchase?', placeholder: 'Product or service name', required: true, style: TextInputStyle.Short },
      { id: 'details', label: 'Additional details', required: false, style: TextInputStyle.Paragraph },
    ],
  },
  support: {
    label: 'General Support',
    emoji: '❓',
    description: 'Click here for any general question or receive support on a product.',
    title: 'General Support Ticket',
    fields: [
      { id: 'problem', label: 'Problem', placeholder: 'Briefly describe your issue', required: true, style: TextInputStyle.Short },
      { id: 'order_id', label: 'Order ID', placeholder: 'Leave blank if not applicable', required: false, style: TextInputStyle.Short },
      { id: 'details', label: 'Additional details', required: false, style: TextInputStyle.Paragraph },
    ],
  },
  claim: {
    label: 'Claim Order',
    emoji: '📦',
    description: 'Click here to claim an order that was purchased on our website.',
    title: 'Claim Order Ticket',
    fields: [
      { id: 'order_id', label: 'Order ID', placeholder: 'The order ID from your purchase', required: true, style: TextInputStyle.Short },
      { id: 'email', label: 'Email used at checkout', placeholder: 'Leave blank if not applicable', required: false, style: TextInputStyle.Short },
      { id: 'details', label: 'Additional details', required: false, style: TextInputStyle.Paragraph },
    ],
  },
};

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel, Partials.Message],
});

const commands = [
  new SlashCommandBuilder()
    .setName('ticketpanel')
    .setDescription('Post the ticket panel in this channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName('close')
    .setDescription('Close this ticket')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
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
function brandFiles() {
  return [
    new AttachmentBuilder(path.join(ASSETS, LOGO_FILE), { name: LOGO_FILE }),
    new AttachmentBuilder(path.join(ASSETS, BANNER_FILE), { name: BANNER_FILE }),
  ];
}

function brandEmbed() {
  return new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setAuthor({ name: BRAND_NAME, iconURL: `attachment://${LOGO_FILE}` })
    .setThumbnail(`attachment://${LOGO_FILE}`)
    .setImage(`attachment://${BANNER_FILE}`)
    .setFooter({ text: `© ${BRAND_NAME} | All Rights Reserved.`, iconURL: `attachment://${LOGO_FILE}` });
}

function isAdmin(interaction) {
  return interaction.inGuild() && interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
}

function isStaff(member) {
  return (
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    member.permissions.has(PermissionFlagsBits.ManageChannels) ||
    (SUPPORT_ROLE_ID && member.roles.cache.has(SUPPORT_ROLE_ID))
  );
}

function parseTicketTopic(channel) {
  const topic = channel?.topic || '';
  if (!topic.startsWith(TOPIC_PREFIX)) return null;
  const [, type, openerId] = topic.split(':');
  return { type, openerId };
}

function sanitizeName(s) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) || 'user';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------
function panelPayload() {
  const embed = brandEmbed()
    .setTitle('🎫 Ticket Panel')
    .setDescription(
      `> Experience the best Ticketing Service at ${BRAND_NAME}! Choose the ticket type from the dropdown below, and our team will promptly assist you.\n\n` +
        '**If you are claiming an order, please select 📦 CLAIM ORDER.**' +
        (WEBSITE_URL ? `\n\nFor automated delivery use our website below\n↪ [Automated Purchasing](${WEBSITE_URL})` : '')
    );

  const menu = new StringSelectMenuBuilder()
    .setCustomId('ticket_select')
    .setPlaceholder('Choose the appropriate category')
    .addOptions(
      Object.entries(TICKET_TYPES).map(([key, t]) =>
        new StringSelectMenuOptionBuilder().setValue(key).setLabel(t.label).setEmoji(t.emoji).setDescription(t.description)
      )
    );

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)], files: brandFiles() };
}

async function handleTicketPanel(interaction) {
  await interaction.channel.send(panelPayload());
  await interaction.reply({ content: 'Ticket panel posted.', flags: MessageFlags.Ephemeral });
}

// ---------------------------------------------------------------------------
// Select -> modal
// ---------------------------------------------------------------------------
async function handleSelect(interaction) {
  const type = interaction.values[0];
  const cfg = TICKET_TYPES[type];
  if (!cfg) return;

  const modal = new ModalBuilder().setCustomId(`ticket_modal_${type}`).setTitle(cfg.title);
  for (const f of cfg.fields) {
    const input = new TextInputBuilder()
      .setCustomId(f.id)
      .setLabel(f.label)
      .setStyle(f.style)
      .setRequired(f.required)
      .setMaxLength(f.style === TextInputStyle.Paragraph ? 1000 : 200);
    if (f.placeholder) input.setPlaceholder(f.placeholder);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
  }
  await interaction.showModal(modal);
}

// ---------------------------------------------------------------------------
// Modal -> create ticket channel
// ---------------------------------------------------------------------------
async function findExistingTicket(guild, userId) {
  const channels = await guild.channels.fetch();
  return channels.find((c) => c && c.type === ChannelType.GuildText && parseTicketTopic(c)?.openerId === userId) || null;
}

async function handleModal(interaction, type) {
  const cfg = TICKET_TYPES[type];
  if (!cfg) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guild = interaction.guild;
  const existing = await findExistingTicket(guild, interaction.user.id);
  if (existing) {
    return interaction.editReply(`You already have an open ticket: ${existing}`);
  }

  const answers = cfg.fields
    .map((f) => ({ label: f.label, value: interaction.fields.getTextInputValue(f.id)?.trim() }))
    .filter((a) => a.value);

  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: interaction.user.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles],
    },
    {
      id: client.user.id,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory],
    },
  ];
  if (SUPPORT_ROLE_ID) {
    overwrites.push({
      id: SUPPORT_ROLE_ID,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles],
    });
  }

  const channel = await guild.channels.create({
    name: `${type}-${sanitizeName(interaction.user.username)}`,
    type: ChannelType.GuildText,
    parent: TICKET_CATEGORY_ID || undefined,
    topic: `${TOPIC_PREFIX}${type}:${interaction.user.id}`,
    permissionOverwrites: overwrites,
  });

  const embed = brandEmbed()
    .setTitle(`${cfg.emoji} ${cfg.title}`)
    .setDescription('> Thank you for opening a ticket, our staff will be with you shortly.');
  for (const a of answers) embed.addFields({ name: `↪ ${a.label}`, value: a.value.slice(0, 1024) });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket_close').setLabel('Close').setStyle(ButtonStyle.Danger)
  );

  await channel.send({
    content: `${SUPPORT_ROLE_ID ? `<@&${SUPPORT_ROLE_ID}> ` : ''}please assist ${interaction.user}`,
    embeds: [embed],
    components: [row],
    files: brandFiles(),
  });

  await interaction.editReply(`Your ticket has been created: ${channel}`);
}

// ---------------------------------------------------------------------------
// Close
// ---------------------------------------------------------------------------
async function fetchAllMessages(channel) {
  const all = [];
  let before;
  for (;;) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    if (batch.size === 0) break;
    all.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  return all.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

function buildTranscript(channel, messages, opener, closer) {
  const rows = messages
    .map((m) => {
      const time = new Date(m.createdTimestamp).toLocaleString('en-US', { timeZone: 'UTC' });
      const attachments = [...m.attachments.values()]
        .map((a) => `<div class="att"><a href="${a.url}">${escapeHtml(a.name)}</a></div>`)
        .join('');
      const embeds = m.embeds
        .map((e) => {
          const fields = e.fields.map((f) => `<div><b>${escapeHtml(f.name)}</b><br>${escapeHtml(f.value)}</div>`).join('');
          return `<div class="embed">${e.title ? `<b>${escapeHtml(e.title)}</b><br>` : ''}${e.description ? escapeHtml(e.description).replace(/\n/g, '<br>') : ''}${fields}</div>`;
        })
        .join('');
      return `<div class="msg"><img class="avatar" src="${m.author.displayAvatarURL({ size: 64 })}"><div class="body"><span class="name">${escapeHtml(m.author.tag)}</span> <span class="time">${time} UTC</span><div class="text">${escapeHtml(m.content).replace(/\n/g, '<br>')}</div>${embeds}${attachments}</div></div>`;
    })
    .join('\n');

  return `<!doctype html><html><head><meta charset="utf-8"><title>Transcript #${escapeHtml(channel.name)}</title>
<style>body{background:#313338;color:#dbdee1;font-family:sans-serif;margin:0;padding:24px}h1{color:#fff;font-size:20px}.meta{color:#949ba4;margin-bottom:24px}
.msg{display:flex;gap:12px;margin-bottom:16px}.avatar{width:40px;height:40px;border-radius:50%}.name{color:#fff;font-weight:600}.time{color:#949ba4;font-size:12px}
.text{margin-top:2px;white-space:pre-wrap}.embed{border-left:4px solid #1e90ff;background:#2b2d31;padding:8px 12px;margin-top:6px;border-radius:4px}.att a{color:#00a8fc}</style></head>
<body><h1>${escapeHtml(BRAND_NAME)} Ticket Transcript — #${escapeHtml(channel.name)}</h1>
<div class="meta">Opened by ${escapeHtml(opener?.tag || 'unknown')} · Closed by ${escapeHtml(closer.tag)} · ${messages.length} messages · ${new Date().toUTCString()}</div>
${rows}</body></html>`;
}

async function closeTicket(interaction) {
  const channel = interaction.channel;
  const info = parseTicketTopic(channel);
  if (!info) {
    return interaction.reply({ content: 'This is not a ticket channel.', flags: MessageFlags.Ephemeral });
  }
  if (!isStaff(interaction.member) && interaction.user.id !== info.openerId) {
    return interaction.reply({ content: 'Only staff or the ticket owner can close this ticket.', flags: MessageFlags.Ephemeral });
  }

  await interaction.reply({ content: 'Closing ticket and saving transcript...' });

  const opener = await client.users.fetch(info.openerId).catch(() => null);
  const messages = await fetchAllMessages(channel);
  const html = buildTranscript(channel, messages, opener, interaction.user);
  const transcriptName = `transcript-${channel.name}.html`;

  let transcriptUrl = null;
  if (TICKET_LOG_CHANNEL_ID) {
    const logChannel = await client.channels.fetch(TICKET_LOG_CHANNEL_ID).catch(() => null);
    if (logChannel?.isTextBased()) {
      const logEmbed = brandEmbed()
        .setTitle('Ticket Closed')
        .addFields(
          { name: '🎟️ Ticket', value: `\`${channel.name}\``, inline: true },
          { name: '👤 Opened By', value: opener ? `${opener}` : 'Unknown', inline: true },
          { name: '🔒 Closed By', value: `${interaction.user}`, inline: true },
          { name: '💬 Messages', value: `${messages.length}`, inline: true }
        )
        .setTimestamp();
      const logMsg = await logChannel
        .send({
          embeds: [logEmbed],
          files: [...brandFiles(), new AttachmentBuilder(Buffer.from(html, 'utf8'), { name: transcriptName })],
        })
        .catch((e) => console.warn('Log send failed:', e.message));
      transcriptUrl = logMsg?.attachments.find((a) => a.name === transcriptName)?.url || null;
    }
  }

  if (opener) {
    const dmEmbed = brandEmbed()
      .setTitle('Your Ticket Has Been Closed')
      .setDescription(
        `Hey **${opener.username}**, your support ticket with **${BRAND_NAME}** has been closed.\n\n` +
          'You can view the full conversation transcript using the link below.\nIf your issue wasn\'t resolved, feel free to open a new ticket.'
      )
      .addFields(
        { name: '🎟️ Ticket', value: `\`${channel.name}\``, inline: true },
        { name: '🔒 Closed By', value: `${interaction.user}`, inline: true },
        { name: '📋 Transcript', value: transcriptUrl ? `[Click to view](${transcriptUrl})` : 'Attached below' }
      )
      .setTimestamp();
    const files = brandFiles();
    if (!transcriptUrl) files.push(new AttachmentBuilder(Buffer.from(html, 'utf8'), { name: transcriptName }));
    await opener.send({ embeds: [dmEmbed], files }).catch(() => console.warn(`Could not DM ${opener.tag}`));
  }

  setTimeout(() => channel.delete('Ticket closed').catch((e) => console.warn('Delete failed:', e.message)), 3000);
}

// ---------------------------------------------------------------------------
// Interactions
// ---------------------------------------------------------------------------
client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'ticketpanel') {
        if (!isAdmin(interaction)) {
          return interaction.reply({ content: 'Only administrators can use this command.', flags: MessageFlags.Ephemeral });
        }
        return handleTicketPanel(interaction);
      }
      if (interaction.commandName === 'close') return closeTicket(interaction);
      return;
    }
    if (interaction.isStringSelectMenu() && interaction.customId === 'ticket_select') return handleSelect(interaction);
    if (interaction.isModalSubmit() && interaction.customId.startsWith('ticket_modal_')) {
      return handleModal(interaction, interaction.customId.replace('ticket_modal_', ''));
    }
    if (interaction.isButton() && interaction.customId === 'ticket_close') return closeTicket(interaction);
  } catch (err) {
    console.error('Interaction error:', err);
    const payload = { content: 'Something went wrong.', flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload).catch(() => {});
    else await interaction.reply(payload).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    await registerCommands();
  } catch (err) {
    console.error('Command registration failed:', err);
  }
  if (PANEL_CHANNEL_ID) {
    const channel = await client.channels.fetch(PANEL_CHANNEL_ID).catch(() => null);
    if (channel?.isTextBased()) {
      const recent = await channel.messages.fetch({ limit: 20 }).catch(() => null);
      const hasPanel = recent?.some((m) => m.author.id === client.user.id && m.components.length > 0);
      if (!hasPanel) await channel.send(panelPayload()).catch((e) => console.warn('Panel post failed:', e.message));
    }
  }
});

http
  .createServer((_, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
  })
  .listen(PORT, () => console.log(`Health server on :${PORT}`));

client.login(DISCORD_TOKEN);
