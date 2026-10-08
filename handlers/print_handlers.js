/**
 * @module handlers/print_handlers
 * Print and test-print command handlers: shared shipment resolution,
 * SKU/product-name lookup, and the real/dry print dispatch.
 */
const {
    fetchRemainingLabelsForTable,
    fetchLabelsBySkuForTable,
    fetchProductNamesForTable,
    describeAirtableError,
} = require('../airtable/fetch_remaining_labels');
const {
    findShipmentTable,
    isAllShipmentsQuery,
    SKU_TOKEN_PATTERN,
} = require('../airtable/shipment_lookup');
const { submitTestPrintJob } = require('../print_service');
const { setPendingPrint } = require('./print_confirmation');
const { setPendingProductSelection } = require('./product_selection');
const { rankProductMatches } = require('../product_matching');

// No default shipment: a renamed table broke a fixed fallback before.
async function resolveShipmentTableName(shipmentRef) {
    const result = await findShipmentTable(shipmentRef || '');

    if (result.status === 'ok') {
        return {
            status: 'ok',
            tableName: result.table.name,
            note: result.note,
        };
    }
    return result;
}

/**
 * Says findShipmentTable's disambiguation note (set when recency tie-break
 * picked a winner among several matches), if there is one. A no-op
 * otherwise, so every handler can call this unconditionally.
 *
 * @param {{note?: string}} result - A resolution result that may carry a
 *   note.
 * @param {Function} say - Slack reply function (
 *   {@link https://docs.slack.dev/tools/bolt-js/concepts/message-sending}
 *   utility from Bolt).
 * @param {string} userId - Slack user ID to mention.
 * @returns {Promise<void>}
 */
async function sayDisambiguationNoteIfAny(result, say, userId) {
    if (result.note) {
        await say(`<@${userId}> ${result.note}`);
    }
}

/**
 * Resolves the shipment a print/status command names and fetches its
 * remaining-label rows, folding every failure mode into one result shape
 * so callers share the same error reporting instead of duplicating it.
 *
 * @param {{shipmentRef: string}} args - The shipment reference.
 * @returns {Promise<object>} `{status: 'ok', shipment, items, note?}` on
 *   success, or `{status: 'all_not_supported'|'error'|'ambiguous'|
 *   'not_found', ...}` on failure.
 */
async function resolveShipmentAndFetchRemaining({ shipmentRef }) {
    if (isAllShipmentsQuery(shipmentRef || '')) {
        return { status: 'all_not_supported' };
    }

    const resolved = await resolveShipmentTableName(shipmentRef)
        .catch((error) => {
            console.error('Failed to look up shipment tables:', error.message);
            return { status: 'error', message: error.message };
        });

    if (resolved.status !== 'ok') {
        return resolved;
    }

    try {
        const payload = await fetchRemainingLabelsForTable(resolved.tableName);
        return {
            status: 'ok',
            shipment: payload.shipment,
            items: payload.items,
            note: resolved.note,
        };
    } catch (error) {
        console.error('Failed to fetch remaining labels:', error.message);
        return { status: 'error', message: describeAirtableError(error) };
    }
}

/**
 * Reports a non-'ok' resolveShipmentAndFetchRemaining result to the user.
 *
 * @param {object} result - The resolution result to report.
 * @param {Function} say - Slack reply function (
 *   {@link https://docs.slack.dev/tools/bolt-js/concepts/message-sending}
 *   utility from Bolt).
 * @param {string} userId - Slack user ID to mention.
 * @param {string} exampleCommand - Example phrasing for the error reply.
 * @returns {Promise<boolean>} True if an error was reported (caller
 *   should stop); false if the result was 'ok' (caller should proceed).
 */
