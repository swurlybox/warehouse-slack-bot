/**
 * @module handlers/status_pagination
 * In-memory cache + periodic sweep for paginated shipment-status Block Kit
 * messages, keyed by message identity rather than user.
 */

// Keyed by `channel:ts` (which message was clicked), not userId -- a
// button click carries no "who's replying" the way a chat reply does.
const pendingStatusPages = new Map();

// Longer than the other pending-state TTLs, and refreshed on every
// click: browsing is open-ended, not a one-shot reply.
const STATUS_PAGE_TIMEOUT_MS = 10 * 60 * 1000;

// Unlike the userId-keyed pending-state maps (naturally capped -- a new
// entry overwrites the old), every paginated reply gets a new key here,
// so a periodic sweep is needed to bound memory even for pages nobody
// ever clicks again.
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

function sweepExpiredStatusPages() {
    const now = Date.now();
    for (const [key, entry] of pendingStatusPages) {
        if (now > entry.expiresAt) {
            pendingStatusPages.delete(key);
        }
    }
}

setInterval(sweepExpiredStatusPages, SWEEP_INTERVAL_MS).unref();

function statusPageKey(channelId, messageTs) {
    return `${channelId}:${messageTs}`;
}

/**
 * Caches a paginated status message's full row list, keyed by message
 * identity.
 *
 * @param {string} channelId - Slack channel ID the message was posted in.
 * @param {string} messageTs - Slack message timestamp (its ID within the
 *   channel).
 * @param {object} data
 * @param {string} data.shipment - Shipment table name.
 * @param {string} data.userId - The requesting Slack user ID.
 * @param {Array<object>} data.rows - The full joined row list (every
 *   page's worth, not just one page).
 * @returns {void}
 */
function setStatusPageCache(channelId, messageTs, { shipment, userId, rows }) {
    pendingStatusPages.set(statusPageKey(channelId, messageTs), {
        shipment,
        userId,
        rows,
        expiresAt: Date.now() + STATUS_PAGE_TIMEOUT_MS,
    });
}

/**
 * Looks up a paginated status message's cached row list.
 *
 * @param {string} channelId - Slack channel ID the message was posted in.
 * @param {string} messageTs - Slack message timestamp (its ID within the
 *   channel).
 * @returns {{shipment: string, userId: string, rows: Array<object>,
 *   expiresAt: number} | null} The cached entry, or null on a miss or
 *   expired entry.
 */
function getStatusPageCache(channelId, messageTs) {
    const key = statusPageKey(channelId, messageTs);
    const entry = pendingStatusPages.get(key);
    if (!entry) {
        return null;
    }
    if (Date.now() > entry.expiresAt) {
        pendingStatusPages.delete(key);
        return null;
    }
    return entry;
}

module.exports = { setStatusPageCache, getStatusPageCache };
