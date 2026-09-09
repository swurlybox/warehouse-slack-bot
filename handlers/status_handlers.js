const { isAllShipmentsQuery, fetchRemainingLabelsForAllShipments } = require('../airtable/shipment_lookup');
/* Reuses print_handlers.js's shipment resolution + error-reporting helpers
    rather than duplicating them -- status and print commands share the same
    "which shipment, what's remaining" logic, they just do different things
    with the result. */
const { resolveShipmentAndFetchRemaining, sayShipmentResolutionError } = require('./print_handlers');

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
    const fullyPrinted = results.filter((r) => !r.error && r.items.length === 0);
    const failed = results.filter((r) => r.error);

    if (withRemaining.length === 0 && failed.length === 0) {
        await say(`<@${userId}> Checked ${results.length} shipment(s) -- all fully printed, nothing remaining anywhere.`);
        return;
    }

    const lines = [
        ...withRemaining.map((r) => `• "${r.shipment}" -- ${r.items.length} SKU(s) remaining`),
        ...failed.map((r) => `• "${r.shipment}" -- couldn't read (${r.error})`),
    ];

    const summary = `Checked ${results.length} shipment(s): ${withRemaining.length} with remaining labels, ${fullyPrinted.length} fully printed` +
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

    if (result.items.length === 0) {
        await say(`<@${userId}> "${result.shipment}" has no remaining labels to print -- everything's already printed.`);
        return;
    }

    const lines = result.items.map((item) => `• ${item.sku} — ${item.quantity}`).join('\n');
    await say(`<@${userId}> "${result.shipment}" has ${result.items.length} SKU(s) still needing labels:\n${lines}`);
}

module.exports = { handleQueryShipmentStatus };