async function sayShipmentResolutionError(result, say, userId, exampleCommand) {
    if (result.status === 'all_not_supported') {
        await say(
            `<@${userId}> Printing for all shipments at once isn't ` +
            `supported -- please name one shipment, e.g. "${exampleCommand}".`
        );
        return true;
    }
    if (result.status === 'error') {
        await say(
            `<@${userId}> Sorry, I couldn't look up shipment tables: ` +
            `${result.message}`
        );
        return true;
    }
    if (result.status === 'not_found') {
        await say(
            `<@${userId}> I couldn't tell which shipment you meant. ` +
            `Try naming it, e.g. "${exampleCommand}".`
        );
        return true;
    }
    if (result.status === 'ambiguous') {
        const names = result.matches
            .map((table) => `"${table.name}"`)
            .join(', ');
        await say(
            `<@${userId}> That matches more than one shipment: ${names}. ` +
            `Can you be more specific?`
        );
        return true;
    }
    return false;
}

// Fails open on an invalid quantity (0, negative, float, non-number) --
// treated as "no quantity given" rather than blocking the request.
function isValidQuantity(quantity) {
    return Number.isInteger(quantity) && quantity > 0;
}

/**
 * Resolves a "print sku(s) ... from ... shipment" request: resolves the
 * shipment, then looks up each named SKU directly, bypassing the
 * remaining-labels filter (a targeted reprint can target an
 * already-printed or not-checked-in SKU on purpose). Any SKU not found
 * blocks the whole request rather than silently printing a partial list.
 *
 * @param {object} args
 * @param {Array<{sku: string, quantity?: number}>} args.skus - SKUs with
 *   an optional per-SKU quantity override.
 * @param {string} args.shipmentRef - The shipment reference.
 * @returns {Promise<object>} `{status: 'ok', shipment, items, note?}` on
 *   success, or `{status: 'parse_error'|'sku_not_found'|'error'|
 *   'ambiguous'|'not_found', ...}` on failure.
 */
async function resolveSkuPrintRequest({ skus, shipmentRef }) {
    const requests = (skus || [])
        .filter((item) => item && SKU_TOKEN_PATTERN.test(item.sku))
        .map((item) => ({
            sku: item.sku,
            requestedQuantity: isValidQuantity(item.quantity)
                ? item.quantity
                : undefined,
        }));

    if (requests.length === 0 || !shipmentRef) {
        return { status: 'parse_error' };
    }

    const resolved = await resolveShipmentTableName(shipmentRef)
        .catch((error) => {
            console.error('Failed to look up shipment tables:', error.message);
            return { status: 'error', message: error.message };
        });

    if (resolved.status !== 'ok') {
        return resolved;
    }

    let payload;
    try {
        const skuList = requests.map((r) => r.sku);
        payload = await fetchLabelsBySkuForTable(resolved.tableName, skuList);
    } catch (error) {
        console.error('Failed to fetch labels by SKU:', error.message);
        return { status: 'error', message: describeAirtableError(error) };
    }

    const notFound = payload.results
        .filter((r) => r.notFound)
        .map((r) => r.sku);
    if (notFound.length > 0) {
        return {
            status: 'sku_not_found',
            shipment: payload.shipment,
            notFound,
        };
    }

    const requestedBySku = new Map(
        requests.map((r) => [r.sku.toUpperCase(), r.requestedQuantity])
    );
    const items = payload.results.map((item) => {
        const requestedQuantity = requestedBySku.get(item.sku.toUpperCase());
        const unchanged = requestedQuantity === undefined ||
            requestedQuantity === item.quantity;
        if (unchanged) {
            return item;
        }
        return {
            ...item,
            quantity: requestedQuantity,
            originalQuantity: item.quantity,
        };
    });

    return {
        status: 'ok',
        shipment: payload.shipment,
        items,
        note: resolved.note,
    };
}

// Reports resolveSkuPrintRequest's SKU-specific failures; falls through
// to sayShipmentResolutionError for the failures they share.
async function saySkuResolutionError(result, say, userId, exampleCommand) {
    if (result.status === 'parse_error') {
        await say(
            `<@${userId}> I couldn't tell which SKUs or shipment you ` +
            `meant. Try something like "${exampleCommand}".`
        );
        return true;
    }
    if (result.status === 'sku_not_found') {
        const skus = result.notFound.map((sku) => `"${sku}"`).join(', ');
        await say(
            `<@${userId}> Couldn't find ${skus} in "${result.shipment}". ` +
            `Check the SKU(s) and try again.`
        );
        return true;
    }
    return sayShipmentResolutionError(result, say, userId, exampleCommand);
}

