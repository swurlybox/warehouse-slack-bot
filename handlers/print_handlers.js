const { fetchRemainingLabelsForTable, fetchLabelsBySkuForTable } = require('../airtable/fetch_remaining_labels');
const { findShipmentTable, isAllShipmentsQuery, SKU_TOKEN_PATTERN } = require('../airtable/shipment_lookup');
const { submitTestPrintJob } = require('../print_service');
const { setPendingPrint } = require('./print_confirmation');

/* Resolves which shipment table a print/query command should target: an
    explicitly named shipment (e.g. "for the august 21 shipment") wins; an
    empty query, an unmatched name, or a name that matches multiple tables is
    reported back to the caller to handle -- callers should not print against
    an ambiguous or unresolved shipment. There is deliberately no default
    shipment: a table like "Next Shipment" gets renamed to a dated name as
    part of the team's normal Airtable workflow, so relying on a fixed
    fallback name broke unpredictably whenever that happened.
    shipmentRef is whatever the intent parser extracted (see intent_parser.js)
    -- typically a clean phrase like "sept 10" or "all" -- and findShipmentTable
    tokenizes and matches on its leftover words. May be undefined (the parser
    can omit shipment_ref entirely), which resolves the same way an empty
    query already does: 'not_found'. */
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
    duplicating it. Exported for status_handlers.js's handleQueryShipmentStatus,
    which shares this same resolution/error-reporting shape rather than
    duplicating it. */
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
    'ok' (caller should proceed). exampleCommand lets each caller point at
    its own correct example phrasing. Exported alongside
    resolveShipmentAndFetchRemaining for the same reuse by
    status_handlers.js. */
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

/* A caller-specified print quantity has no upper or lower bound checked
    against Airtable's own expected count (by design -- see
    handlers/print_confirmation.js's confirmation message, which surfaces an
    override rather than blocking it), but it still has to be a real,
    physically-printable count. Anything else (0, negative, a float, a
    non-number) is treated the same as no quantity being given at all,
    rather than blocking the whole request over one bad number -- same
    fail-open-on-this-one-field spirit as SKU_TOKEN_PATTERN filtering out an
    individual malformed SKU below instead of rejecting the whole message. */
function isValidQuantity(quantity) {
    return Number.isInteger(quantity) && quantity > 0;
}

/* Resolves a "print sku(s) ... from ... shipment" request: takes the
    already-extracted SKU list (each optionally carrying a caller-specified
    print quantity -- see intent_parser.js) and shipment reference, resolves
    the shipment the same way every other command does, then looks up each
    named SKU directly (bypassing the remaining-labels filter on purpose --
    see fetchLabelsBySkuForTable). Any SKU not found in the resolved table
    blocks the whole request rather than silently printing a partial list,
    since a mistyped SKU in a targeted reprint is exactly the kind of thing
    that shouldn't fail quietly.
    Re-validates each sku against SKU_TOKEN_PATTERN here rather than trusting
    the LLM's own extraction -- this is what actually stops a malformed SKU
    from an arbitrarily-phrased message breaking out of
    fetchLabelsBySkuForTable's formula string. A caller-specified quantity
    overrides Airtable's own Labels-formula quantity for that SKU; the
    original is kept as `originalQuantity` on the returned item (only when
    it was actually overridden) so callers can flag the override to the user
    before it reaches the physical printer, same as the alreadyPrinted /
    notCheckedIn flags below. */
async function resolveSkuPrintRequest({ skus, shipmentRef }) {
    const requests = (skus || [])
        .filter((item) => item && SKU_TOKEN_PATTERN.test(item.sku))
        .map((item) => ({
            sku: item.sku,
            requestedQuantity: isValidQuantity(item.quantity) ? item.quantity : undefined,
        }));

    if (requests.length === 0 || !shipmentRef) {
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
        payload = await fetchLabelsBySkuForTable(resolved.tableName, requests.map((r) => r.sku));
    } catch (error) {
        console.error('Failed to fetch labels by SKU:', error.message);
        return { status: 'error', message: error.message };
    }

    const notFound = payload.results.filter((r) => r.notFound).map((r) => r.sku);
    if (notFound.length > 0) {
        return { status: 'sku_not_found', shipment: payload.shipment, notFound };
    }

    const requestedBySku = new Map(requests.map((r) => [r.sku.toUpperCase(), r.requestedQuantity]));
    const items = payload.results.map((item) => {
        const requestedQuantity = requestedBySku.get(item.sku.toUpperCase());
        if (requestedQuantity === undefined || requestedQuantity === item.quantity) {
            return item;
        }
        return { ...item, quantity: requestedQuantity, originalQuantity: item.quantity };
    });

    return { status: 'ok', shipment: payload.shipment, items };
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

/* Renders the reprint-safety flags (already printed / not checked in / a
    caller-specified quantity overriding Airtable's own count) that make a
    targeted SKU reprint visibly different from a normal remaining-labels
    print -- any combination shows together, since they're independent facts
    about the row, and none of them block the request on their own (see
    resolveSkuPrintRequest) -- they exist so the user knowingly confirms an
    unusual print rather than one silently happening. */
function formatSkuFlags(item) {
    const flags = [];
    if (item.alreadyPrinted) flags.push('already printed');
    if (item.notCheckedIn) flags.push('not checked in');
    if (item.originalQuantity !== undefined) flags.push(`qty overridden from ${item.originalQuantity}`);
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

    setPendingPrint(userId, { shipment: result.shipment, items: result.items });

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

    setPendingPrint(userId, {
        shipment: result.shipment,
        items: result.items.map(({ sku, quantity }) => ({ sku, quantity })),
    });

    const lines = result.items.map((item) => `• ${item.sku} — ${item.quantity}${formatSkuFlags(item)}`).join('\n');
    await say(`<@${userId}> This will send ${result.items.length} SKU(s) to the *physical printer* for "${result.shipment}":\n${lines}\nReply *confirm print* to proceed, or *cancel* to stand down (expires in 2 minutes).`);
}

module.exports = {
    handleTestPrintRemainingLabels,
    handlePrintRemainingLabels,
    handleTestPrintSpecificSkus,
    handlePrintSpecificSkus,
    resolveShipmentAndFetchRemaining,
    sayShipmentResolutionError,
};
