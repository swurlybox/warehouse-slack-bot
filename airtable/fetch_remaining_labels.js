/**
 * @module airtable/fetch_remaining_labels
 * Per-table Airtable queries (remaining labels, not-checked-in rows, SKU
 * lookup, product names/images) plus describeAirtableError, the
 * error-sanitizing chokepoint for every Slack-facing Airtable error.
 */
require('dotenv').config();
const Airtable = require('airtable');

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID || 'app5sCWXMPQpuJodj';
const SHIPMENT_TABLE = 'Next Shipment';

if (!AIRTABLE_API_KEY) {
    console.error(
        'Missing AIRTABLE_API_KEY environment variable. ' +
        'Set it in .env (see .env.example).'
    );
    process.exit(1);
}

const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);

/**
 * Rewrites a raw Airtable/node-fetch error into a message safe to show a
 * non-technical Slack audience: a network failure that would otherwise
 * leak the full request URL is reduced to just the reason (e.g.
 * "ECONNRESET"), and the schema-drift errors from tables missing the
 * Checked In field are rewritten into plain language. Every call site
 * that surfaces an Airtable error to Slack should route through this.
 *
 * @param {Error & {error?: string, code?: string}} error - The raw error
 *   from an ({@link https://airtable.com/developers/web/api/errors|
 *   Airtable API}) call.
 * @returns {string} A Slack-safe error message.
 */
function describeAirtableError(error) {
    const networkMatch = /^request to .* failed, reason: (.*)$/.exec(
        error.message || ''
    );
    if (networkMatch) {
        return error.code || networkMatch[1];
    }

    const isMissingFieldError = error.error === 'UNKNOWN_FIELD_NAME' ||
        (error.error === 'INVALID_FILTER_BY_FORMULA' &&
            /unknown field names/i.test(error.message || ''));
    if (isMissingFieldError) {
        return (
            "this shipment was set up differently than newer ones, so " +
            "I can't check it right now -- let whoever manages the " +
            "shipment sheet know."
        );
    }

    return error.message;
}

/**
 * Fetches a shipment table's rows that are checked in but not yet
 * printed.
 *
 * @param {string} tableName - The Airtable shipment table name.
 * @returns {Promise<{shipment: string, items: Array<{sku: string,
 *   quantity: number}>}>}
 */
async function fetchRemainingLabelsForTable(tableName) {
    const items = [];

    await base(tableName)
        .select({
            filterByFormula: 'AND(NOT({Label Printed}), {Checked In})',
            fields: ['SKU', 'Labels'],
        })
        .eachPage((records, fetchNextPage) => {
            for (const record of records) {
                const sku = record.get('SKU');
                const quantity = record.get('Labels');

                if (!sku || !Number.isFinite(quantity)) {
                    console.warn(
                        `Skipping record ${record.id}: ` +
                        `missing SKU or Labels value.`
                    );
                    continue;
                }

                items.push({ sku, quantity });
            }
            fetchNextPage();
        });

    return { shipment: tableName, items };
}

/**
 * Fetches the default shipment table's ("Next Shipment") remaining
 * labels.
 *
 * @returns {Promise<{shipment: string, items: Array<{sku: string,
 *   quantity: number}>}>}
 */
function fetchRemainingLabels() {
    return fetchRemainingLabelsForTable(SHIPMENT_TABLE);
}

/**
 * Fetches a shipment table's rows that haven't been checked in yet -- a
 * separate bucket from "needs a label printed", since checking in and
 * printing are independent steps.
 *
 * @param {string} tableName - The Airtable shipment table name.
 * @returns {Promise<{shipment: string, items: Array<{sku: string}> |
 *   null, unsupported: boolean}>} `unsupported: true` (with `items:
 *   null`) when the table predates the Checked In field entirely,
 *   instead of throwing -- callers can skip this bucket gracefully.
 */
async function fetchNotCheckedInForTable(tableName) {
    const items = [];

    try {
        await base(tableName)
            .select({
                filterByFormula: 'NOT({Checked In})',
                fields: ['SKU'],
            })
            .eachPage((records, fetchNextPage) => {
                for (const record of records) {
                    const sku = record.get('SKU');
                    if (!sku) {
                        continue;
                    }
                    items.push({ sku });
                }
                fetchNextPage();
            });
    } catch (error) {
        const isMissingField = error.error === 'INVALID_FILTER_BY_FORMULA' &&
            /unknown field names/i.test(error.message);
        if (isMissingField) {
            return { shipment: tableName, items: null, unsupported: true };
        }
        throw error;
    }

    return { shipment: tableName, items, unsupported: false };
}

/**
 * Looks up specific SKUs within a shipment table by exact
 * (case-insensitive) match, regardless of print/check-in status -- used
 * for targeted reprints, which intentionally bypass the normal
 * remaining-labels filter.
 *
 * @param {string} tableName - The Airtable shipment table name.
 * @param {string[]} skus - SKUs to look up (already validated against
 *   SKU_TOKEN_PATTERN by the caller).
 * @returns {Promise<{shipment: string, results: Array<{sku: string,
 *   quantity?: number, alreadyPrinted?: boolean, notCheckedIn?: boolean,
 *   notFound?: true}>}>} One result per requested SKU, in the same
 *   order.
 */
