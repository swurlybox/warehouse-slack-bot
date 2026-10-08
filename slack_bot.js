/**
 * @module slack_bot
 * Entry point: Bolt Socket Mode app setup, message routing (routeMessage),
 * per-intent dispatch to handlers/, and the status-pagination button-click
 * handler.
 */
require('dotenv').config();
const { App } = require('@slack/bolt');
const { parseIntent, extractShipmentId } = require('./llm/intent_parser');
const {
    handlePendingPrintConfirmation,
} = require('./handlers/print_confirmation');
const {
    handlePendingProductSelection,
} = require('./handlers/product_selection');
const {
    handlePrintRemainingLabels,
    handleTestPrintRemainingLabels,
    handlePrintSpecificSkus,
    handleTestPrintSpecificSkus,
    handlePrintByProductName,
    handleTestPrintByProductName,
    handleResolvedProductSelection,
} = require('./handlers/print_handlers');
const {
    handleQueryShipmentStatus,
    buildStatusPageBlocks,
    STATUS_PAGE_SIZE,
} = require('./handlers/status_handlers');
const {
    setStatusPageCache,
    getStatusPageCache,
} = require('./handlers/status_pagination');

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN;

if (!SLACK_BOT_TOKEN || !SLACK_APP_TOKEN) {
    console.error(
        'Missing SLACK_BOT_TOKEN or SLACK_APP_TOKEN. ' +
        'Set them in .env (see .env.example).'
    );
    process.exit(1);
}

const EXAMPLE_USAGE = (
    'Try something like: "print remaining labels for the august 21 shipment"'
);

const HELP_TEXT = [
    "Here's what I can do:",
    "_(You don't have to match this phrasing exactly -- natural " +
        'language works too, e.g. "hey can you check on the sept 10 ' +
        'shipment")_',
    '• *print remaining labels for the [shipment name] shipment* -- ' +
        'finds unprinted labels for the named shipment (e.g. "august ' +
        '21") and sends them to the PHYSICAL PRINTER. You must name a ' +
        "shipment. Asks for confirmation first since this can't be undone.",
    '• *test print remaining labels for the [shipment name] shipment* ' +
        '-- same lookup, but downloads the label PDFs instead of ' +
        'printing them for real. No confirmation needed.',
    '• *print sku(s) [SKU, SKU, ...] from the [shipment name] ' +
        'shipment* -- targeted reprint of specific SKUs, even ones ' +
        'already printed or not checked in (flagged in the ' +
        'confirmation). Same physical-printer confirmation as above. ' +
        'Optionally say how many labels to print for a SKU (e.g. ' +
        '"print 5 of SKU X" or "SKU X x3") -- it overrides the usual ' +
        'count, and the confirmation flags it as overridden.',
    '• *test print sku(s) [SKU, SKU, ...] from the [shipment name] ' +
        'shipment* -- same targeted lookup, downloads only, no ' +
        'confirmation needed. Same optional per-SKU quantity override ' +
        'as above.',
    '• *print the [product name] from the [shipment name] shipment* ' +
        "-- don't know the exact SKU? Describe the product instead " +
        '(e.g. "the kikkoman soy sauce") and I\'ll show up to 10 ' +
        'matching SKUs from that shipment. Reply with a number to ' +
        'pick one (or several, comma-separated), optionally with a ' +
        'quantity override (e.g. "1 x5") -- then the same ' +
        'physical-printer confirmation as above.',
    '• *test print the [product name] from the [shipment name] ' +
        'shipment* -- same product search, but the eventual print is ' +
        'a dry-run download instead of physical.',
    '• *check status of the [shipment name] shipment* -- looks up a ' +
        'shipment by name (e.g. "august 21") and lists its remaining ' +
        'unprinted labels.',
    '• *check status of all shipments* -- reports remaining-label ' +
        'counts across every shipment (print does not support "all" ' +
        '-- name one shipment to print).',
    '• *help* -- shows this message.',
].join('\n');

