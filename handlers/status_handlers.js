/**
 * @module handlers/status_handlers
 * Status command handlers: single-shipment paginated status (remaining +
 * not-checked-in rows, with product name/image) and the all-shipments
 * overview.
 */
const {
    isAllShipmentsQuery,
    fetchRemainingLabelsForAllShipments,
} = require('../airtable/shipment_lookup');
const {
    fetchNotCheckedInForTable,
    fetchProductNamesForTable,
    describeAirtableError,
} = require('../airtable/fetch_remaining_labels');
const { setStatusPageCache } = require('./status_pagination');
// Shares print_handlers.js's shipment resolution + error-reporting
// helpers rather than duplicating them.
const {
    resolveShipmentAndFetchRemaining,
    sayShipmentResolutionError,
    sayDisambiguationNoteIfAny,
} = require('./print_handlers');

// Small enough to avoid a wall of images per page, large enough that a
// ~50-SKU shipment isn't tedious to click through; comfortably under
// Slack's 50-block-per-message limit.
const STATUS_PAGE_SIZE = 8;

// "Unknown product"/no accessory is the deliberate fallback when a row
// has no product-name lookup at all.
function formatStatusRowText(row) {
    const nameLine = `*${row.sku}* — ${row.productName || 'Unknown product'}`;
    const detailLine = row.reason === 'remaining'
        ? `   Qty *${row.quantity}* · remaining to print`
        : '   Not checked in yet';
    return `${nameLine}\n${detailLine}`;
}

function buildStatusRowBlock(row) {
    const block = {
        type: 'section',
        text: { type: 'mrkdwn', text: formatStatusRowText(row) },
    };
    if (row.imageUrl) {
        block.accessory = {
            type: 'image',
            image_url: row.imageUrl,
            alt_text: (row.productName || row.sku).slice(0, 2000),
        };
    }
    return block;
}

/**
 * Renders one page of a shipment's "needs attention" rows as Block Kit,
 * with Next/Previous buttons when there's more than one page. Shared by
 * the first render and every subsequent button click (slack_bot.js's
 * status_page_nav handler), so both always render identically.
 *
 * @param {object} args
 * @param {string} args.shipment - Shipment table name.
 * @param {string} args.userId - Slack user ID to mention in the header.
 * @param {Array<object>} args.rows - The full joined row list (every
 *   page's worth).
 * @param {number} args.page - Zero-based page index to render.
 * @param {number} args.totalPages - Total page count.
 * @returns {{text: string, blocks: Array<object>}} A ({@link
 *   https://api.slack.com/block-kit|Slack Block Kit}) payload.
 */
function buildStatusPageBlocks({ shipment, userId, rows, page, totalPages }) {
    const start = page * STATUS_PAGE_SIZE;
    const pageRows = rows.slice(start, start + STATUS_PAGE_SIZE);

    const text = (
        `<@${userId}> "${shipment}" -- ${rows.length} SKU(s) need ` +
        `attention (page ${page + 1}/${totalPages})`
    );

    const blocks = [
        { type: 'section', text: { type: 'mrkdwn', text: `${text}:` } },
        { type: 'divider' },
        ...pageRows.map(buildStatusRowBlock),
        { type: 'divider' },
        {
            type: 'context',
            elements: [
                { type: 'mrkdwn', text: `Page ${page + 1} of ${totalPages}` },
            ],
        },
    ];

    if (totalPages > 1) {
        const elements = [];
        if (page > 0) {
            elements.push({
                type: 'button',
                text: { type: 'plain_text', text: '◀ Previous' },
                action_id: 'status_page_nav',
                value: String(page - 1),
            });
        }
        if (page < totalPages - 1) {
            elements.push({
                type: 'button',
                text: { type: 'plain_text', text: 'Next ▶' },
                action_id: 'status_page_nav',
                value: String(page + 1),
            });
        }
        blocks.push({ type: 'actions', elements });
    }

    return { text, blocks };
}

// Reports remaining/not-checked-in counts across every shipment table;
// only shipments needing attention (or that failed to read) are listed
// individually, the rest just counted as fully printed.
async function handleQueryAllShipmentsStatus(say, userId) {
    let results;
    try {
        results = await fetchRemainingLabelsForAllShipments();
    } catch (error) {
        console.error('Failed to look up shipment tables:', error.message);
        await say(
            `<@${userId}> Sorry, I couldn't look up shipment ` +
            `tables: ${error.message}`
        );
        return;
    }

    const withRemaining = results.filter((r) => !r.error && r.items.length > 0);
    // Not mutually exclusive with withRemaining -- a shipment can need
    // both at once, and can legitimately appear in both lists below.
    const withNotCheckedIn = results.filter((r) => {
        return !r.error && r.notCheckedInCount > 0;
    });
    const fullyPrinted = results.filter((r) => {
        return !r.error && r.items.length === 0 && !r.notCheckedInCount;
    });
    const failed = results.filter((r) => r.error);

    const nothingToReport = withRemaining.length === 0 &&
        withNotCheckedIn.length === 0 &&
        failed.length === 0;
    if (nothingToReport) {
        await say(
            `<@${userId}> Checked ${results.length} shipment(s) -- all ` +
            `fully printed, nothing remaining anywhere.`
        );
        return;
    }

    const lines = [
        ...withRemaining.map((r) => {
            return `• "${r.shipment}" -- ${r.items.length} SKU(s) remaining`;
        }),
        ...withNotCheckedIn.map((r) => {
            return (
                `• "${r.shipment}" -- ${r.notCheckedInCount} SKU(s) ` +
                `not checked in`
            );
        }),
        ...failed.map((r) => `• "${r.shipment}" -- couldn't read (${r.error})`),
    ];

    const summary = (
        `Checked ${results.length} shipment(s): ${withRemaining.length} ` +
        `with remaining labels, ${withNotCheckedIn.length} with SKUs ` +
        `not checked in, ${fullyPrinted.length} fully printed` +
        (failed.length ? `, ${failed.length} failed to read` : '') + '.'
    );

    await say(`<@${userId}> ${summary}\n${lines.join('\n')}`);
}

