const { submitPrintJob } = require('../print_service');

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

/* Registers a real print request awaiting confirmation -- called by
    print_handlers.js once a print/reprint request has been fully resolved.
    Callers pass only what's being printed; the pending-map and TTL
    bookkeeping stay private to this module. */
function setPendingPrint(userId, { shipment, items }) {
    pendingRealPrints.set(userId, {
        shipment,
        items,
        expiresAt: Date.now() + PENDING_PRINT_CONFIRM_TIMEOUT_MS,
    });
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

module.exports = { handlePendingPrintConfirmation, setPendingPrint };
