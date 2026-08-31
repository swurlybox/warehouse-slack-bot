require('dotenv').config();
const { App } = require('@slack/bolt');
const { fetchRemainingLabelsForTable, DEFAULT_SHIPMENT_TABLE } = require('./fetch_remaining_labels');
const { parseIntent, extractShipmentId } = require('./intent_parser');
const { submitPrintJob } = require('./print_service');
const { findShipmentTable, isAllShipmentsQuery, fetchRemainingLabelsForAllShipments } = require('./shipment_lookup');

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN;

if (!SLACK_BOT_TOKEN || !SLACK_APP_TOKEN) {
    console.error('Missing SLACK_BOT_TOKEN or SLACK_APP_TOKEN. Set them in .env (see .env.example).');
    process.exit(1);
}

const EXAMPLE_USAGE = 'Try something like: "print remaining labels for the current shipment"';

const HELP_TEXT = [
    "Here's what I can do:",
    '• *print remaining labels [for the [shipment name] shipment]* -- finds unprinted labels for the named shipment (e.g. "august 21"), or the current shipment if none is named, and sends them to the printer.',
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

/* Resolves which shipment table a print/query command should target: an
    explicitly named shipment (e.g. "for the august 21 shipment") wins, an
    empty query (e.g. "print remaining labels for the current shipment", which
    reduces to no leftover words once command filler is stripped) falls back
    to DEFAULT_SHIPMENT_TABLE, and a name that matches zero or multiple tables
    is reported back to the caller to handle -- callers should not print
    against an ambiguous or unresolved shipment. */
async function resolveShipmentTableName(text) {
    const result = await findShipmentTable(text);

    if (result.status === 'not_found' && result.queryTokens.length === 0) {
        return { status: 'ok', tableName: DEFAULT_SHIPMENT_TABLE };
    }
    if (result.status === 'ok') {
        return { status: 'ok', tableName: result.table.name };
    }
    return result;
}

/* Fetches the named (or, if none was given, current) shipment's
    unprinted-label rows from Airtable and sends them to the RPi print
    server. The Slack reply only reports success/failure and the SKU count
    -- not the print server's own response body, which is that automation's
    internal output and free to change shape independently of this bot. */
async function handlePrintRemainingLabels(text, say, userId) {
    /* Deliberately no bulk option here, unlike the status query -- printing
        every shipment's labels in one shot is a much higher-consequence
        mistake (real labels on a real printer) than a long status message. */
    if (isAllShipmentsQuery(text)) {
        await say(`<@${userId}> Printing for all shipments at once isn't supported -- please name one shipment, e.g. "print remaining labels for the august 21 shipment".`);
        return;
    }

    const resolved = await resolveShipmentTableName(text).catch((error) => {
        console.error('Failed to look up shipment tables:', error.message);
        return { status: 'error', message: error.message };
    });

    if (resolved.status === 'error') {
        await say(`<@${userId}> Sorry, I couldn't look up shipment tables: ${resolved.message}`);
        return;
    }
    if (resolved.status === 'not_found') {
        await say(`<@${userId}> I couldn't tell which shipment you meant. Try naming it, e.g. "print remaining labels for the august 21 shipment".`);
        return;
    }
    if (resolved.status === 'ambiguous') {
        const names = resolved.matches.map((table) => `"${table.name}"`).join(', ');
        await say(`<@${userId}> That matches more than one shipment: ${names}. Can you be more specific?`);
        return;
    }

    let payload;
    try {
        payload = await fetchRemainingLabelsForTable(resolved.tableName);
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

/* Reports remaining-label counts across every known shipment table (paced
    one Airtable request at a time -- see fetchRemainingLabelsForAllShipments
    for the rate-limit reasoning). Only shipments that still need labels, or
    that failed to read, are listed individually; fully-printed shipments are
    just counted, since spelling out all ~25+ of them every time would bury
    the ones that actually need attention. */
async function handleQueryAllShipmentsStatus(say, userId) {
    let results;
    try {
        results = await fetchRemainingLabelsForAllShipments();
    } catch (error) {
        console.error('Failed to look up shipment tables:', error.message);
        await say(`<@${userId}> Sorry, I couldn't look up shipment tables: ${error.message}`);
        return;
    }

    const withRemaining = results.filter((r) => !r.error && r.items.length > 0);
    const fullyPrinted = results.filter((r) => !r.error && r.items.length === 0);
    const failed = results.filter((r) => r.error);

    if (withRemaining.length === 0 && failed.length === 0) {
        await say(`<@${userId}> Checked ${results.length} shipment(s) -- all fully printed, nothing remaining anywhere.`);
        return;
    }

    const lines = [
        ...withRemaining.map((r) => `• "${r.shipment}" -- ${r.items.length} SKU(s) remaining`),
        ...failed.map((r) => `• "${r.shipment}" -- couldn't read (${r.error})`),
    ];

    const summary = `Checked ${results.length} shipment(s): ${withRemaining.length} with remaining labels, ${fullyPrinted.length} fully printed` +
        (failed.length ? `, ${failed.length} failed to read` : '') + '.';

    await say(`<@${userId}> ${summary}\n${lines.join('\n')}`);
}

/* Looks up a shipment by name (fuzzy-matched against Airtable table names,
    e.g. "august 21" -> "August 21 Shipment") and reports its remaining
    unprinted labels. Read-only -- no print job is triggered -- so unlike
    handlePrintRemainingLabels this isn't gated by isAuthorized. */
async function handleQueryShipmentStatus(text, say, userId) {
    if (isAllShipmentsQuery(text)) {
        await handleQueryAllShipmentsStatus(say, userId);
        return;
    }

    let result;
    try {
        result = await findShipmentTable(text);
    } catch (error) {
        console.error('Failed to look up shipment tables:', error.message);
        await say(`<@${userId}> Sorry, I couldn't look up shipment tables: ${error.message}`);
        return;
    }

    if (result.status === 'not_found') {
        await say(`<@${userId}> I couldn't tell which shipment you meant. Try naming it, e.g. "check status of the august 21 shipment".`);
        return;
    }

    if (result.status === 'ambiguous') {
        const names = result.matches.map((table) => `"${table.name}"`).join(', ');
        await say(`<@${userId}> That matches more than one shipment: ${names}. Can you be more specific?`);
        return;
    }

    let payload;
    try {
        payload = await fetchRemainingLabelsForTable(result.table.name);
    } catch (error) {
        console.error('Failed to fetch shipment data:', error.message);
        await say(`<@${userId}> Sorry, I couldn't read "${result.table.name}": ${error.message}`);
        return;
    }

    if (payload.items.length === 0) {
        await say(`<@${userId}> "${payload.shipment}" has no remaining labels to print -- everything's already printed.`);
        return;
    }

    const lines = payload.items.map((item) => `• ${item.sku} — ${item.quantity}`).join('\n');
    await say(`<@${userId}> "${payload.shipment}" has ${payload.items.length} SKU(s) still needing labels:\n${lines}`);
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

        await handlePrintRemainingLabels(text, say, userId);
        return;
    }

    if (intent === 'query_shipment_status') {
        await handleQueryShipmentStatus(text, say, userId);
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
