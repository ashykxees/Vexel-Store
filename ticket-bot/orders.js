// Stripe order logging: polls completed Checkout Sessions and accepts webhooks
// as an optional fast path.
const { EmbedBuilder } = require('discord.js');
const Stripe = require('stripe');

const ORDER_CHANNEL_ID = process.env.ORDER_CHANNEL_ID || '1551324617896099980';
const GUILD_ID = process.env.GUILD_ID || '';
const BRAND_COLOR = 0x5865f2;

let client = null;
let stripeClient = null;
const logged = new Set();
const inFlight = new Set();
let lastRunStart = null;
let polling = false;
let pollTimer = null;

function attachClient(c) {
  client = c;
}

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not set');
  if (!stripeClient) stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY);
  return stripeClient;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function money(cents, currency) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: (currency || 'usd').toUpperCase() }).format(
    (cents || 0) / 100
  );
}

function describePaymentMethod(pm) {
  if (!pm || typeof pm !== 'object') return 'Unknown';
  if (pm.card) {
    const brand = pm.card.brand ? pm.card.brand[0].toUpperCase() + pm.card.brand.slice(1) : 'Card';
    const wallet = pm.card.wallet?.type ? ` (${pm.card.wallet.type.replace(/_/g, ' ')})` : '';
    return `${brand} •••• ${pm.card.last4}${wallet}`;
  }
  return pm.type ? pm.type.replace(/_/g, ' ') : 'Unknown';
}

async function membershipStatus(username) {
  if (!username || !client?.isReady() || !GUILD_ID) return 'Unknown';
  const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
  if (!guild) return 'Unknown';
  const query = username.replace(/^@/, '').split('#')[0].toLowerCase();
  const found = await guild.members.search({ query, limit: 10 }).catch(() => null);
  if (!found) return 'Unknown';
  const member = found.find(
    (m) => m.user.username.toLowerCase() === query || m.user.globalName?.toLowerCase() === query
  );
  return member ? `Yes (<@${member.id}>)` : 'No';
}

function orderNumber(session) {
  const pi = session.payment_intent;
  const id = typeof pi === 'string' ? pi : pi?.id;
  const source = (id ?? session.id).replace(/^(pi|cs_live|cs_test)_/, '');
  return source.slice(-10).toUpperCase();
}

async function logSession(sessionId) {
  if (logged.has(sessionId) || inFlight.has(sessionId)) return false;
  inFlight.add(sessionId);
  try {
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['line_items', 'payment_intent.payment_method', 'total_details.breakdown'],
    });
    if (session.metadata?.discord_logged === 'true') {
      logged.add(sessionId);
      return false;
    }
    if (!['paid', 'no_payment_required'].includes(session.payment_status)) return false;

    const meta = session.metadata || {};
    const discordUsername =
      meta.discord_username ||
      session.custom_fields?.find((f) => f.key === 'discord_username')?.text?.value ||
      '';
    const email = session.customer_details?.email || session.customer_email || 'Unknown';
    const orderId = orderNumber(session);
    const items = (session.line_items?.data || [])
      .map((li) => `• ${li.quantity}× ${li.description} — ${money(li.amount_total, li.currency)}`)
      .join('\n');
    const paymentMethod =
      typeof session.payment_intent === 'object' ? describePaymentMethod(session.payment_intent?.payment_method) : 'Unknown';
    const discount = session.total_details?.amount_discount || 0;
    const promo = session.total_details?.breakdown?.discounts?.[0]?.discount?.promotion_code;

    const embed = new EmbedBuilder()
      .setColor(BRAND_COLOR)
      .setTitle(`New order #${orderId}`)
      .addFields(
        { name: 'Order #', value: `\`${orderId}\``, inline: true },
        { name: 'Email', value: email, inline: true },
        { name: 'In server?', value: await membershipStatus(discordUsername), inline: true },
        { name: 'Discord username', value: discordUsername || 'Not provided', inline: true },
        { name: 'Payment method', value: paymentMethod, inline: true },
        { name: 'Total', value: money(session.amount_total, session.currency), inline: true },
        { name: 'Product(s)', value: items || 'Unknown' }
      )
      .setFooter({ text: `Stripe session ${session.id}` })
      .setTimestamp(new Date((session.created || Date.now() / 1000) * 1000));
    if (discount > 0) {
      embed.addFields({
        name: 'Discount',
        value: `-${money(discount, session.currency)}${promo ? ` (${typeof promo === 'string' ? promo : promo.code})` : ''}`,
        inline: true,
      });
    }

    const channel = await client.channels.fetch(ORDER_CHANNEL_ID);
    if (!channel?.isTextBased()) throw new Error(`Order channel ${ORDER_CHANNEL_ID} is not a text channel`);
    await channel.send({ embeds: [embed] });
    logged.add(sessionId);
    try {
      await stripe.checkout.sessions.update(sessionId, { metadata: { discord_logged: 'true' } });
    } catch (err) {
      console.warn(`[orders] Failed to mark session ${sessionId} as logged:`, err.message);
    }
    return true;
  } finally {
    inFlight.delete(sessionId);
  }
}

function startOrderPoller() {
  if (!process.env.STRIPE_SECRET_KEY) {
    console.warn('[orders] STRIPE_SECRET_KEY not set; order logging disabled');
    return;
  }
  if (pollTimer) return;

  const configuredSeconds = Number.parseInt(process.env.ORDER_POLL_SECONDS || '30', 10);
  const intervalSeconds = Math.max(10, Number.isFinite(configuredSeconds) ? configuredSeconds : 30);
  console.log(`[orders] Polling Stripe for completed orders every ${intervalSeconds}s`);

  async function poll() {
    if (polling || !client?.isReady()) return;
    polling = true;
    const runStart = Math.floor(Date.now() / 1000);
    const since = lastRunStart == null ? runStart - 86400 : lastRunStart - 300;
    lastRunStart = runStart;
    try {
      const stripe = getStripe();
      for await (const session of stripe.checkout.sessions.list({
        status: 'complete',
        created: { gte: since },
        limit: 100,
      })) {
        if (session.metadata?.discord_logged === 'true' || logged.has(session.id)) continue;
        try {
          await logSession(session.id);
        } catch (err) {
          console.error(`[orders] Failed to log session ${session.id}:`, err);
        }
      }
    } catch (err) {
      console.error('[orders] Stripe polling failed:', err);
    } finally {
      polling = false;
    }
  }

  void poll();
  pollTimer = setInterval(poll, intervalSeconds * 1000);
}

async function handleStripeWebhook(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405);
    return res.end();
  }
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.error('[orders] STRIPE_WEBHOOK_SECRET is not set');
    res.writeHead(500);
    return res.end('Webhook secret not configured');
  }
  let event;
  try {
    const raw = await readBody(req);
    event = getStripe().webhooks.constructEvent(raw, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[orders] Bad webhook signature:', err.message);
    res.writeHead(400);
    return res.end(`Webhook error: ${err.message}`);
  }
  // Acknowledge quickly; Stripe retries on non-2xx.
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('{"received":true}');

  if (event.type !== 'checkout.session.completed') return;
  try {
    await logSession(event.data.object.id);
    console.log(`[orders] Logged order ${event.data.object.id}`);
  } catch (err) {
    console.error('[orders] Failed to post order embed:', err);
  }
}

module.exports = { attachClient, handleStripeWebhook, logSession, orderNumber, startOrderPoller };
