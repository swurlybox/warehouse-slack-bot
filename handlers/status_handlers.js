const { isAllShipmentsQuery, fetchRemainingLabelsForAllShipments } = require('../airtable/shipment_lookup');
const { fetchNotCheckedInForTable, fetchProductNamesForTable, describeAirtableError } = require('../airtable/fetch_remaining_labels');
const { setStatusPageCache } = require('./status_pagination');
/* Reuses print_handlers.js's shipment resolution + error-reporting helpers
    rather than duplicating them -- status and print commands share the same
    "which shipment, what's remaining" logic, they just do different things
    with the result. */
const { resolveShipmentAndFetchRemaining, sayShipmentResolutionError, sayDisambiguationNoteIfAny } = require('./print_handlers');

/* Rows per paginated status page -- small enough that a page (even with a
    thumbnail per row) doesn't itself become the wall of text/images this
    feature exists to avoid, large enough that a ~50-SKU shipment doesn't
    turn into tedious clicking. Also well under Slack's 50-block-per-message
    ceiling once header/divider/footer/button overhead is added. */
const STATUS_PAGE_SIZE = 8;

/* "Unknown product"/no accessory is the deliberate fallback when a row's
    product-name lookup is empty or the table has no such field at all
    (see the enrichment try/catch in handleQueryShipmentStatus below) --
    the row still renders with its SKU and status, it just can't show a
    name or image it doesn't have. */
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
        block.accessory = { type: 'image', image_url: row.imageUrl, alt_text: (row.productName || row.sku).slice(0, 2000) };
    }
    return block;
}

/* Renders one page of a shipment's "needs attention" rows (remaining-to-print
    + not-checked-in, already joined with product name/image where
    available -- see handleQueryShipmentStatus) as Block Kit, with
    Next/Previous buttons when there's more than one page. Shared by the
    first render below and every subsequent button click in slack_bot.js's
    status_page_nav handler, so the two call sites can never render
    differently -- both just need `rows` (the full joined list) and a page
    number, not a fresh Airtable fetch. */
function buildStatusPageBlocks({ shipment, userId, rows, page, totalPages }) {
    const start = page * STATUS_PAGE_SIZE;
    const pageRows = rows.slice(start, start + STATUS_PAGE_SIZE);

    const text = `<@${userId}> "${shipment}" -- ${rows.length} SKU(s) need attention (page ${page + 1}/${totalPages})`;

    const blocks = [
        { type: 'section', text: { type: 'mrkdwn', text: `${text}:` } },
        { type: 'divider' },
        ...pageRows.map(buildStatusRowBlock),
        { type: 'divider' },
        { type: 'context', elements: [{ type: 'mrkdwn', text: `Page ${page + 1} of ${totalPages}` }] },
    ];

    if (totalPages > 1) {
        const elements = [];
        if (page > 0) {
            elements.push({ type: 'button', text: { type: 'plain_text', text: '◀ Previous' }, action_id: 'status_page_nav', value: String(page - 1) });
        }
        if (page < totalPages - 1) {
            elements.push({ type: 'button', text: { type: 'plain_text', text: 'Next ▶' }, action_id: 'status_page_nav', value: String(page + 1) });
        }
        blocks.push({ type: 'actions', elements });
    }

    return { text, blocks };
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
    /* hasAnyCheckedIn === false is a confirmed "nothing checked in yet";
        null (schema-drift table, or the check itself failed) is unknown,
        not a confirmed negative, so it's left out of this bucket and
        counted as fully printed below instead -- same as before this
        flag existed. */
    const notCheckedInAtAll = results.filter((r) => !r.error && r.items.length === 0 && r.hasAnyCheckedIn === false);
    const fullyPrinted = results.filter((r) => !r.error && r.items.length === 0 && r.hasAnyCheckedIn !== false);
    const failed = results.filter((r) => r.error);

    if (withRemaining.length === 0 && notCheckedInAtAll.length === 0 && failed.length === 0) {
        await say(`<@${userId}> Checked ${results.length} shipment(s) -- all fully printed, nothing remaining anywhere.`);
        return;
    }

    const lines = [
        ...withRemaining.map((r) => `• "${r.shipment}" -- ${r.items.length} SKU(s) remaining`),
        ...notCheckedInAtAll.map((r) => `• "${r.shipment}" -- nothing checked in yet`),
        ...failed.map((r) => `• "${r.shipment}" -- couldn't read (${r.error})`),
    ];

    const summary = `Checked ${results.length} shipment(s): ${withRemaining.length} with remaining labels, ${notCheckedInAtAll.length} not checked in at all, ${fullyPrinted.length} fully printed` +
        (failed.length ? `, ${failed.length} failed to read` : '') + '.';

    await say(`<@${userId}> ${summary}\n${lines.join('\n')}`);
}

