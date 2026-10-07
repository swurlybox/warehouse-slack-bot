const { fetchRemainingLabelsForTable, fetchLabelsBySkuForTable, fetchProductNamesForTable } = require('../airtable/fetch_remaining_labels');
const { findShipmentTable, isAllShipmentsQuery, SKU_TOKEN_PATTERN } = require('../airtable/shipment_lookup');
const { submitTestPrintJob } = require('../print_service');
const { setPendingPrint } = require('./print_confirmation');
const { setPendingProductSelection } = require('./product_selection');
const { rankProductMatches } = require('../product_matching');

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
        return { status: 'ok', tableName: result.table.name, note: result.note };
    }
    return result;
}

/* Surfaces findShipmentTable's disambiguation note (set when more than one
    shipment matched and recency tie-break picked a winner instead of
    asking the user to clarify -- see airtable/shipment_lookup.js) right
    before a handler's main reply. A no-op when there's nothing to say, so
    every handler below can call this unconditionally after its own
    resolution succeeds. */
async function sayDisambiguationNoteIfAny(result, say, userId) {
    if (result.note) {
        await say(`<@${userId}> ${result.note}`);
    }
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
        return { status: 'ok', shipment: payload.shipment, items: payload.items, note: resolved.note };
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

    return { status: 'ok', shipment: payload.shipment, items, note: resolved.note };
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
    await sayDisambiguationNoteIfAny(result, say, userId);

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
    await sayDisambiguationNoteIfAny(result, say, userId);

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
    await sayDisambiguationNoteIfAny(result, say, userId);

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
    await sayDisambiguationNoteIfAny(result, say, userId);

    setPendingPrint(userId, {
        shipment: result.shipment,
        items: result.items.map(({ sku, quantity }) => ({ sku, quantity })),
    });

    const lines = result.items.map((item) => `• ${item.sku} — ${item.quantity}${formatSkuFlags(item)}`).join('\n');
    await say(`<@${userId}> This will send ${result.items.length} SKU(s) to the *physical printer* for "${result.shipment}":\n${lines}\nReply *confirm print* to proceed, or *cancel* to stand down (expires in 2 minutes).`);
}

const MAX_PRODUCT_CANDIDATES_SHOWN = 10;

/* Shared by handlePrintByProductName and handleTestPrintByProductName:
    resolves the shipment, fetches its name-matchable rows, ranks them
    against the free-text query, and returns a result shape analogous to
    resolveSkuPrintRequest above -- 'ok' with the ranked candidates, or a
    status sayProductMatchError below (or, for the shipment-resolution
    failures shared with every other command, sayShipmentResolutionError)
    already knows how to report. */
async function resolveProductNameMatches({ productQuery, shipmentRef }) {
    if (!productQuery) {
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
        payload = await fetchProductNamesForTable(resolved.tableName);
    } catch (error) {
        /* A handful of older shipment tables predate the product-name
            lookup field entirely (confirmed live: Airtable's client throws
            a structured UNKNOWN_FIELD_NAME error for that -- it does not,
            as might be assumed, just silently omit an unrecognized field
            from the response). That's a distinct, expected case from a
            real lookup failure (network, auth, etc.) -- surfacing it as
            "couldn't look up shipment tables" would be misleading, since
            the shipment itself was found fine. */
        if (error.error === 'UNKNOWN_FIELD_NAME') {
            return { status: 'no_names_available', shipment: resolved.tableName, note: resolved.note };
        }
        console.error('Failed to fetch product names:', error.message);
        return { status: 'error', message: error.message };
    }

    if (payload.items.length === 0) {
        return { status: 'no_names_available', shipment: payload.shipment, note: resolved.note };
    }

    const ranked = await rankProductMatches(productQuery, payload.items);
    if (ranked.error) {
        return { status: 'error', message: 'Product matching is temporarily unavailable.' };
    }

    /* Claude is asked to only echo back SKUs it was actually given, but
        that's a prompt instruction, not a guarantee -- cross-check against
        the real candidate list rather than trusting it outright, same
        spirit as the SKU_TOKEN_PATTERN re-validation in
        resolveSkuPrintRequest above. */
    const bySku = new Map(payload.items.map((item) => [item.sku.toUpperCase(), item]));
    const candidates = ranked.matches
        .map((match) => bySku.get((match.sku || '').toUpperCase()))
        .filter(Boolean)
        .slice(0, MAX_PRODUCT_CANDIDATES_SHOWN)
        .map(({ sku, productName, quantity, imageUrl }) => ({ sku, productName, quantity, imageUrl }));

    if (candidates.length === 0) {
        return { status: 'no_matches', shipment: payload.shipment, query: productQuery };
    }

    return { status: 'ok', shipment: payload.shipment, candidates, note: resolved.note };
}

/* Reports resolveProductNameMatches' own failure modes; falls through to
    sayShipmentResolutionError for the shipment-resolution failures shared
    with every other command. Same true/false contract as that function. */
async function sayProductMatchError(result, say, userId, exampleCommand) {
    if (result.status === 'parse_error') {
        await say(`<@${userId}> I couldn't tell what product you meant. Try something like "${exampleCommand}".`);
        return true;
    }
    if (result.status === 'no_names_available') {
        await sayDisambiguationNoteIfAny(result, say, userId);
        await say(`<@${userId}> "${result.shipment}" doesn't support searching by product name (it predates that data) -- try naming the SKU directly instead.`);
        return true;
    }
    if (result.status === 'no_matches') {
        await say(`<@${userId}> Couldn't find anything in "${result.shipment}" matching "${result.query}".`);
        return true;
    }
    return sayShipmentResolutionError(result, say, userId, exampleCommand);
}

