require('dotenv').config();
const { App } = require('@slack/bolt');
const { fetchRemainingLabels } = require('./fetch_remaining_labels');
const { parseIntent, extractShipmentId } = require('./intent_parser');
const { submitPrintJob } = require('./print_service');

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN;

if (!SLACK_BOT_TOKEN || !SLACK_APP_TOKEN) {
    console.error('Missing SLACK_BOT_TOKEN or SLACK_APP_TOKEN. Set them in .env (see .env.example).');
    process.exit(1);
}

const EXAMPLE_USAGE = 'Try something like: "print remaining labels for the current shipment"';

const HELP_TEXT = [
    "Here's what I can do:",
    '• *print remaining labels [for the current shipment]* -- finds unprinted labels for the current shipment and sends them to the printer.',
    '• *help* -- shows this message.',
].join('\n');

/* Slack user IDs allowed to trigger print jobs (comma-separated in .env).
    Fails closed: an empty list means nobody is authorized rather than
    silently allowing anyone -- a forgotten allowlist should break loudly,
    not become an open door. Find a user's ID in Slack via their profile ->
    "Copy member ID". */
const AUTHORIZED_USER_IDS = new Set(
    (process.env.AUTHORIZED_USER_IDS || '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
);

if (AUTHORIZED_USER_IDS.size === 0) {
    console.warn('AUTHORIZED_USER_IDS is empty -- nobody is authorized to run print commands until it is set in .env.');
}

function isAuthorized(userId) {
    return AUTHORIZED_USER_IDS.has(userId);
}

/* Fetches the current shipment's unprinted-label rows from Airtable and
    sends them to the RPi print server. The Slack reply only reports
    success/failure and the SKU count -- not the print server's own
    response body, which is that automation's internal output and free to
    change shape independently of this bot. */
async function handlePrintRemainingLabels(say, userId) {
    let payload;
    try {
        payload = await fetchRemainingLabels();
    } catch (error) {
        console.error('Failed to fetch remaining labels:', error.message);
        await say(`<@${userId}> Sorry, I couldn't reach Airtable: ${error.message}`);
        return;
    }

    if (payload.items.length === 0) {
        await say(`<@${userId}> No remaining labels to print for "${payload.shipment}" -- everything's already printed.`);
        return;
    }

    const lines = payload.items.map((item) => `• ${item.sku} — ${item.quantity}`).join('\n');
    await say(`<@${userId}> Found ${payload.items.length} SKU(s) still needing labels for "${payload.shipment}", sending to the print server:\n${lines}`);

    try {
        await submitPrintJob(payload.items);
        await say(`<@${userId}> Print job sent for "${payload.shipment}" (${payload.items.length} SKU(s)).`);
    } catch (error) {
        console.error('Print job failed:', error.message);
        await say(`<@${userId}> Sorry, the print job failed: ${error.message}`);
    }
}

/* Socket Mode opens an outbound WebSocket from here to Slack instead of
    listening for inbound HTTP -- no public endpoint needed, which fits the
    Tailscale-only RPi setup. */
const app = new App({
    token: SLACK_BOT_TOKEN,
    appToken: SLACK_APP_TOKEN,
    socketMode: true,
});

async function routeMessage(text, userId, say) {
    const { intent } = parseIntent(text);
    const shipmentId = extractShipmentId(text);
    console.log(`"${text}" -> intent=${intent}, shipmentId=${shipmentId}, user=${userId}`);

    if (intent === 'print_remaining_labels') {
        if (!isAuthorized(userId)) {
            console.warn(`Blocked unauthorized print request from user ${userId}`);
            await say(`<@${userId}> Sorry, you're not authorized to run print jobs. Ask an admin to add your Slack user ID to the allowlist.`);
            return;
        }

        await handlePrintRemainingLabels(say, userId);
        return;
    }

    if (intent === 'help') {
        await say(`<@${userId}> ${HELP_TEXT}`);
        return;
    }

    await say(`<@${userId}> Sorry, I didn't catch a command in that. ${EXAMPLE_USAGE}`);
}

app.event('app_mention', async ({ event, say }) => {
    await routeMessage(event.text, event.user, say);
});

app.message(async ({ message, say }) => {
    /* Skip subtype'd messages (edits, deletes, bot messages, joins, etc.) --
        only respond to plain user-typed messages. */
    if (message.subtype) return;

    await routeMessage(message.text, message.user, say);
});

(async () => {
    await app.start();
    console.log('Slack bot is running in Socket Mode.');
})();