/* Looks up a shipment by name (fuzzy-matched against Airtable table names,
    e.g. "august 21" -> "August 21 Shipment") and reports its remaining
    unprinted labels. Read-only -- no print job is triggered -- so unlike the
    print handlers this isn't gated by isAuthorized. */
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
    await sayDisambiguationNoteIfAny(result, say, userId);

    const remainingRows = result.items.map((item) => ({
        sku: item.sku,
        quantity: item.quantity,
        reason: 'remaining',
        productName: null,
        imageUrl: null,
    }));

    /* A separate bucket from the remaining-labels one above -- checking in
        and printing are different steps, so a SKU can be behind on either
        independently. Queried separately (rather than folded into
        resolveShipmentAndFetchRemaining) so the print handlers that also
        share that function don't pay for a query they never display. */
    let notCheckedIn;
    try {
        notCheckedIn = await fetchNotCheckedInForTable(result.shipment);
    } catch (error) {
        console.error('Failed to fetch not-checked-in SKUs:', error.message);
        notCheckedIn = { items: null, unsupported: false, error: describeAirtableError(error) };
    }

    const preambleNotes = [];
    if (notCheckedIn.unsupported) {
        preambleNotes.push(`Can't check not-checked-in status for "${result.shipment}" -- this table doesn't track "Checked In".`);
    } else if (notCheckedIn.error) {
        preambleNotes.push(`Couldn't check not-checked-in SKUs: ${notCheckedIn.error}`);
    }

    const notCheckedInRows = (notCheckedIn.items || []).map((item) => ({
        sku: item.sku,
        quantity: null,
        reason: 'not_checked_in',
        productName: null,
        imageUrl: null,
    }));

    if (remainingRows.length === 0 && notCheckedInRows.length === 0) {
        preambleNotes.unshift(`"${result.shipment}" has no remaining labels to print -- everything's already printed.`);
        await say(`<@${userId}> ${preambleNotes.join('\n\n')}`);
        return;
    }

    /* The "nothing left to print" framing has nowhere to live inside the
        paginated row view below (it's not a row), so when every row that's
        about to be shown is a not-checked-in one, it's said here as its own
        preamble message instead, same spot sayDisambiguationNoteIfAny's note
        already uses -- nothing the plain-text version used to say is lost. */
    if (remainingRows.length === 0) {
        preambleNotes.unshift(`"${result.shipment}" has no remaining labels to print -- everything's already printed.`);
    }

    if (preambleNotes.length > 0) {
        await say(`<@${userId}> ${preambleNotes.join('\n\n')}`);
    }

    let rows = [...remainingRows, ...notCheckedInRows];

    /* Enrichment, not a requirement -- fetchProductNamesForTable throws
        UNKNOWN_FIELD_NAME on a table missing the product-name lookup field
        entirely (same schema drift as the Checked In field elsewhere), and
        a table with the field can still have individual rows with no
        catalog link. Either way, rows still render with just their SKU and
        status (see formatStatusRowText's fallback) -- the status command's
        core job must never fail just because the name/image lookup did. */
    try {
        const namesPayload = await fetchProductNamesForTable(result.shipment);
        const bySku = new Map(namesPayload.items.map((item) => [item.sku.toUpperCase(), item]));
        rows = rows.map((row) => {
            const match = bySku.get(row.sku.toUpperCase());
            return match ? { ...row, productName: match.productName, imageUrl: match.imageUrl } : row;
        });
    } catch (error) {
        console.error('Failed to fetch product names/images for status enrichment:', error.message);
    }

    const totalPages = Math.ceil(rows.length / STATUS_PAGE_SIZE);
    const { text, blocks } = buildStatusPageBlocks({ shipment: result.shipment, userId, rows, page: 0, totalPages });
    const posted = await say({ text, blocks });

    if (totalPages > 1) {
        setStatusPageCache(posted.channel, posted.ts, { shipment: result.shipment, userId, rows });
    }
}

module.exports = { handleQueryShipmentStatus, buildStatusPageBlocks, STATUS_PAGE_SIZE };