// Fails closed: an empty list means nobody is authorized
// -- a forgotten allowlist should break loudly.
const AUTHORIZED_USER_IDS = new Set(
    (process.env.AUTHORIZED_USER_IDS || '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
);

if (AUTHORIZED_USER_IDS.size === 0) {
    console.warn(
        'AUTHORIZED_USER_IDS is empty -- nobody is authorized to run ' +
        'print commands until it is set in .env.'
    );
}

function isAuthorized(userId) {
    return AUTHORIZED_USER_IDS.has(userId);
}

// Socket Mode opens an outbound WebSocket to Slack -- no public
// endpoint needed, fitting the Tailscale-only RPi setup.
const app = new App({
    token: SLACK_BOT_TOKEN,
    appToken: SLACK_APP_TOKEN,
    socketMode: true,
});

// Dispatches an incoming message: pending-state gates first, then
// intent classification, then the matching handler.
async function routeMessage(text, userId, say) {
    // Checked before intent parsing so a reply like "confirm print" is
    // consumed as an answer, not re-parsed as a fresh command.
    if (await handlePendingPrintConfirmation(text, userId, say)) {
        return;
    }

    // handleResolvedProductSelection is passed in (not required
    // directly by product_selection.js) to avoid a require cycle with
    // print_handlers.js.
    const consumedSelection = await handlePendingProductSelection(
        text,
        userId,
        say,
        handleResolvedProductSelection
    );
    if (consumedSelection) {
        return;
    }

    const { intent, skus, shipmentRef, productQuery } = await parseIntent(text);
    const shipmentId = extractShipmentId(text);
    console.log(
        `"${text}" -> intent=${intent}, shipmentId=${shipmentId}, ` +
        `user=${userId}`
    );

    if (intent === 'print_remaining_labels') {
        if (!isAuthorized(userId)) {
            console.warn(
                `Blocked unauthorized print request from user ${userId}`
            );
            await say(
                `<@${userId}> Sorry, you're not authorized to run ` +
                `print jobs. Ask an admin to add your Slack user ID ` +
                `to the allowlist.`
            );
            return;
        }

        await handlePrintRemainingLabels({ shipmentRef }, say, userId);
        return;
    }

    if (intent === 'test_print_remaining_labels') {
        if (!isAuthorized(userId)) {
            console.warn(
                `Blocked unauthorized test print request from user ${userId}`
            );
            await say(
                `<@${userId}> Sorry, you're not authorized to run ` +
                `print jobs. Ask an admin to add your Slack user ID ` +
                `to the allowlist.`
            );
            return;
        }

        await handleTestPrintRemainingLabels({ shipmentRef }, say, userId);
        return;
    }

    if (intent === 'print_specific_skus') {
        if (!isAuthorized(userId)) {
            console.warn(
                `Blocked unauthorized print request from user ${userId}`
            );
            await say(
                `<@${userId}> Sorry, you're not authorized to run ` +
                `print jobs. Ask an admin to add your Slack user ID ` +
                `to the allowlist.`
            );
            return;
        }

        await handlePrintSpecificSkus({ skus, shipmentRef }, say, userId);
        return;
    }

    if (intent === 'test_print_specific_skus') {
        if (!isAuthorized(userId)) {
            console.warn(
                `Blocked unauthorized test print request from user ${userId}`
            );
            await say(
                `<@${userId}> Sorry, you're not authorized to run ` +
                `print jobs. Ask an admin to add your Slack user ID ` +
                `to the allowlist.`
            );
            return;
        }

        await handleTestPrintSpecificSkus({ skus, shipmentRef }, say, userId);
        return;
    }

    if (intent === 'print_by_product_name') {
        if (!isAuthorized(userId)) {
            console.warn(
                `Blocked unauthorized print request from user ${userId}`
            );
            await say(
                `<@${userId}> Sorry, you're not authorized to run ` +
                `print jobs. Ask an admin to add your Slack user ID ` +
                `to the allowlist.`
            );
            return;
        }

        await handlePrintByProductName(
            { productQuery, shipmentRef },
            say,
            userId
        );
        return;
    }

    if (intent === 'test_print_by_product_name') {
        if (!isAuthorized(userId)) {
            console.warn(
                `Blocked unauthorized test print request from user ${userId}`
            );
            await say(
                `<@${userId}> Sorry, you're not authorized to run ` +
                `print jobs. Ask an admin to add your Slack user ID ` +
                `to the allowlist.`
            );
            return;
        }

        await handleTestPrintByProductName(
            { productQuery, shipmentRef },
            say,
            userId
        );
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

    // Distinct from 'unknown': this means the parser's API call itself
    // failed, so "try rephrasing" would be misleading. Not gated by
    // isAuthorized -- can surface for any command.
    if (intent === 'parser_error') {
        await say(
            `<@${userId}> Sorry, I'm having trouble understanding ` +
            `messages right now -- please try again in a moment.`
        );
        return;
    }

    await say(
        `<@${userId}> Sorry, I didn't catch a command in that. ${EXAMPLE_USAGE}`
    );
}

app.event('app_mention', async ({ event, say }) => {
    await routeMessage(event.text, event.user, say);
});

app.message(async ({ message, say, context }) => {
    // Only respond to plain user-typed messages, not
    // edits/deletes/bot messages/joins.
    if (message.subtype) return;

    // Slack fires both 'message' and 'app_mention' for an @-mention in
    // a channel -- without this check it would route (and print) twice.
    const mentionsBot = context.botUserId &&
        message.text?.includes(`<@${context.botUserId}>`);
    if (mentionsBot) {
        return;
    }

    await routeMessage(message.text, message.user, say);
});

// Handles Next/Previous clicks on a paginated status message. A
// block_actions payload, not a chat message, so it bypasses
// routeMessage entirely.
app.action('status_page_nav', async ({ ack, body, client }) => {
    await ack(); // Must happen first -- Slack requires ack within 3s.

    const channelId = body.channel.id;
    const messageTs = body.message.ts;
    const targetPage = Number(body.actions[0].value);

    const cached = getStatusPageCache(channelId, messageTs);
    if (!cached) {
        console.log(
            `status_page_nav: cache miss for ${channelId}:${messageTs} ` +
            `(requested page ${targetPage}) -- showing expired notice`
        );
        await client.chat.update({
            channel: channelId,
            ts: messageTs,
            text: 'This view expired -- please re-run the status command.',
            blocks: [{
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: ':warning: This view expired. Re-run the ' +
                        'status command (e.g. "check status of the ' +
                        'sept 10 shipment") to see current data.',
                },
            }],
        });
        return;
    }

    const totalPages = Math.ceil(cached.rows.length / STATUS_PAGE_SIZE);
    // Defensive clamp against a stale/odd value.
    const page = Math.min(Math.max(targetPage, 0), totalPages - 1);

    console.log(
        `status_page_nav: "${cached.shipment}" -> page ${page + 1}/` +
        `${totalPages} for ${channelId}:${messageTs}`
    );

    const { text, blocks } = buildStatusPageBlocks({
        shipment: cached.shipment,
        userId: cached.userId,
        rows: cached.rows,
        page,
        totalPages,
    });

    await client.chat.update({
        channel: channelId,
        ts: messageTs,
        text,
        blocks,
    });

    // Slides the TTL forward on activity.
    setStatusPageCache(channelId, messageTs, cached);
});

(async () => {
    await app.start();
    console.log('Slack bot is running in Socket Mode.');
})();
