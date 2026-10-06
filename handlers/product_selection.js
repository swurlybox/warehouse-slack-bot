/* In-memory only, per Slack user -- holds the ranked candidate list shown
    after a "print the [product] from [shipment] shipment" request, until
    the user replies with a numeric selection. Same shape and TTL
    philosophy as print_confirmation.js's pendingRealPrints: doesn't
    survive a bot restart, and a new product-name request from the same
    user simply overwrites (silently cancels) any prior pending selection. */
const pendingProductSelections = new Map();
const PENDING_SELECTION_TIMEOUT_MS = 2 * 60 * 1000;

/* candidates is [{ sku, productName }], in the order they were shown
    (1-based position = array index + 1) -- isTest records which print
    handler the eventual selection should hand off to. */
function setPendingProductSelection(userId, { shipment, isTest, candidates }) {
    pendingProductSelections.set(userId, {
        shipment,
        isTest,
        candidates,
        expiresAt: Date.now() + PENDING_SELECTION_TIMEOUT_MS,
    });
}

/* Parses a numeric selection reply: one or more comma-separated entries,
    each a 1-based index into the shown candidate list, optionally
    followed by "x<N>" for a per-item quantity override (e.g. "1",
    "1, 3", "1 x5", "1x5, 3x2") -- the same x<N> syntax the SKU-quantity
    feature already uses elsewhere, so a user who's learned one syntax has
    learned both. Returns null if the text doesn't look like a selection
    at all (no entry matches the grammar), so the caller can tell "not a
    selection, fall through to normal routing" apart from "a selection,
    but an invalid one" -- which the caller reports directly, since
    validating the index range needs the candidate list length. */
function parseSelectionReply(text) {
    const entries = text.split(',').map((part) => part.trim()).filter(Boolean);
    if (entries.length === 0) {
        return null;
    }

    const parsed = [];
    for (const entry of entries) {
        const match = entry.match(/^(\d+)\s*x\s*(\d+)$/i) || entry.match(/^(\d+)$/);
        if (!match) {
            return null;
        }
        parsed.push({ index: Number(match[1]), quantity: match[2] !== undefined ? Number(match[2]) : undefined });
    }
    return parsed;
}

/* Checked before normal intent routing on every message, same as
    handlePendingPrintConfirmation. Returns true if this message was
    consumed as a selection reply (caller should stop routing), false
    otherwise (fall through to parseIntent as usual -- including when a
    pending selection existed but expired, or the message didn't parse as
    a selection at all).
    onSelect receives the resolved { shipment, isTest, items: [{sku,
    quantity?}] } and does the actual print handoff -- passed in by the
    caller (slack_bot.js) rather than required directly here, so this
    module doesn't need to require handlers/print_handlers.js (which
    would require this module back, for setPendingProductSelection). */
async function handlePendingProductSelection(text, userId, say, onSelect) {
    const pending = pendingProductSelections.get(userId);
    if (!pending) {
        return false;
    }

    if (Date.now() > pending.expiresAt) {
        pendingProductSelections.delete(userId);
        return false;
    }

    const parsedSelection = parseSelectionReply(text);
    if (!parsedSelection) {
        return false;
    }

    pendingProductSelections.delete(userId);

    const outOfRange = parsedSelection.filter(({ index }) => index < 1 || index > pending.candidates.length);
    if (outOfRange.length > 0) {
        await say(`<@${userId}> "${outOfRange.map((e) => e.index).join(', ')}" isn't on the list I showed (1-${pending.candidates.length}). Nothing selected -- send the product request again if you want another look.`);
        return true;
    }

    const items = parsedSelection.map(({ index, quantity }) => ({
        sku: pending.candidates[index - 1].sku,
        quantity,
    }));

    await onSelect({ shipment: pending.shipment, isTest: pending.isTest, items }, say, userId);
    return true;
}

module.exports = { setPendingProductSelection, handlePendingProductSelection };
