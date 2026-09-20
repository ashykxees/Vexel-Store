// Entry point. Runs the Vexel Store bot (DISCORD_TOKEN) and, if TICKET_BOT_TOKEN is set,
// the Botivo ticket bot in the same process. BOT_MODE=ticket runs only the ticket bot.
const mode = (process.env.BOT_MODE || 'both').toLowerCase();

if (mode === 'ticket' || mode === 'tickets') {
  require('./ticket-bot/index.js');
} else {
  require('./index.js');
  if (process.env.TICKET_BOT_TOKEN) {
    process.env.TICKET_EMBEDDED = '1';
    require('./ticket-bot/index.js');
  } else {
    console.log('TICKET_BOT_TOKEN not set; ticket bot not started.');
  }
}
