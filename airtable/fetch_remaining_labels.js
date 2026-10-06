require('dotenv').config();
const Airtable = require('airtable');

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID || 'app5sCWXMPQpuJodj';
const SHIPMENT_TABLE = 'Next Shipment';

if (!AIRTABLE_API_KEY) {
    console.error('Missing AIRTABLE_API_KEY environment variable. Set it in .env (see .env.example).');
    process.exit(1);
}

const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);

/* Queries the given shipment table for rows still needing labels printed and
    maps them into the { shipment, items: [{ sku, quantity }] } payload shape
    the print endpoint expects. `quantity` comes straight from the Labels
    formula field (ASINS/Case x Cases) -- already computed. Every shipment
    table (past or "Next Shipment") shares this same SKU/Labels/Label Printed
    layout, so one function serves all of them. */
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
                    console.warn(`Skipping record ${record.id}: missing SKU or Labels value.`);
                    continue;
                }

                items.push({ sku, quantity });
            }
            fetchNextPage();
        });

    return { shipment: tableName, items };
}

function fetchRemainingLabels() {
    return fetchRemainingLabelsForTable(SHIPMENT_TABLE);
}

/* Looks up specific SKUs within a shipment table by exact name match
    (case-insensitively -- Airtable's own SKU casing is the source of truth,
    but callers (e.g. the LLM intent parser) may echo back whatever casing
    the user actually typed, which is often lowercase in casual chat),
    regardless of Label Printed / Checked In status -- used for targeted
    reprints, where the whole point is printing something outside the normal
    remaining-labels filter (e.g. a damaged label). Callers are expected to
    have already validated `skus` against SKU_TOKEN_PATTERN (shipment_lookup.js)
    before this builds a filterByFormula out of them. Returns one result per
    requested SKU: either its quantity plus flags for whether it's already
    been printed / not yet checked in, or { notFound: true } if no row in the
    table matches that SKU at all. */
async function fetchLabelsBySkuForTable(tableName, skus) {
    const uniqueSkus = [...new Set(skus)];
    const formula = `OR(${uniqueSkus.map((sku) => `LOWER({SKU}) = LOWER("${sku}")`).join(', ')})`;
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
                    console.warn(`Skipping record ${record.id}: missing SKU or Labels value.`);
                    continue;
                }

                /* Keyed by uppercase, not the raw stored value, so the
                    lookup below matches regardless of which casing the
                    request came in with -- the formula match is already
                    case-insensitive, but this Map lookup is a separate,
                    local case-sensitive comparison that needs the same
                    normalization or the formula fix alone doesn't help. */
                found.set(sku.toUpperCase(), {
                    sku,
                    quantity,
                    alreadyPrinted: Boolean(record.get('Label Printed')),
                    notCheckedIn: !record.get('Checked In'),
                });
            }
            fetchNextPage();
        });

    const results = uniqueSkus.map((sku) => found.get(sku.toUpperCase()) || { sku, notFound: true });
    return { shipment: tableName, results };
}

/* The field holding a row's human-readable product name -- a lookup tied
    to the master product catalog table (`Imported Data images, pack size
    and FNSKU copy`), hence the "2" (there's an unused "1" counterpart from
    an earlier lookup setup). Not every shipment table has this field --
    a handful of older tables (e.g. "March 28 Shipment") predate it
    entirely -- and it's a multipleLookupValues field, so Airtable always
    returns it as an array even though the link is to one record. */
const PRODUCT_NAME_FIELD = 'Name. 名字. Nombre. 2';

/* Fetches every SKU in a shipment table paired with its human-readable
    product name, for fuzzy name-based matching (see
    handlers/print_handlers.js's resolveProductNameMatches). Deliberately
    doesn't fetch Labels/Label Printed/Checked In here -- once the user
    picks a specific SKU from the ranked candidates this surfaces, that
    data gets fetched fresh via fetchLabelsBySkuForTable, the same as any
    other targeted-SKU print, so this stays a light, name-only lookup.
    Rows with no name at all -- the field is missing on this table
    entirely, or just this row's catalog link isn't populated -- are
    dropped rather than surfaced as an unmatchable candidate. If every row
    comes back empty, the table simply doesn't support name-based search;
    callers should treat that as a distinct case; it's not "no products in
    this shipment". */
async function fetchProductNamesForTable(tableName) {
    const items = [];

    await base(tableName)
        .select({
            fields: ['SKU', PRODUCT_NAME_FIELD],
        })
        .eachPage((records, fetchNextPage) => {
            for (const record of records) {
                const sku = record.get('SKU');
                const nameLookup = record.get(PRODUCT_NAME_FIELD);
                const productName = Array.isArray(nameLookup) && nameLookup.length > 0 ? nameLookup[0] : null;

                if (!sku || !productName) {
                    continue;
                }

                items.push({ sku, productName });
            }
            fetchNextPage();
        });

    return { shipment: tableName, items };
}

/* Only run as a CLI script when invoked directly (`node fetch_remaining_labels.js`
    or `npm run fetch-remaining-labels`) -- when required as a module (e.g. by
    slack_bot.js) this just exports the function below. */
if (require.main === module) {
    fetchRemainingLabels()
        .then((payload) => {
            console.log(JSON.stringify(payload, null, 2));
        })
        .catch((error) => {
            console.error('Failed to fetch remaining labels from Airtable:', error.message);
            process.exit(1);
        });
}

module.exports = { fetchRemainingLabels, fetchRemainingLabelsForTable, fetchLabelsBySkuForTable, fetchProductNamesForTable };