/* Builds the Slack Block Kit message for a ranked candidate list -- the
    first time this bot sends anything beyond a plain string, needed so
    each product's thumbnail can sit next to its name/SKU/quantity via
    Block Kit's section "accessory" image, letting the user visually
    confirm the product before picking it. A candidate missing an image
    (its catalog row has none, or this table predates the lookup field)
    just gets a plain section with no accessory, rather than a
    broken/missing-image block.
    Product names here run long (real examples are 80-150+ characters), so
    the SKU and default quantity always go on their own indented line
    rather than being crammed onto the end of the name line -- consistent
    wrapping reads better than only wrapping the occasional short one.
    The quantity shown is Airtable's default at search time, not
    necessarily final -- resolveSkuPrintRequest re-fetches it fresh (and
    an explicit "x<N>" at selection time overrides it); labeling it
    "Default qty" here keeps that relationship clear rather than implying
    it's locked in. Omitted entirely for a row with no valid Labels value
    rather than printing a misleading "qty: null".
    `text` is the required plain-text fallback (notification previews, and
    any client that can't render blocks) -- same information as the
    blocks, just without images. */
function buildProductCandidateBlocks({ userId, shipment, query, candidates }) {
    const summaryLines = candidates.map((candidate, i) => {
        const qtyPart = Number.isFinite(candidate.quantity) ? `, default qty ${candidate.quantity}` : '';
        return `${i + 1}. ${candidate.productName} -- SKU ${candidate.sku}${qtyPart}`;
    });
    const text = `<@${userId}> Found ${candidates.length} match(es) in "${shipment}" for "${query}":\n${summaryLines.join('\n')}`;

    const candidateBlocks = candidates.map((candidate, i) => {
        const qtyPart = Number.isFinite(candidate.quantity) ? ` · Default qty *${candidate.quantity}*` : '';
        const block = {
            type: 'section',
            text: { type: 'mrkdwn', text: `${i + 1}. ${candidate.productName}\n   SKU *${candidate.sku}*${qtyPart}` },
        };
        if (candidate.imageUrl) {
            block.accessory = { type: 'image', image_url: candidate.imageUrl, alt_text: candidate.productName.slice(0, 2000) };
        }
        return block;
    });

    const blocks = [
        { type: 'section', text: { type: 'mrkdwn', text: `<@${userId}> Found *${candidates.length}* match(es) in "${shipment}" for "${query}":` } },
        ...candidateBlocks,
        { type: 'section', text: { type: 'mrkdwn', text: 'Reply with a number to pick one (e.g. "1"), multiple separated by commas (e.g. "1, 3"), optionally with a quantity override (e.g. "1 x5") -- or *cancel* to back out. Expires in 2 minutes.' } },
    ];

    return { text, blocks };
}

/* Shared by handlePrintByProductName/handleTestPrintByProductName: shows
    the ranked matches and holds them as a pending selection (see
    handlers/product_selection.js) -- isTest controls only which handler
    the eventual numeric reply hands off to, not anything about this step
    itself. Nothing is resolved to a specific SKU, let alone printed, until
    the user actually replies with a number. */
async function handleProductNameSearch({ productQuery, shipmentRef }, say, userId, isTest) {
    const result = await resolveProductNameMatches({ productQuery, shipmentRef });
    const exampleCommand = `${isTest ? 'test print' : 'print'} the kikkoman soy sauce from the august 21 shipment`;
    if (await sayProductMatchError(result, say, userId, exampleCommand)) {
        return;
    }

    await sayDisambiguationNoteIfAny(result, say, userId);
    setPendingProductSelection(userId, { shipment: result.shipment, isTest, candidates: result.candidates });

    const { text, blocks } = buildProductCandidateBlocks({ userId, shipment: result.shipment, query: productQuery, candidates: result.candidates });
    await say({ text, blocks });
}

/* Searches for a product by name within a shipment and shows the ranked
    matches as a dry-run-only lookup -- no confirmation needed for this
    step regardless of isTest, since nothing prints yet either way; isTest
    only decides whether the eventual numeric selection leads to a real
    print (gated by the usual confirm/cancel step) or a dry run. */
async function handlePrintByProductName({ productQuery, shipmentRef }, say, userId) {
    await handleProductNameSearch({ productQuery, shipmentRef }, say, userId, false);
}

async function handleTestPrintByProductName({ productQuery, shipmentRef }, say, userId) {
    await handleProductNameSearch({ productQuery, shipmentRef }, say, userId, true);
}

/* Called by product_selection.js's handlePendingProductSelection once the
    user's numeric reply resolves to concrete SKU(s) -- hands off to the
    exact same handlers every other targeted-SKU print goes through
    (re-fetching fresh quantity/already-printed/checked-in data rather than
    trusting what was shown minutes earlier at selection time), so this
    feature is just a different way of arriving at a { skus, shipmentRef }
    request, not a second print pipeline. */
async function handleResolvedProductSelection({ shipment, isTest, items }, say, userId) {
    const handler = isTest ? handleTestPrintSpecificSkus : handlePrintSpecificSkus;
    await handler({ skus: items, shipmentRef: shipment }, say, userId);
}

module.exports = {
    handleTestPrintRemainingLabels,
    handlePrintRemainingLabels,
    handleTestPrintSpecificSkus,
    handlePrintSpecificSkus,
    handlePrintByProductName,
    handleTestPrintByProductName,
    handleResolvedProductSelection,
    resolveShipmentAndFetchRemaining,
    sayShipmentResolutionError,
    sayDisambiguationNoteIfAny,
};
