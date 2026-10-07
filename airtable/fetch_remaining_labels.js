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

/* Mirrors fetchRemainingLabelsForTable's shape but for rows that haven't
    been checked in yet -- used by status_handlers.js to flag SKUs still
    missing from the warehouse floor, as a bucket separate from "needs a
    label printed" (checking in and printing are different steps, and a row
    can be behind on either one independently). Some older shipment tables
    (e.g. "Oct 2 Shipment") predate the Checked In field entirely and use a
    different STATUS field instead -- Airtable throws a structured
    UNKNOWN_FIELD_NAME error when filterByFormula references a field the
    table doesn't have. Unlike referencing an unknown field in a `fields:`
    selection list (which Airtable rejects as UNKNOWN_FIELD_NAME), a missing
    field inside filterByFormula comes back as INVALID_FILTER_BY_FORMULA
    with a message naming the field -- caught here and reported back as
    `unsupported: true` rather than letting it bubble up as a generic fetch
    error, so callers can skip the bucket with a note instead of failing
    the whole status command over it. */
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
        if (error.error === 'INVALID_FILTER_BY_FORMULA' && /unknown field names/i.test(error.message)) {
            return { shipment: tableName, items: null, unsupported: true };
        }
        throw error;
    }

    return { shipment: tableName, items, unsupported: false };
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

/* Same lookup pattern as PRODUCT_NAME_FIELD (pulled in from the master
    catalog table's own Image attachment field), with the same caveats --
    missing entirely on a handful of older shipment tables, and a
    multipleLookupValues field, so it comes back as an array of Airtable
    attachment objects (each with .url and .thumbnails.{small,large,full}.url)
    even though there's normally just one. */
const PRODUCT_IMAGE_FIELD = 'Image，图片 (from Product Name Lookup)';

/* An attachment's own `url` is a full-resolution original (e.g. 1500px on
    the long edge) -- too large for a quick visual check in a Slack
    thumbnail and wasteful to transfer for that purpose. `large` (~512px)
    is plenty to confirm "does this look like the right product" at a
    glance; falls back down the chain for an attachment missing that
    particular thumbnail size rather than showing nothing. */
function pickThumbnailUrl(attachment) {
    return attachment?.thumbnails?.large?.url || attachment?.thumbnails?.small?.url || attachment?.url || null;
}

/* Fetches every SKU in a shipment table paired with its human-readable
    product name, default print quantity, and a thumbnail image URL, for
    fuzzy name-based matching and display (see
    handlers/print_handlers.js's resolveProductNameMatches and
    formatProductCandidateList). Labels and the image come along for free
    -- the table is already being fully paginated for name-matching, so
    there's no extra request for either. Deliberately still doesn't fetch
    Label Printed/Checked In here -- that data (and the authoritative
    quantity, re-checked in case anything changed) gets fetched fresh via
    fetchLabelsBySkuForTable once the user actually picks a SKU, the same
    as any other targeted-SKU print; the quantity shown here is only ever
    a preview.
    Rows with no name at all -- the field is missing on this table
    entirely, or just this row's catalog link isn't populated -- are
    dropped rather than surfaced as an unmatchable candidate. If every row
    comes back empty, the table simply doesn't support name-based search;
    callers should treat that as a distinct case; it's not "no products in
    this shipment". A row missing a valid Labels value or an image still
    counts as a candidate (quantity/imageUrl come back null) -- those are
    purely display gaps, not a reason to exclude it from matching. */
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
                const productName = Array.isArray(nameLookup) && nameLookup.length > 0 ? nameLookup[0] : null;

                if (!sku || !productName) {
                    continue;
                }

                const quantity = record.get('Labels');
                const imageLookup = record.get(PRODUCT_IMAGE_FIELD);
                const imageUrl = Array.isArray(imageLookup) && imageLookup.length > 0 ? pickThumbnailUrl(imageLookup[0]) : null;

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

/* Returns the createdTime (a Date) of an arbitrary record in the table, as
    a cheap proxy for "when was this shipment set up" -- used by
    shipment_lookup.js to break ties when more than one shipment table
    matches a name query. Airtable's metadata API doesn't expose a
    table-level creation date at all; a record's own createdTime is the
    closest real signal available, and unlike a shipment table's name
    (which never includes a year, e.g. "Oct 2 Shipment"), it carries the
    actual year -- which is exactly what distinguishes two same-looking
    shipment names from different years. Returns null for an empty table
    (nothing to sample). */
async function getTableCreatedTime(tableName) {
    const records = await base(tableName).select({ maxRecords: 1 }).firstPage();
    if (records.length === 0) {
        return null;
    }
    return new Date(records[0]._rawJson.createdTime);
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

module.exports = { fetchRemainingLabels, fetchRemainingLabelsForTable, fetchLabelsBySkuForTable, fetchProductNamesForTable, fetchNotCheckedInForTable, getTableCreatedTime };
