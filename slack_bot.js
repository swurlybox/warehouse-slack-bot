require('dotenv').config();
const { App, SocketModeReceiver } = require('@slack/bolt');
const { parseIntent, extractShipmentId } = require('./intent_parser');
const { handlePendingPrintConfirmation } = require('./handlers/print_confirmation');
const { handlePendingProductSelection } = require('./handlers/product_selection');
const {
    handlePrintRemainingLabels,
    handleTestPrintRemainingLabels,
    handlePrintSpecificSkus,
    handleTestPrintSpecificSkus,
    handlePrintByProductName,
    handleTestPrintByProductName,
    handleResolvedProductSelection,
} = require('./handlers/print_handlers');
const { handleQueryShipmentStatus, buildStatusPageBlocks, STATUS_PAGE_SIZE } = require('./handlers/status_handlers');
const { setStatusPageCache, getStatusPageCache } = require('./handlers/status_pagination');

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
    '• *print sku(s) [SKU, SKU, ...] from the [shipment name] shipment* -- targeted reprint of specific SKUs, even ones already printed or not checked in (flagged in the confirmation). Same physical-printer confirmation as above. Optionally say how many labels to print for a SKU (e.g. "print 5 of SKU X" or "SKU X x3") -- it overrides the usual count, and the confirmation flags it as overridden.',
    '• *test print sku(s) [SKU, SKU, ...] from the [shipment name] shipment* -- same targeted lookup, downloads only, no confirmation needed. Same optional per-SKU quantity override as above.',
    '• *print the [product name] from the [shipment name] shipment* -- don\'t know the exact SKU? Describe the product instead (e.g. "the kikkoman soy sauce") and I\'ll show up to 10 matching SKUs from that shipment. Reply with a number to pick one (or several, comma-separated), optionally with a quantity override (e.g. "1 x5") -- then the same physical-printer confirmation as above.',
    '• *test print the [product name] from the [shipment name] shipment* -- same product search, but the eventual print is a dry-run download instead of physical.',
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

/* Bolt's `socketMode: true` shorthand builds its own default
    SocketModeReceiver internally (see @slack/bolt's App.js, initReceiver),
    but that path doesn't forward clientPingTimeout/serverPingTimeout --
    only appToken/clientId/clientSecret/stateSecret/redirectUri/
    installationStore/scopes/logger/logLevel/installerOptions/customRoutes
    make it through. That leaves @slack/socket-mode's hardcoded 5-second
    client ping timeout in effect no matter what, which is tight enough
    that ordinary network jitter (not just a genuinely dead connection)
    trips a "pong wasn't received" disconnect/reconnect cycle -- this
    session hit that repeatedly. Constructing the receiver manually and
    passing it in as `receiver` is the only way to loosen it; `socketMode:
    true` is kept alongside it because App.js's initReceiver only accepts a
    custom receiver when it actually is a SocketModeReceiver, which this
    is. 3x/2x the defaults (5000ms/30000ms) -- enough headroom to absorb
    real jitter without waiting so long that a truly dead connection goes
    unnoticed for an unreasonable stretch. */
const socketModeReceiver = new SocketModeReceiver({
    appToken: SLACK_APP_TOKEN,
    clientPingTimeout: 15000,
    serverPingTimeout: 60000,
});

/* Socket Mode opens an outbound WebSocket from here to Slack instead of
    listening for inbound HTTP -- no public endpoint needed, which fits the
    Tailscale-only RPi setup. */
const app = new App({
    token: SLACK_BOT_TOKEN,
    socketMode: true,
    receiver: socketModeReceiver,
});

async function routeMessage(text, userId, say) {
    /* Checked before intent parsing so a reply like "confirm print" is
        consumed as an answer to a pending real-print request rather than
        (harmlessly, but confusingly) being re-parsed as a fresh command. */
    if (await handlePendingPrintConfirmation(text, userId, say)) {
        return;
    }

    /* Checked next, before intent parsing, for the same reason as the
        confirmation gate above -- a bare numeric reply like "1" or "1, 3"
        answering a shown product-name candidate list shouldn't get
        re-parsed as a fresh command. handleResolvedProductSelection is
        passed in here (not required by product_selection.js directly) so
        that module doesn't need to require handlers/print_handlers.js back. */
    if (await handlePendingProductSelection(text, userId, say, handleResolvedProductSelection)) {
        return;
    }

    const { intent, skus, shipmentRef, productQuery } = await parseIntent(text);
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

    if (intent === 'print_by_product_name') {
        if (!isAuthorized(userId)) {
            console.warn(`Blocked unauthorized print request from user ${userId}`);
            await say(`<@${userId}> Sorry, you're not authorized to run print jobs. Ask an admin to add your Slack user ID to the allowlist.`);
            return;
        }

        await handlePrintByProductName({ productQuery, shipmentRef }, say, userId);
        return;
    }

    if (intent === 'test_print_by_product_name') {
        if (!isAuthorized(userId)) {
            console.warn(`Blocked unauthorized test print request from user ${userId}`);
            await say(`<@${userId}> Sorry, you're not authorized to run print jobs. Ask an admin to add your Slack user ID to the allowlist.`);
            return;
        }

        await handleTestPrintByProductName({ productQuery, shipmentRef }, say, userId);
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

/* Handles Next/Previous clicks on a paginated shipment-status message (see
    handlers/status_handlers.js's buildStatusPageBlocks). Arrives over the
    same Socket Mode websocket as everything else -- no separate endpoint
    needed -- but as a block_actions payload, not a chat message, so it
    can't go through routeMessage's pending-state checks (those are keyed
    by which user is expected to reply; a button click instead carries
    which message was clicked, via body.channel.id/body.message.ts, which
    is what status_pagination.js's cache is keyed by). */
app.action('status_page_nav', async ({ ack, body, client }) => {
    await ack(); // first, before any Airtable/Slack-API work -- Slack requires ack within 3s

    const channelId = body.channel.id;
    const messageTs = body.message.ts;
    const targetPage = Number(body.actions[0].value);

    const cached = getStatusPageCache(channelId, messageTs);
    if (!cached) {
        console.log(`status_page_nav: cache miss for ${channelId}:${messageTs} (requested page ${targetPage}) -- showing expired notice`);
        await client.chat.update({
            channel: channelId,
            ts: messageTs,
            text: 'This view expired -- please re-run the status command.',
            blocks: [{
                type: 'section',
                text: { type: 'mrkdwn', text: ':warning: This view expired. Re-run the status command (e.g. "check status of the sept 10 shipment") to see current data.' },
            }],
        });
        return;
    }

    const totalPages = Math.ceil(cached.rows.length / STATUS_PAGE_SIZE);
    const page = Math.min(Math.max(targetPage, 0), totalPages - 1); // defensive clamp against a stale/odd value

    console.log(`status_page_nav: "${cached.shipment}" -> page ${page + 1}/${totalPages} for ${channelId}:${messageTs}`);

    const { text, blocks } = buildStatusPageBlocks({
        shipment: cached.shipment,
        userId: cached.userId,
        rows: cached.rows,
        page,
        totalPages,
    });

    await client.chat.update({ channel: channelId, ts: messageTs, text, blocks });

    setStatusPageCache(channelId, messageTs, cached); // slides the TTL forward on activity
});

(async () => {
    await app.start();
    console.log('Slack bot is running in Socket Mode.');
})();