async function fetchLabelsBySkuForTable(tableName, skus) {
    const uniqueSkus = [...new Set(skus)];
    const formula = `OR(${uniqueSkus
        .map((sku) => `LOWER({SKU}) = LOWER("${sku}")`)
        .join(', ')})`;
    const found = new Map();

    await base(tableName)
        .select({
            filterByFormula: formula,
            fields: ['SKU', 'Labels', 'Label Printed', 'Checked In'],
        })
        .eachPage((records, fetchNextPage) => {
            for (const record of records) {
                const sku = record.get('SKU');
                const quantity = record.get('Labels');

                if (!sku || !Number.isFinite(quantity)) {
                    console.warn(
                        `Skipping record ${record.id}: ` +
                        `missing SKU or Labels value.`
                    );
                    continue;
                }

                // Keyed by uppercase so the lookup below matches
                // regardless of the request's casing.
                found.set(sku.toUpperCase(), {
                    sku,
                    quantity,
                    alreadyPrinted: Boolean(record.get('Label Printed')),
                    notCheckedIn: !record.get('Checked In'),
                });
            }
            fetchNextPage();
        });

    const results = uniqueSkus.map((sku) => {
        return found.get(sku.toUpperCase()) || { sku, notFound: true };
    });
    return { shipment: tableName, results };
}

// Lookup to the master product catalog table; missing entirely on a
// handful of older shipment tables.
const PRODUCT_NAME_FIELD = 'Name. 名字. Nombre. 2';

// Same lookup pattern/caveats as PRODUCT_NAME_FIELD; comes back as an
// array of Airtable attachment objects.
const PRODUCT_IMAGE_FIELD = 'Image，图片 (from Product Name Lookup)';

// `large` (~512px) is enough for a quick visual check and smaller than
// the full-resolution original; falls back down the chain if missing.
function pickThumbnailUrl(attachment) {
    return attachment?.thumbnails?.large?.url ||
        attachment?.thumbnails?.small?.url ||
        attachment?.url ||
        null;
}

/**
 * Fetches every SKU in a shipment table paired with its product name,
 * default print quantity, and thumbnail image URL, for fuzzy name-based
 * matching and display. Rows with no product name (the field is missing
 * on this table, or just this row's catalog link is empty) are dropped
 * rather than surfaced as unmatchable -- an empty result means the table
 * doesn't support name-based search at all, not "no products in this
 * shipment".
 *
 * @param {string} tableName - The Airtable shipment table name.
 * @returns {Promise<{shipment: string, items: Array<{sku: string,
 *   productName: string, quantity: number | null, imageUrl: string |
 *   null}>}>}
 */
async function fetchProductNamesForTable(tableName) {
    const items = [];

    await base(tableName)
        .select({
            fields: ['SKU', PRODUCT_NAME_FIELD, 'Labels', PRODUCT_IMAGE_FIELD],
        })
        .eachPage((records, fetchNextPage) => {
            for (const record of records) {
                const sku = record.get('SKU');
                const nameLookup = record.get(PRODUCT_NAME_FIELD);
                const hasName = Array.isArray(nameLookup) &&
                    nameLookup.length > 0;
                const productName = hasName ? nameLookup[0] : null;

                if (!sku || !productName) {
                    continue;
                }

                const quantity = record.get('Labels');
                const imageLookup = record.get(PRODUCT_IMAGE_FIELD);
                const hasImage = Array.isArray(imageLookup) &&
                    imageLookup.length > 0;
                const imageUrl = hasImage
                    ? pickThumbnailUrl(imageLookup[0])
                    : null;

                items.push({
                    sku,
                    productName,
                    quantity: Number.isFinite(quantity) ? quantity : null,
                    imageUrl,
                });
            }
            fetchNextPage();
        });

    return { shipment: tableName, items };
}

/**
 * Samples one record's createdTime as a proxy for "when was this
 * shipment set up" -- used to break ties when more than one shipment
 * table matches a name query (a table's own name never includes a year,
 * but a record's createdTime does).
 *
 * @param {string} tableName - The Airtable shipment table name.
 * @returns {Promise<Date | null>} The sampled createdTime, or null for
 *   an empty table.
 */
async function getTableCreatedTime(tableName) {
    const records = await base(tableName).select({ maxRecords: 1 }).firstPage();
    if (records.length === 0) {
        return null;
    }
    return new Date(records[0]._rawJson.createdTime);
}

// CLI entry point (`node fetch_remaining_labels.js`); no-op when
// required as a module.
if (require.main === module) {
    fetchRemainingLabels()
        .then((payload) => {
            console.log(JSON.stringify(payload, null, 2));
        })
        .catch((error) => {
            console.error(
                'Failed to fetch remaining labels from Airtable:',
                error.message
            );
            process.exit(1);
        });
}

module.exports = {
    fetchRemainingLabels,
    fetchRemainingLabelsForTable,
    fetchLabelsBySkuForTable,
    fetchProductNamesForTable,
    fetchNotCheckedInForTable,
    getTableCreatedTime,
    describeAirtableError,
};
