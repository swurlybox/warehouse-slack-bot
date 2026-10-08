/**
 * @module handlers/product_selection
 * Pending-selection gate for a numeric reply to a shown product-name
 * candidate list.
 */

// Per-user, in-memory only, same shape/TTL philosophy as
// print_confirmation.js's pendingRealPrints.
const pendingProductSelections = new Map();
const PENDING_SELECTION_TIMEOUT_MS = 2 * 60 * 1000;

// Mirrors print_confirmation.js's cancel-word handling so a pending
// selection clears immediately, not after the TTL.
const SELECTION_CANCEL_WORDS = new Set([
    'no', 'n', 'cancel', 'stop', 'nevermind', 'abort',
]);

function tokenize(text) {
    return text.toLowerCase().match(/[a-z0-9]+/g) || [];
}

function isSelectionCancellation(text) {
    return tokenize(text).some((token) => SELECTION_CANCEL_WORDS.has(token));
}

/**
 * Registers a shown product candidate list awaiting a numeric selection
 * reply.
 *
 * @param {string} userId - Slack user ID the selection is pending from.
 * @param {object} selection
 * @param {string} selection.shipment - Shipment table name.
 * @param {boolean} selection.isTest - Whether this is a test print.
 * @param {Array<{sku: string, productName: string}>} selection.candidates -
 *   The candidates, in display order (1-based).
 * @returns {void}
 */
function setPendingProductSelection(userId, { shipment, isTest, candidates }) {
    pendingProductSelections.set(userId, {
        shipment,
        isTest,
        candidates,
        expiresAt: Date.now() + PENDING_SELECTION_TIMEOUT_MS,
    });
}

// Parses "1", "1, 3", "1 x5", "1x5, 3x2" (same x<N> quantity-override
// syntax used elsewhere). Returns null if nothing parses as a selection.
function parseSelectionReply(text) {
    const entries = text.split(',').map((part) => part.trim()).filter(Boolean);
    if (entries.length === 0) {
        return null;
    }

    const parsed = [];
    for (const entry of entries) {
        /* The part wrapped in (...) represents a capture group. */
        const match = entry.match(/^(\d+)\s*x\s*(\d+)$/i) ||
            entry.match(/^(\d+)$/);
        if (!match) {
            return null;
        }
        parsed.push({
            // match[1] and match[2] are the capture groups (...) in the regex.
            index: Number(match[1]), // The numbered option
            // the xN quantity, or undefined if not specified.
            quantity: match[2] !== undefined ? Number(match[2]) : undefined,
        });
    }
    return parsed;
}

/**
 * Checks an incoming message against a pending product selection for
 * this user, and acts (cancels, reports an out-of-range selection, or
 * hands off to `onSelect`) if it matches.
 *
 * @param {string} text - The incoming message text.
 * @param {string} userId - Slack user ID who sent it.
 * @param {Function} say - Slack reply function (
 *   {@link https://docs.slack.dev/tools/bolt-js/concepts/message-sending} 
 *   utility from Bolt).
 * @param {Function} onSelect - Called with `({shipment, isTest, items},
 *   say, userId)` once a valid selection resolves; passed in by the
 *   caller (slack_bot.js) to avoid a require cycle with
 *   handlers/print_handlers.js.
 * @returns {Promise<boolean>} True if the message was consumed
 *   (cancellation or a selection reply, valid or invalid); false
 *   otherwise, including when a pending selection expired.
 */
async function handlePendingProductSelection(text, userId, say, onSelect) {
    const pending = pendingProductSelections.get(userId);
    if (!pending) {
        return false;
    }

    if (Date.now() > pending.expiresAt) {
        pendingProductSelections.delete(userId);
        return false;
    }

    if (isSelectionCancellation(text)) {
        pendingProductSelections.delete(userId);
        await say(`<@${userId}> Cancelled -- nothing selected.`);
        return true;
    }

    const parsedSelection = parseSelectionReply(text);
    if (!parsedSelection) {
        return false;
    }

    pendingProductSelections.delete(userId);

    const outOfRange = parsedSelection.filter(({ index }) => {
        return index < 1 || index > pending.candidates.length;
    });
    if (outOfRange.length > 0) {
        const badIndexes = outOfRange.map((e) => e.index).join(', ');
        await say(
            `<@${userId}> "${badIndexes}" isn't on the list I showed ` +
            `(1-${pending.candidates.length}). Nothing selected -- send ` +
            `the product request again if you want another look.`
        );
        return true;
    }

    const items = parsedSelection.map(({ index, quantity }) => ({
        sku: pending.candidates[index - 1].sku,
        quantity,
    }));

    await onSelect(
        { shipment: pending.shipment, isTest: pending.isTest, items },
        say,
        userId
    );
    return true;
}

module.exports = { setPendingProductSelection, handlePendingProductSelection };
