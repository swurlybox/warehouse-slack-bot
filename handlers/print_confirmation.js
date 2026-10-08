/**
 * @module handlers/print_confirmation
 * Pending-confirmation gate for a real (physical) print request, awaiting
 * a "confirm"/"cancel" reply from the same user.
 */
const { submitPrintJob } = require('../print_service');

// Per-user, in-memory only (lost on restart); a new print request from
// the same user silently overwrites any prior pending one.
const pendingRealPrints = new Map();
const PENDING_PRINT_CONFIRM_TIMEOUT_MS = 2 * 60 * 1000;

// Confirmation requires "print" + a confirm word together, since a bare
// "yes" is common in ordinary chat; cancelling has no such risk.
const PRINT_CONFIRM_WORDS = new Set(['confirm', 'yes', 'go', 'proceed', 'y']);
const PRINT_CANCEL_WORDS = new Set([
    'no', 'n', 'cancel', 'stop', 'nevermind', 'abort',
]);

function tokenizeForConfirmation(text) {
    return text.toLowerCase().match(/[a-z0-9]+/g) || [];
}

function isPrintConfirmation(tokens) {
    return tokens.includes('print') &&
        tokens.some((token) => PRINT_CONFIRM_WORDS.has(token));
}

function isPrintCancellation(tokens) {
    return tokens.some((token) => PRINT_CANCEL_WORDS.has(token));
}

/**
 * Registers a real print request awaiting confirmation.
 *
 * @param {string} userId - Slack user ID the confirmation is pending from.
 * @param {{shipment: string, items: Array<{sku: string, quantity: number}>}}
 *   request - What to print.
 * @returns {void}
 */
function setPendingPrint(userId, { shipment, items }) {
    pendingRealPrints.set(userId, {
        shipment,
        items,
        expiresAt: Date.now() + PENDING_PRINT_CONFIRM_TIMEOUT_MS,
    });
}

/**
 * Checks an incoming message against a pending print confirmation for
 * this user, and acts (submits or cancels the print job) if it matches.
 *
 * @param {string} text - The incoming message text.
 * @param {string} userId - Slack user ID who sent it.
 * @param {Function} say - Slack reply function (
 *   {@link https://docs.slack.dev/tools/bolt-js/concepts/message-sending}
 *   utility from Bolt).
 * @returns {Promise<boolean>} True if the message was consumed as a
 *   confirm/cancel reply (caller should stop routing); false otherwise,
 *   including when a pending confirmation expired.
 */
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
            await say(
                `<@${userId}> Print job sent for "${pending.shipment}" ` +
                `(${pending.items.length} SKU(s)).`
            );
        } catch (error) {
            console.error('Print job failed:', error.message);
            await say(
                `<@${userId}> Sorry, the print job failed: ${error.message}`
            );
        }
        return true;
    }

    return false;
}

module.exports = { handlePendingPrintConfirmation, setPendingPrint };