// Renders the reprint-safety flags (already printed / not checked in /
// quantity override) so the user knowingly confirms an unusual reprint.
function formatSkuFlags(item) {
    const flags = [];
    if (item.alreadyPrinted) flags.push('already printed');
    if (item.notCheckedIn) flags.push('not checked in');
    if (item.originalQuantity !== undefined) {
        flags.push(`qty overridden from ${item.originalQuantity}`);
    }
    return flags.length ? `  ⚠ ${flags.join(', ')}` : '';
}

/**
 * Downloads label PDFs for the named shipment's remaining labels, without
 * sending them to a physical printer.
 *
 * @param {{shipmentRef: string}} args - The shipment reference.
 * @param {Function} say - Slack reply function (
 *   {@link https://docs.slack.dev/tools/bolt-js/concepts/message-sending}
 *   utility from Bolt).
 * @param {string} userId - Slack user ID who asked.
 * @returns {Promise<void>}
 */
async function handleTestPrintRemainingLabels({ shipmentRef }, say, userId) {
    const result = await resolveShipmentAndFetchRemaining({ shipmentRef });
    const exampleCommand = (
        'test print remaining labels for the august 21 shipment'
    );
    if (await sayShipmentResolutionError(result, say, userId, exampleCommand)) {
        return;
    }
    await sayDisambiguationNoteIfAny(result, say, userId);

    if (result.items.length === 0) {
        await say(
            `<@${userId}> No remaining labels to test-print for ` +
            `"${result.shipment}" -- everything's already printed.`
        );
        return;
    }

    const lines = result.items
        .map((item) => `• ${item.sku} — ${item.quantity}`)
        .join('\n');
    await say(
        `<@${userId}> [Test print -- nothing physical] Found ` +
        `${result.items.length} SKU(s) still needing labels for ` +
        `"${result.shipment}":\n${lines}`
    );

    try {
        await submitTestPrintJob(result.items);
        await say(
            `<@${userId}> Test print finished for "${result.shipment}" ` +
            `(${result.items.length} SKU(s)) -- labels were downloaded, ` +
            `not sent to the printer.`
        );
    } catch (error) {
        console.error('Test print job failed:', error.message);
        await say(
            `<@${userId}> Sorry, the test print job failed: ${error.message}`
        );
    }
}

/**
 * Fetches the named shipment's remaining labels, then asks the user to
 * confirm before sending them to the physical printer. Cannot be undone
 * once confirmed. The eventual reply only reports the SKU count, not the
 * print server's own response body (its internal output, free to
 * change).
 *
 * @param {{shipmentRef: string}} args - The shipment reference.
 * @param {Function} say - Slack reply function (
 *   {@link https://docs.slack.dev/tools/bolt-js/concepts/message-sending}
 *   utility from Bolt).
 * @param {string} userId - Slack user ID who asked.
 * @returns {Promise<void>}
 */
async function handlePrintRemainingLabels({ shipmentRef }, say, userId) {
    const result = await resolveShipmentAndFetchRemaining({ shipmentRef });
    const exampleCommand = 'print remaining labels for the august 21 shipment';
    if (await sayShipmentResolutionError(result, say, userId, exampleCommand)) {
        return;
    }
    await sayDisambiguationNoteIfAny(result, say, userId);

    if (result.items.length === 0) {
        await say(
            `<@${userId}> No remaining labels to print for ` +
            `"${result.shipment}" -- everything's already printed.`
        );
        return;
    }

    setPendingPrint(userId, { shipment: result.shipment, items: result.items });

    const lines = result.items
        .map((item) => `• ${item.sku} — ${item.quantity}`)
        .join('\n');
    await say(
        `<@${userId}> This will send ${result.items.length} SKU(s) to ` +
        `the *physical printer* for "${result.shipment}":\n${lines}\n` +
        `Reply *confirm print* to proceed, or *cancel* to stand down ` +
        `(expires in 2 minutes).`
    );
}

