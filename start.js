// Entry selector: BOT_MODE=ticket runs the Botivo ticket bot, anything else runs the Vexel Store bot.
const mode = (process.env.BOT_MODE || 'store').toLowerCase();
if (mode === 'ticket' || mode === 'tickets') {
  require('./ticket-bot/index.js');
} else {
  require('./index.js');
}
