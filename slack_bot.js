require('dotenv').config();
const { App } = require('@slack/bolt');
const { fetchRemainingLabelsForTable, fetchLabelsBySkuForTable } = require('./fetch_remaining_labels');
const { parseIntent, extractShipmentId } = require('./intent_parser');
const { submitPrintJob, submitTestPrintJob } = require('./print_service');
const { findShipmentTable, isAllShipmentsQuery, fetchRemainingLabelsForAllShipments, SKU_TOKEN_PATTERN } = require('./shipment_lookup');

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN;

if (!SLACK_BOT_TOKEN || !SLACK_APP_TOKEN) {
    console.error('Missing SLACK_BOT_TOKEN or SLACK_APP_TOKEN. Set them in .env (see .env.example).');
    process.exit(1);
}

const EXAMPLE_USAGE = 'Try something like: "print remaining labels for the august 21 shipment"';

const HELP_TEXT = [
    "Here's what I can do:",
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

/* Resolves which shipment table a print/query command should target: an
    explicitly named shipment (e.g. "for the august 21 shipment") wins; an
    empty query, an unmatched name, or a name that matches multiple tables is
    reported back to the caller to handle -- callers should not print against
    an ambiguous or unresolved shipment. There is deliberately no default
    shipment: a table like "Next Shipment" gets renamed to a dated name as
    part of the team's normal Airtable workflow, so relying on a fixed
    fallback name broke unpredictably whenever that happened.
    shipmentRef may be the raw message text (rule-based path, which relies on
    findShipmentTable's own stopword-stripping to pull the name out of it) or
    a clean phrase (LLM path) -- either shape works since findShipmentTable
    tokenizes and matches on leftover words either way. May be undefined
    (the LLM path can omit shipment_ref entirely), which resolves the same
    way an empty query already does: 'not_found'. */
async function resolveShipmentTableName(shipmentRef) {
    const result = await findShipmentTable(shipmentRef || '');

    if (result.status === 'ok') {
        return { status: 'ok', tableName: result.table.name };
    }
    return result;
}

/* Resolves the shipment a print/test-print command names (or defaults to)
    and fetches its remaining-label rows, folding every failure mode -- an
    unsupported "all shipments" request, an Airtable lookup error, an
    unresolved/ambiguous name, or a fetch error -- into one result shape so
    both print handlers below can share the same error reporting instead of
    duplicating it. Takes a structured { shipmentRef } object rather than raw
    text so both the rule-based and LLM-based intent parsers can call it
    identically. */
async function resolveShipmentAndFetchRemaining({ shipmentRef }) {
    if (isAllShipmentsQuery(shipmentRef || '')) {
        return { status: 'all_not_supported' };
    }

    const resolved = await resolveShipmentTableName(shipmentRef).catch((error) => {
        console.error('Failed to look up shipment tables:', error.message);
        return { status: 'error', message: error.message };
    });

    if (resolved.status !== 'ok') {
        return resolved;
    }

    try {
        const payload = await fetchRemainingLabelsForTable(resolved.tableName);
        return { status: 'ok', shipment: payload.shipment, items: payload.items };
    } catch (error) {
        console.error('Failed to fetch remaining labels:', error.message);
        return { status: 'error', message: error.message };
    }
}

/* Reports a non-'ok' resolveShipmentAndFetchRemaining result to the user.
    Returns true if it did (caller should stop), false if the result was
    'ok' (caller should proceed). exampleCommand lets the print and
    test-print handlers each point at their own correct example phrasing. */
async function sayShipmentResolutionError(result, say, userId, exampleCommand) {
    if (result.status === 'all_not_supported') {
        await say(`<@${userId}> Printing for all shipments at once isn't supported -- please name one shipment, e.g. "${exampleCommand}".`);
        return true;
    }
    if (result.status === 'error') {
        await say(`<@${userId}> Sorry, I couldn't look up shipment tables: ${result.message}`);
        return true;
    }
    if (result.status === 'not_found') {
        await say(`<@${userId}> I couldn't tell which shipment you meant. Try naming it, e.g. "${exampleCommand}".`);
        return true;
    }
    if (result.status === 'ambiguous') {
        const names = result.matches.map((table) => `"${table.name}"`).join(', ');
        await say(`<@${userId}> That matches more than one shipment: ${names}. Can you be more specific?`);
        return true;
    }
    return false;
}

/* Resolves a "print sku(s) ... from ... shipment" request: takes the
    already-extracted SKU list and shipment reference (either parser's
    output -- see intent_parser.js), resolves the shipment the same way every
    other command does, then looks up each named SKU directly (bypassing the
    remaining-labels filter on purpose -- see fetchLabelsBySkuForTable). Any
    SKU not found in the resolved table blocks the whole request rather than
    silently printing a partial list, since a mistyped SKU in a targeted
    reprint is exactly the kind of thing that shouldn't fail quietly.
    Re-validates skus against SKU_TOKEN_PATTERN here (not just trusting the
    rule-based path's own parseSkuPrintCommand filter) since the LLM path's
    extracted skus reach this function without ever passing through that
    regex -- this is what actually stops a malformed SKU from an arbitrarily-
    phrased message breaking out of fetchLabelsBySkuForTable's formula
    string, regardless of which parser produced it. */
async function resolveSkuPrintRequest({ skus, shipmentRef }) {
    const validSkus = (skus || []).filter((sku) => SKU_TOKEN_PATTERN.test(sku));
    if (validSkus.length === 0 || !shipmentRef) {
        return { status: 'parse_error' };
    }

    const resolved = await resolveShipmentTableName(shipmentRef).catch((error) => {
        console.error('Failed to look up shipment tables:', error.message);
        return { status: 'error', message: error.message };
    });

    if (resolved.status !== 'ok') {
        return resolved;
    }

    let payload;
    try {
        payload = await fetchLabelsBySkuForTable(resolved.tableName, validSkus);
    } catch (error) {
        console.error('Failed to fetch labels by SKU:', error.message);
        return { status: 'error', message: error.message };
    }

    const notFound = payload.results.filter((r) => r.notFound).map((r) => r.sku);
    if (notFound.length > 0) {
        return { status: 'sku_not_found', shipment: payload.shipment, notFound };
    }

    return { status: 'ok', shipment: payload.shipment, items: payload.results };
}

/* Reports resolveSkuPrintRequest's SKU-specific failure modes; falls through
    to sayShipmentResolutionError for the shipment-resolution failures they
    share with every other command. Same true/false contract as that
    function. */
async function saySkuResolutionError(result, say, userId, exampleCommand) {
    if (result.status === 'parse_error') {
        await say(`<@${userId}> I couldn't tell which SKUs or shipment you meant. Try something like "${exampleCommand}".`);
        return true;
    }
    if (result.status === 'sku_not_found') {
        const skus = result.notFound.map((sku) => `"${sku}"`).join(', ');
        await say(`<@${userId}> Couldn't find ${skus} in "${result.shipment}". Check the SKU(s) and try again.`);
        return true;
    }
    return sayShipmentResolutionError(result, say, userId, exampleCommand);
}

/* Renders the reprint-safety flags (already printed / not checked in) that
    make a targeted SKU reprint visibly different from a normal remaining-
    labels print -- both flags show together when a SKU matches both, since
    they're independent facts about the row. */
function formatSkuFlags(item) {
    const flags = [];
    if (item.alreadyPrinted) flags.push('already printed');
    if (item.notCheckedIn) flags.push('not checked in');
    return flags.length ? `  ⚠ ${flags.join(', ')}` : '';
}

/* Downloads label PDFs for the named (or default) shipment without ever
    sending them to a physical printer -- safe to run without confirmation,
    unlike handlePrintRemainingLabels below. */
async function handleTestPrintRemainingLabels({ shipmentRef }, say, userId) {
    const result = await resolveShipmentAndFetchRemaining({ shipmentRef });
    if (await sayShipmentResolutionError(result, say, userId, 'test print remaining labels for the august 21 shipment')) {
        return;
    }

    if (result.items.length === 0) {
        await say(`<@${userId}> No remaining labels to test-print for "${result.shipment}" -- everything's already printed.`);
        return;
    }

    const lines = result.items.map((item) => `• ${item.sku} — ${item.quantity}`).join('\n');
    await say(`<@${userId}> [Test print -- nothing physical] Found ${result.items.length} SKU(s) still needing labels for "${result.shipment}":\n${lines}`);

    try {
        await submitTestPrintJob(result.items);
        await say(`<@${userId}> Test print finished for "${result.shipment}" (${result.items.length} SKU(s)) -- labels were downloaded, not sent to the printer.`);
    } catch (error) {
        console.error('Test print job failed:', error.message);
        await say(`<@${userId}> Sorry, the test print job failed: ${error.message}`);
    }
}

/* In-memory only, per Slack user -- a real print request is held here
    awaiting confirmation instead of firing immediately. Deliberately does
    not survive a bot restart, and a new print request from the same user
    simply overwrites (silently cancels) any prior pending one; for a single
    warehouse operator that's an acceptable simplification. */
const pendingRealPrints = new Map();
const PENDING_PRINT_CONFIRM_TIMEOUT_MS = 2 * 60 * 1000;

/* Confirmation requires both "print" and a confirm word together (not just
    "yes" or "go" alone) -- this bot reacts to plain, unmentioned channel
    messages for its other commands too, and a bare "yes" is common enough in
    ordinary chat that requiring it alone here would risk firing a real,
    unrecoverable print job by accident. Cancelling has no such downside, so
    it stays a single-word match. */
const PRINT_CONFIRM_WORDS = new Set(['confirm', 'yes', 'go', 'proceed', 'y']);
const PRINT_CANCEL_WORDS = new Set(['no', 'n', 'cancel', 'stop', 'nevermind', 'abort']);

function tokenizeForConfirmation(text) {
    return text.toLowerCase().match(/[a-z0-9]+/g) || [];
}

function isPrintConfirmation(tokens) {
    return tokens.includes('print') && tokens.some((token) => PRINT_CONFIRM_WORDS.has(token));
}

function isPrintCancellation(tokens) {
    return tokens.some((token) => PRINT_CANCEL_WORDS.has(token));
}

/* Checked before normal intent routing on every message. Returns true if
    this message was consumed as a reply to a pending confirmation (caller
    should stop routing), false otherwise (caller should fall through to
    parseIntent as usual -- including when a pending confirmation existed but
    expired, or the message didn't look like a confirm/cancel). */
async function handlePendingPrintConfirmation(text, userId, say) {
    const pending = pendingRealPrints.get(userId);
    if (!pending) {
        return false;
    }

    if (Date.now() > pending.expiresAt) {
        pendingRealPrints.delete(userId);
        return false;
    }

    const tokens = tokenizeForConfirmation(text);

    if (isPrintCancellation(tokens)) {
        pendingRealPrints.delete(userId);
        await say(`<@${userId}> Cancelled -- nothing was sent to the printer.`);
        return true;
    }

    if (isPrintConfirmation(tokens)) {
        pendingRealPrints.delete(userId);
        try {
            await submitPrintJob(pending.items);
            await say(`<@${userId}> Print job sent for "${pending.shipment}" (${pending.items.length} SKU(s)).`);
        } catch (error) {
            console.error('Print job failed:', error.message);
            await say(`<@${userId}> Sorry, the print job failed: ${error.message}`);
        }
        return true;
    }

    return false;
}

/* Fetches the named shipment's unprinted-label rows from Airtable, then asks
    the user to confirm before sending them to the RPi print server's real
    /print route -- unlike the dry run, this sends labels to a physical
    printer and can't be undone.
    The eventual success/failure reply only reports the SKU count, not the
    print server's own response body, which is that automation's internal
    output and free to change shape independently of this bot. */
async function handlePrintRemainingLabels({ shipmentRef }, say, userId) {
    const result = await resolveShipmentAndFetchRemaining({ shipmentRef });
    if (await sayShipmentResolutionError(result, say, userId, 'print remaining labels for the august 21 shipment')) {
        return;
    }

    if (result.items.length === 0) {
        await say(`<@${userId}> No remaining labels to print for "${result.shipment}" -- everything's already printed.`);
        return;
    }

    pendingRealPrints.set(userId, {
        shipment: result.shipment,
        items: result.items,
        expiresAt: Date.now() + PENDING_PRINT_CONFIRM_TIMEOUT_MS,
    });

    const lines = result.items.map((item) => `• ${item.sku} — ${item.quantity}`).join('\n');
    await say(`<@${userId}> This will send ${result.items.length} SKU(s) to the *physical printer* for "${result.shipment}":\n${lines}\nReply *confirm print* to proceed, or *cancel* to stand down (expires in 2 minutes).`);
}

/* Downloads label PDFs for specific, named SKUs within a shipment -- a
    targeted reprint tool, so unlike handleTestPrintRemainingLabels this
    intentionally bypasses the unprinted/checked-in filter (see
    fetchLabelsBySkuForTable) and flags any SKU found outside it. Safe to run
    without confirmation, same as the other test-print command. */
async function handleTestPrintSpecificSkus({ skus, shipmentRef }, say, userId) {
    const result = await resolveSkuPrintRequest({ skus, shipmentRef });
    const exampleCommand = 'test print sku B08ABC123 from the august 21 shipment';
    if (await saySkuResolutionError(result, say, userId, exampleCommand)) {
        return;
    }

    const lines = result.items.map((item) => `• ${item.sku} — ${item.quantity}${formatSkuFlags(item)}`).join('\n');
    await say(`<@${userId}> [Test print -- nothing physical] Found ${result.items.length} SKU(s) for "${result.shipment}":\n${lines}`);

    try {
        await submitTestPrintJob(result.items.map(({ sku, quantity }) => ({ sku, quantity })));
        await say(`<@${userId}> Test print finished for "${result.shipment}" (${result.items.length} SKU(s)) -- labels were downloaded, not sent to the printer.`);
    } catch (error) {
        console.error('Test print job failed:', error.message);
        await say(`<@${userId}> Sorry, the test print job failed: ${error.message}`);
    }
}

/* Same targeted-reprint lookup as handleTestPrintSpecificSkus, but asks for
    confirmation before sending to the physical printer -- any SKU flagged as
    already printed or not checked in is called out in the confirmation
    message so the user knowingly signs off on the reprint, not just the SKU
    list and quantities. */
async function handlePrintSpecificSkus({ skus, shipmentRef }, say, userId) {
    const result = await resolveSkuPrintRequest({ skus, shipmentRef });
    const exampleCommand = 'print sku B08ABC123 from the august 21 shipment';
    if (await saySkuResolutionError(result, say, userId, exampleCommand)) {
        return;
    }

    pendingRealPrints.set(userId, {
        shipment: result.shipment,
        items: result.items.map(({ sku, quantity }) => ({ sku, quantity })),
        expiresAt: Date.now() + PENDING_PRINT_CONFIRM_TIMEOUT_MS,
    });

    const lines = result.items.map((item) => `• ${item.sku} — ${item.quantity}${formatSkuFlags(item)}`).join('\n');
    await say(`<@${userId}> This will send ${result.items.length} SKU(s) to the *physical printer* for "${result.shipment}":\n${lines}\nReply *confirm print* to proceed, or *cancel* to stand down (expires in 2 minutes).`);
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
async function handleQueryShipmentStatus({ shipmentRef }, say, userId) {
    if (isAllShipmentsQuery(shipmentRef || '')) {
        await handleQueryAllShipmentsStatus(say, userId);
        return;
    }

    /* Shares resolveShipmentAndFetchRemaining with the print handlers so this
        command's error handling (ambiguous name, lookup failure, no name
        given) stays identical to theirs instead of duplicating it. */
    const result = await resolveShipmentAndFetchRemaining({ shipmentRef });
    if (await sayShipmentResolutionError(result, say, userId, 'check status of the august 21 shipment')) {
        return;
    }

    if (result.items.length === 0) {
        await say(`<@${userId}> "${result.shipment}" has no remaining labels to print -- everything's already printed.`);
        return;
    }

    const lines = result.items.map((item) => `• ${item.sku} — ${item.quantity}`).join('\n');
    await say(`<@${userId}> "${result.shipment}" has ${result.items.length} SKU(s) still needing labels:\n${lines}`);
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