/**
 * Downloads label PDFs for specific named SKUs, bypassing the
 * printed/checked-in filter. Safe to run without confirmation.
 *
 * @param {object} args
 * @param {Array<{sku: string, quantity?: number}>} args.skus - SKUs with
 *   an optional per-SKU quantity override.
 * @param {string} args.shipmentRef - The shipment reference.
 * @param {Function} say - Slack reply function (
 *   {@link https://docs.slack.dev/tools/bolt-js/concepts/message-sending}
 *   utility from Bolt).
 * @param {string} userId - Slack user ID who asked.
 * @returns {Promise<void>}
 */
async function handleTestPrintSpecificSkus({ skus, shipmentRef }, say, userId) {
    const result = await resolveSkuPrintRequest({ skus, shipmentRef });
    const exampleCommand = (
        'test print sku B08ABC123 from the august 21 shipment'
    );
    if (await saySkuResolutionError(result, say, userId, exampleCommand)) {
        return;
    }
    await sayDisambiguationNoteIfAny(result, say, userId);

    const lines = result.items
        .map((item) => {
            return `• ${item.sku} — ${item.quantity}${formatSkuFlags(item)}`;
        })
        .join('\n');
    await say(
        `<@${userId}> [Test print -- nothing physical] Found ` +
        `${result.items.length} SKU(s) for "${result.shipment}":\n${lines}`
    );

    try {
        const items = result.items.map(({ sku, quantity }) => {
            return { sku, quantity };
        });
        await submitTestPrintJob(items);
        await say(
            `<@${userId}> Test print finished for "${result.shipment}" ` +
            `(${result.items.length} SKU(s)) -- labels were downloaded, ` +
            `not sent to the printer.`
        );
    } catch (error) {
        console.error('Test print job failed:', error.message);
        await say(
            `<@${userId}> Sorry, the test print job failed: ${error.message}`
        );
    }
}

/**
 * Same targeted-reprint lookup as handleTestPrintSpecificSkus, but asks
 * for confirmation before sending to the physical printer. Any SKU
 * flagged as already printed or not checked in is called out in the
 * confirmation.
 *
 * @param {object} args
 * @param {Array<{sku: string, quantity?: number}>} args.skus - SKUs with
 *   an optional per-SKU quantity override.
 * @param {string} args.shipmentRef - The shipment reference.
 * @param {Function} say - Slack reply function (
 *   {@link https://docs.slack.dev/tools/bolt-js/concepts/message-sending}
 *   utility from Bolt).
 * @param {string} userId - Slack user ID who asked.
 * @returns {Promise<void>}
 */
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

    const lines = result.items
        .map((item) => {
            return `• ${item.sku} — ${item.quantity}${formatSkuFlags(item)}`;
        })
        .join('\n');
    await say(
        `<@${userId}> This will send ${result.items.length} SKU(s) to ` +
        `the *physical printer* for "${result.shipment}":\n${lines}\n` +
        `Reply *confirm print* to proceed, or *cancel* to stand down ` +
        `(expires in 2 minutes).`
    );
}

const MAX_PRODUCT_CANDIDATES_SHOWN = 10;

/**
 * Resolves the shipment, fetches its name-matchable rows, and ranks them
 * against a free-text product query. Shared by handlePrintByProductName
 * and handleTestPrintByProductName.
 *
 * @param {{productQuery: string, shipmentRef: string}} args - The product
 *   description and shipment reference.
 * @returns {Promise<object>} `{status: 'ok', shipment, candidates, note?}`
 *   on success, or `{status: 'parse_error'|'no_names_available'|
 *   'no_matches'|'error'|'ambiguous'|'not_found', ...}` on failure.
 */
