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
    identically. Exported for status_handlers.js's handleQueryShipmentStatus,
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
