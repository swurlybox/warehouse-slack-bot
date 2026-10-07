/* In-memory only, keyed by `channel:ts` rather than Slack userId -- a
    Next/Previous button click's payload carries body.channel.id and
    body.message.ts (which message is this?), not a pending-state owner the
    way a typed reply carries userId (who's replying?). Same Map +
    lazy-expiry shape as print_confirmation.js / product_selection.js's
    pending-state pattern otherwise, just with that different key and no
    true/false-consumed contract -- a button click isn't competing with
    normal message routing the way a chat reply is, so the caller needs the
    actual cached payload back, not a yes/no.
    Caches the full joined row list (every page's worth, plus the shipment
    name and the requesting userId for re-rendering the same header on every
    page) so a Prev/Next click never re-queries Airtable -- only the first
    render does. */
const pendingStatusPages = new Map();

/* Longer than the 2-minute TTL on the other two pending-state features:
    those gate a one-shot, consequential reply (confirm a real print, pick a
    SKU) expected to happen right away. Paginated browsing is read-only and
    open-ended -- someone might page through several screens of a 50-SKU
    shipment while also doing something else in Slack -- so expiring it on
    that same aggressive clock would make the feature annoying rather than
    safe. Refreshed on every click (see getStatusPageCache) rather than
    fixed from first post, so an actively-browsed view doesn't expire
    mid-session; only a view nobody touches for 10 minutes goes stale. */
const STATUS_PAGE_TIMEOUT_MS = 10 * 60 * 1000;

/* Unlike print_confirmation.js/product_selection.js (keyed by userId, where
    a new pending entry from the same user overwrites their old one, so
    those maps are naturally capped at "number of distinct users with
    something pending"), this map is keyed by message identity -- every
    multi-page status reply creates a brand-new key that's never reused.
    Lazy expiry alone (deleting an entry only when it's read again) isn't
    enough here: a page most users read once and never click again has no
    later read to trigger that deletion, so it would otherwise sit in
    memory for the life of the process. This interval sweep deletes
    anything past its expiresAt on a fixed schedule, independent of whether
    it's ever looked up again, so memory stays bounded by "entries created
    in roughly the last TTL window" rather than "every paginated reply ever
    sent." unref() keeps this timer from holding the process open (e.g.
    during tests that import this module without ever calling app.start()). */
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

/* Called once, right after the first page is posted -- and again by the
    action handler after every successful page render, to slide the TTL
    forward. `rows` is the full joined list (every page's worth), not just
    the page currently shown. */
function setStatusPageCache(channelId, messageTs, { shipment, userId, rows }) {
    pendingStatusPages.set(statusPageKey(channelId, messageTs), {
        shipment,
        userId,
        rows,
        expiresAt: Date.now() + STATUS_PAGE_TIMEOUT_MS,
    });
}

/* Returns the cached payload, or null on a miss or an expired entry
    (deleting it lazily, same as the other two pending-state modules) --
    the action handler uses a single falsy check to tell "re-render" apart
    from "tell the user this view expired." */
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