async function resolveProductNameMatches({ productQuery, shipmentRef }) {
    if (!productQuery) {
        return { status: 'parse_error' };
    }

    const resolved = await resolveShipmentTableName(shipmentRef)
        .catch((error) => {
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
        // A table missing the product-name field entirely is expected,
        // not a real lookup failure.
        if (error.error === 'UNKNOWN_FIELD_NAME') {
            return {
                status: 'no_names_available',
                shipment: resolved.tableName,
                note: resolved.note,
            };
        }
        console.error('Failed to fetch product names:', error.message);
        return { status: 'error', message: describeAirtableError(error) };
    }

    if (payload.items.length === 0) {
        return {
            status: 'no_names_available',
            shipment: payload.shipment,
            note: resolved.note,
        };
    }

    const ranked = await rankProductMatches(productQuery, payload.items);
    if (ranked.error) {
        return {
            status: 'error',
            message: 'Product matching is temporarily unavailable.',
        };
    }

    // Cross-checked against the real candidate list -- the model is only
    // asked, not guaranteed, to echo back given SKUs.
    const bySku = new Map(
        payload.items.map((item) => [item.sku.toUpperCase(), item])
    );
    const candidates = ranked.matches
        .map((match) => bySku.get((match.sku || '').toUpperCase()))
        .filter(Boolean)
        .slice(0, MAX_PRODUCT_CANDIDATES_SHOWN)
        .map(({ sku, productName, quantity, imageUrl }) => ({
            sku,
            productName,
            quantity,
            imageUrl,
        }));

    if (candidates.length === 0) {
        return {
            status: 'no_matches',
            shipment: payload.shipment,
            query: productQuery,
        };
    }

    return {
        status: 'ok',
        shipment: payload.shipment,
        candidates,
        note: resolved.note,
    };
}

// Reports resolveProductNameMatches' own failures; falls through to
// sayShipmentResolutionError for the failures they share.
async function sayProductMatchError(result, say, userId, exampleCommand) {
    if (result.status === 'parse_error') {
        await say(
            `<@${userId}> I couldn't tell what product you meant. ` +
            `Try something like "${exampleCommand}".`
        );
        return true;
    }
    if (result.status === 'no_names_available') {
        await sayDisambiguationNoteIfAny(result, say, userId);
        await say(
            `<@${userId}> "${result.shipment}" doesn't support searching ` +
            `by product name (it predates that data) -- try naming the ` +
            `SKU directly instead.`
        );
        return true;
    }
    if (result.status === 'no_matches') {
        await say(
            `<@${userId}> Couldn't find anything in "${result.shipment}" ` +
            `matching "${result.query}".`
        );
        return true;
    }
    return sayShipmentResolutionError(result, say, userId, exampleCommand);
}

/**
 * Builds the Slack Block Kit message for a ranked product-candidate
 * list, one section per candidate with an image accessory when
 * available.
 *
 * @param {object} args
 * @param {string} args.userId - Slack user ID to mention.
 * @param {string} args.shipment - Shipment table name.
 * @param {string} args.query - The user's product query, for the header.
 * @param {Array<{sku: string, productName: string, quantity?: number,
 *   imageUrl?: string}>} args.candidates - Ranked candidates to render.
 * @returns {{text: string, blocks: Array<object>}} A (
 *   {@link https://docs.slack.dev/block-kit/|Slack Block Kit}) payload:
 *   section blocks with image accessories.
 */
function buildProductCandidateBlocks({ userId, shipment, query, candidates }) {
    const summaryLines = candidates.map((candidate, i) => {
        const qtyPart = Number.isFinite(candidate.quantity)
            ? `, default qty ${candidate.quantity}`
            : '';
        return (
            `${i + 1}. ${candidate.productName} -- SKU ` +
            `${candidate.sku}${qtyPart}`
        );
    });
    const text = (
        `<@${userId}> Found ${candidates.length} match(es) in ` +
        `"${shipment}" for "${query}":\n${summaryLines.join('\n')}`
    );

    const candidateBlocks = candidates.map((candidate, i) => {
        const qtyPart = Number.isFinite(candidate.quantity)
            ? ` · Default qty *${candidate.quantity}*`
            : '';
        const block = {
            type: 'section',
            text: {
                type: 'mrkdwn',
                text: `${i + 1}. ${candidate.productName}\n` +
                    `   SKU *${candidate.sku}*${qtyPart}`,
            },
        };
        if (candidate.imageUrl) {
            block.accessory = {
                type: 'image',
                image_url: candidate.imageUrl,
                alt_text: candidate.productName.slice(0, 2000),
            };
        }
        return block;
    });

    const headerText = (
        `<@${userId}> Found *${candidates.length}* match(es) in ` +
        `"${shipment}" for "${query}":`
    );
    const footerText = (
        'Reply with a number to pick one (e.g. "1"), multiple separated ' +
        'by commas (e.g. "1, 3"), optionally with a quantity override ' +
        '(e.g. "1 x5") -- or *cancel* to back out. Expires in 2 minutes.'
    );
    const blocks = [
        { type: 'section', text: { type: 'mrkdwn', text: headerText } },
        ...candidateBlocks,
        { type: 'section', text: { type: 'mrkdwn', text: footerText } },
    ];

    return { text, blocks };
}

// Shows the ranked matches and holds them as a pending selection; isTest
// only controls which handler the eventual reply hands off to.
async function handleProductNameSearch(
    { productQuery, shipmentRef },
    say,
    userId,
    isTest
) {
    const result = await resolveProductNameMatches({
        productQuery,
        shipmentRef,
    });
    const exampleCommand = (
        `${isTest ? 'test print' : 'print'} the kikkoman soy sauce from ` +
        `the august 21 shipment`
    );
    if (await sayProductMatchError(result, say, userId, exampleCommand)) {
        return;
    }

    await sayDisambiguationNoteIfAny(result, say, userId);
    setPendingProductSelection(userId, {
        shipment: result.shipment,
        isTest,
        candidates: result.candidates,
    });

    const { text, blocks } = buildProductCandidateBlocks({
        userId,
        shipment: result.shipment,
        query: productQuery,
        candidates: result.candidates,
    });
    await say({ text, blocks });
}

/**
 * Searches for a product by name within a shipment and shows the ranked
 * matches (dry-run lookup; nothing prints until the user replies with a
 * number).
 *
 * @param {{productQuery: string, shipmentRef: string}} args - The product
 *   description and shipment reference.
 * @param {Function} say - Slack reply function (
 *   {@link https://docs.slack.dev/tools/bolt-js/concepts/message-sending}
 *   utility from Bolt).
 * @param {string} userId - Slack user ID who asked.
 * @returns {Promise<void>}
 */
async function handlePrintByProductName(
    { productQuery, shipmentRef },
    say,
    userId
) {
    await handleProductNameSearch(
        { productQuery, shipmentRef },
        say,
        userId,
        false
    );
}

/**
 * Same as handlePrintByProductName, but the eventual selection leads to a
 * dry-run test print rather than a real one.
 *
 * @param {{productQuery: string, shipmentRef: string}} args - The product
 *   description and shipment reference.
 * @param {Function} say - Slack reply function (
 *   {@link https://docs.slack.dev/tools/bolt-js/concepts/message-sending}
 *   utility from Bolt).
 * @param {string} userId - Slack user ID who asked.
 * @returns {Promise<void>}
 */
async function handleTestPrintByProductName(
    { productQuery, shipmentRef },
    say,
    userId
) {
    await handleProductNameSearch(
        { productQuery, shipmentRef },
        say,
        userId,
        true
    );
}

/**
 * Called once a product-name selection resolves to concrete SKU(s);
 * hands off to the same targeted-SKU handlers any other reprint request
 * uses, so this is just a different way of arriving at a `{skus,
 * shipmentRef}` request, not a second print pipeline.
 *
 * @param {{shipment: string, isTest: boolean, items: Array<{sku: string,
 *   quantity?: number}>}} selection - The resolved selection.
 * @param {Function} say - Slack reply function (
 *   {@link https://docs.slack.dev/tools/bolt-js/concepts/message-sending}
 *   utility from Bolt).
 * @param {string} userId - Slack user ID who made the selection.
 * @returns {Promise<void>}
 */
async function handleResolvedProductSelection(
    { shipment, isTest, items },
    say,
    userId
) {
    const handler = isTest
        ? handleTestPrintSpecificSkus
        : handlePrintSpecificSkus;
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
