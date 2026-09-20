require('dotenv').config();
const http = require('http');

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

const EMBED_COLOR = parseInt((process.env.EMBED_COLOR || '2b2d31').replace('#', ''), 16);
const PORT = process.env.PORT || 3000;

if (!DISCORD_TOKEN) {
  console.error('DISCORD_TOKEN is required.');
  process.exit(1);
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
    .setDescription('DM every member an invite to another server')
    .addStringOption((o) =>
      o.setName('invite').setDescription('Invite link to the destination server').setRequired(true)
    )
    .addStringOption((o) => o.setName('message').setDescription('Optional message to include').setMaxLength(1000))
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
// Verification
// ---------------------------------------------------------------------------
function verifyRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('verify_me').setLabel('Verify').setStyle(ButtonStyle.Success).setEmoji('✅')
  );
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
  if (!VERIFIED_ROLE_ID) {
    return interaction.reply({ content: 'Verification is not configured.', flags: MessageFlags.Ephemeral });
  }
  const member = interaction.member;
  if (member.roles.cache.has(VERIFIED_ROLE_ID)) {
    return interaction.reply({ content: 'You are already verified.', flags: MessageFlags.Ephemeral });
  }
  try {
    await member.roles.add(VERIFIED_ROLE_ID, 'Verified via bot');
    if (UNVERIFIED_ROLE_ID && member.roles.cache.has(UNVERIFIED_ROLE_ID)) {
      await member.roles.remove(UNVERIFIED_ROLE_ID, 'Verified via bot');
    }
    await interaction.reply({ content: 'You are now verified. Welcome!', flags: MessageFlags.Ephemeral });
  } catch (err) {
    console.error('Verify failed:', err);
    await interaction.reply({
      content: 'Could not assign the verified role. Make sure the bot role is above it.',
      flags: MessageFlags.Ephemeral,
    });
  }
}

client.on('guildMemberAdd', async (member) => {
  if (member.user.bot) return;
  if (UNVERIFIED_ROLE_ID) {
    await member.roles.add(UNVERIFIED_ROLE_ID, 'New member').catch((e) => console.warn('Unverified role:', e.message));
  }

  const embed = baseEmbed()
    .setTitle(`Welcome to ${member.guild.name}`)
    .setDescription('You must verify before you can access the server. Click **Verify** below.');

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
// /transfer
// ---------------------------------------------------------------------------
async function handleTransfer(interaction) {
  const invite = interaction.options.getString('invite', true).trim();
  const extra = interaction.options.getString('message') || '';

  if (!/^https?:\/\/(www\.)?(discord\.gg|discord\.com\/invite)\/\S+$/i.test(invite)) {
    return interaction.reply({ content: 'Please provide a valid discord.gg invite link.', flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const members = await interaction.guild.members.fetch();
  const targets = members.filter((m) => !m.user.bot);

  const embed = baseEmbed()
    .setTitle(`${interaction.guild.name} is moving!`)
    .setDescription(`${extra ? `${extra}\n\n` : ''}Join the new server here:\n${invite}`);

  let sent = 0;
  let failed = 0;
  for (const member of targets.values()) {
    try {
      await member.send({ embeds: [embed] });
      sent++;
    } catch {
      failed++;
    }
    await new Promise((r) => setTimeout(r, 1100));
  }

  await interaction.editReply(`Transfer invites sent: **${sent}** delivered, **${failed}** failed (DMs closed).`);
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
  try {
    await registerCommands();
  } catch (err) {
    console.error('Command registration failed:', err);
  }
});

http
  .createServer((_, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
  })
  .listen(PORT, () => console.log(`Health server on :${PORT}`));

client.login(DISCORD_TOKEN);
