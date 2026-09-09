require('dotenv').config();
const { App } = require('@slack/bolt');
const { parseIntent, extractShipmentId } = require('./intent_parser');
const { handlePendingPrintConfirmation } = require('./handlers/print_confirmation');
const {
    handlePrintRemainingLabels,
    handleTestPrintRemainingLabels,
    handlePrintSpecificSkus,
    handleTestPrintSpecificSkus,
} = require('./handlers/print_handlers');
const { handleQueryShipmentStatus } = require('./handlers/status_handlers');

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN;

if (!SLACK_BOT_TOKEN || !SLACK_APP_TOKEN) {
    console.error('Missing SLACK_BOT_TOKEN or SLACK_APP_TOKEN. Set them in .env (see .env.example).');
    process.exit(1);
}

const EXAMPLE_USAGE = 'Try something like: "print remaining labels for the august 21 shipment"';

const HELP_TEXT = [
    "Here's what I can do:",
    "_(You don't have to match this phrasing exactly -- natural language works too, e.g. \"hey can you check on the sept 10 shipment\")_",
    '• *print remaining labels for the [shipment name] shipment* -- finds unprinted labels for the named shipment (e.g. "august 21") and sends them to the PHYSICAL PRINTER. You must name a shipment. Asks for confirmation first since this can\'t be undone.',
    '• *test print remaining labels for the [shipment name] shipment* -- same lookup, but downloads the label PDFs instead of printing them for real. No confirmation needed.',
    '• *print sku(s) [SKU, SKU, ...] from the [shipment name] shipment* -- targeted reprint of specific SKUs, even ones already printed or not checked in (flagged in the confirmation). Same physical-printer confirmation as above.',
    '• *test print sku(s) [SKU, SKU, ...] from the [shipment name] shipment* -- same targeted lookup, downloads only, no confirmation needed.',
    '• *check status of the [shipment name] shipment* -- looks up a shipment by name (e.g. "august 21") and lists its remaining unprinted labels.',
    '• *check status of all shipments* -- reports remaining-label counts across every shipment (print does not support "all" -- name one shipment to print).',
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

/* Socket Mode opens an outbound WebSocket from here to Slack instead of
    listening for inbound HTTP -- no public endpoint needed, which fits the
    Tailscale-only RPi setup. */
const app = new App({
    token: SLACK_BOT_TOKEN,
    appToken: SLACK_APP_TOKEN,
    socketMode: true,
});

async function routeMessage(text, userId, say) {
    /* Checked before intent parsing so a reply like "confirm print" is
        consumed as an answer to a pending real-print request rather than
        (harmlessly, but confusingly) being re-parsed as a fresh command. */
    if (await handlePendingPrintConfirmation(text, userId, say)) {
        return;
    }

    const { intent, skus, shipmentRef } = await parseIntent(text);
    const shipmentId = extractShipmentId(text);
    console.log(`"${text}" -> intent=${intent}, shipmentId=${shipmentId}, user=${userId}`);

    if (intent === 'print_remaining_labels') {
        if (!isAuthorized(userId)) {
            console.warn(`Blocked unauthorized print request from user ${userId}`);
            await say(`<@${userId}> Sorry, you're not authorized to run print jobs. Ask an admin to add your Slack user ID to the allowlist.`);
            return;
        }

        await handlePrintRemainingLabels({ shipmentRef }, say, userId);
        return;
    }

    if (intent === 'test_print_remaining_labels') {
        if (!isAuthorized(userId)) {
            console.warn(`Blocked unauthorized test print request from user ${userId}`);
            await say(`<@${userId}> Sorry, you're not authorized to run print jobs. Ask an admin to add your Slack user ID to the allowlist.`);
            return;
        }

        await handleTestPrintRemainingLabels({ shipmentRef }, say, userId);
        return;
    }

    if (intent === 'print_specific_skus') {
        if (!isAuthorized(userId)) {
            console.warn(`Blocked unauthorized print request from user ${userId}`);
            await say(`<@${userId}> Sorry, you're not authorized to run print jobs. Ask an admin to add your Slack user ID to the allowlist.`);
            return;
        }

        await handlePrintSpecificSkus({ skus, shipmentRef }, say, userId);
        return;
    }

    if (intent === 'test_print_specific_skus') {
        if (!isAuthorized(userId)) {
            console.warn(`Blocked unauthorized test print request from user ${userId}`);
            await say(`<@${userId}> Sorry, you're not authorized to run print jobs. Ask an admin to add your Slack user ID to the allowlist.`);
            return;
        }

        await handleTestPrintSpecificSkus({ skus, shipmentRef }, say, userId);
        return;
    }

    if (intent === 'query_shipment_status') {
        await handleQueryShipmentStatus({ shipmentRef }, say, userId);
        return;
    }

    if (intent === 'help') {
        await say(`<@${userId}> ${HELP_TEXT}`);
        return;
    }

    /* Distinct from 'unknown' (a message that just didn't match anything) --
        this means the LLM-based parser's API call itself failed (see
        intent_parser.js), so telling the user "try rephrasing" would be
        misleading. Not gated by isAuthorized: this can surface for any
        command, including read-only ones. */
    if (intent === 'parser_error') {
        await say(`<@${userId}> Sorry, I'm having trouble understanding messages right now -- please try again in a moment.`);
        return;
    }

    await say(`<@${userId}> Sorry, I didn't catch a command in that. ${EXAMPLE_USAGE}`);
}

app.event('app_mention', async ({ event, say }) => {
    await routeMessage(event.text, event.user, say);
});

app.message(async ({ message, say, context }) => {
    /* Skip subtype'd messages (edits, deletes, bot messages, joins, etc.) --
        only respond to plain user-typed messages. */
    if (message.subtype) return;

    /* Slack fires both 'message' and 'app_mention' for a message that
        @-mentions the bot in a channel -- without this check it would be
        routed (and, for print jobs, submitted to the print server) twice. */
    if (context.botUserId && message.text?.includes(`<@${context.botUserId}>`)) {
        return;
    }

    await routeMessage(message.text, message.user, say);
});

(async () => {
    await app.start();
    console.log('Slack bot is running in Socket Mode.');
})();