/**
 * Looks up a shipment by name and reports its remaining-to-print and
 * not-checked-in SKUs as a paginated Block Kit message (or a plain-text
 * reply when there's nothing to page through). Read-only, so unlike the
 * print handlers this isn't gated by isAuthorized.
 *
 * @param {{shipmentRef: string}} args - The shipment reference from
 *   intent parsing.
 * @param {Function} say - Slack reply function ({@link
 *   https://api.slack.com/methods/chat.postMessage|chat.postMessage}
 *   wrapper from Bolt).
 * @param {string} userId - Slack user ID who asked.
 * @returns {Promise<void>}
 */
async function handleQueryShipmentStatus({ shipmentRef }, say, userId) {
    if (isAllShipmentsQuery(shipmentRef || '')) {
        await handleQueryAllShipmentsStatus(say, userId);
        return;
    }

    const result = await resolveShipmentAndFetchRemaining({ shipmentRef });
    const exampleCommand = 'check status of the august 21 shipment';
    if (await sayShipmentResolutionError(result, say, userId, exampleCommand)) {
        return;
    }
    await sayDisambiguationNoteIfAny(result, say, userId);

    const remainingRows = result.items.map((item) => ({
        sku: item.sku,
        quantity: item.quantity,
        reason: 'remaining',
        productName: null,
        imageUrl: null,
    }));

    // Queried separately rather than folded into
    // resolveShipmentAndFetchRemaining, so the print handlers that share
    // that function don't pay for a query they never display.
    let notCheckedIn;
    try {
        notCheckedIn = await fetchNotCheckedInForTable(result.shipment);
    } catch (error) {
        console.error('Failed to fetch not-checked-in SKUs:', error.message);
        notCheckedIn = {
            items: null,
            unsupported: false,
            error: describeAirtableError(error),
        };
    }

    const preambleNotes = [];
    if (notCheckedIn.unsupported) {
        preambleNotes.push(
            `Can't check not-checked-in status for "${result.shipment}" ` +
            `-- this table doesn't track "Checked In".`
        );
    } else if (notCheckedIn.error) {
        preambleNotes.push(
            `Couldn't check not-checked-in SKUs: ${notCheckedIn.error}`
        );
    }

    const notCheckedInRows = (notCheckedIn.items || []).map((item) => ({
        sku: item.sku,
        quantity: null,
        reason: 'not_checked_in',
        productName: null,
        imageUrl: null,
    }));

    if (remainingRows.length === 0 && notCheckedInRows.length === 0) {
        preambleNotes.unshift(
            `"${result.shipment}" has no remaining labels to print -- ` +
            `everything's already printed.`
        );
        await say(`<@${userId}> ${preambleNotes.join('\n\n')}`);
        return;
    }

    // Distinct wording from the fully-printed case above: these SKUs
    // were never checked in, so nothing's ready to print, not nothing
    // left to print.
    if (remainingRows.length === 0) {
        preambleNotes.unshift(
            `"${result.shipment}" has no remaining labels to print yet ` +
            `-- nothing's been checked in.`
        );
    }

    if (preambleNotes.length > 0) {
        await say(`<@${userId}> ${preambleNotes.join('\n\n')}`);
    }

    let rows = [...remainingRows, ...notCheckedInRows];

    // Enrichment, not a requirement -- a failure here (e.g. missing
    // product-name field) still lets rows render with just SKU/status.
    try {
        const namesPayload = await fetchProductNamesForTable(result.shipment);
        const bySku = new Map(
            namesPayload.items.map((item) => [item.sku.toUpperCase(), item])
        );
        rows = rows.map((row) => {
            const match = bySku.get(row.sku.toUpperCase());
            return match
                ? {
                    ...row,
                    productName: match.productName,
                    imageUrl: match.imageUrl,
                }
                : row;
        });
    } catch (error) {
        console.error(
            'Failed to fetch product names/images for status enrichment:',
            error.message
        );
    }

    const totalPages = Math.ceil(rows.length / STATUS_PAGE_SIZE);
    const { text, blocks } = buildStatusPageBlocks({
        shipment: result.shipment,
        userId,
        rows,
        page: 0,
        totalPages,
    });
    const posted = await say({ text, blocks });

    if (totalPages > 1) {
        setStatusPageCache(posted.channel, posted.ts, {
            shipment: result.shipment,
            userId,
            rows,
        });
    }
}

module.exports = {
    handleQueryShipmentStatus,
    buildStatusPageBlocks,
    STATUS_PAGE_SIZE,
};
