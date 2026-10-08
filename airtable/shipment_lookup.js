/**
 * @module airtable/shipment_lookup
 * Resolves a user's shipment reference to a real Airtable table name:
 * exact token match, LLM fuzzy fallback, and recency tie-break on
 * ambiguous matches.
 */
require('dotenv').config();
const {
    fetchRemainingLabelsForTable,
    fetchNotCheckedInForTable,
    getTableCreatedTime,
    describeAirtableError,
} = require('./fetch_remaining_labels');
const { matchShipmentName } = require('../shipment_matching');

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID || 'app5sCWXMPQpuJodj';
const AIRTABLE_META_URL = (
    `https://api.airtable.com/v0/meta/bases/${AIRTABLE_BASE_ID}/tables`
);

if (!AIRTABLE_API_KEY) {
    console.error(
        'Missing AIRTABLE_API_KEY environment variable. ' +
        'Set it in .env (see .env.example).'
    );
    process.exit(1);
}

// Command verbs/filler stripped before matching against table names.
// Deliberately includes "current" -- there is no default shipment, so a
// pure-filler message must reduce to zero tokens, not a bogus name.
const STOPWORDS = new Set([
    'shipment', 'shipments', 'the', 'a', 'an', 'for', 'of', 'in', 'on',
    'status', 'check', 'query', 'lookup', 'find', 'show', 'about', 'me',
    'please', 'whats', 'what', 'is', 'are', 's',
    'print', 'printing', 'remaining', 'left', 'outstanding', 'unprinted',
    'label', 'labels', 'current', 'send', 'sending', 'printer', 'to',
    'test', 'dry',
]);

function tokenize(text) {
    return text.toLowerCase().match(/[a-z0-9]+/g) || [];
}

// Strips Slack's "<@USERID>" @-mention markup so the bot's own mentioned
// ID doesn't become a required token.
function stripSlackMentions(text) {
    return text.replace(/<@[^>]+>/g, ' ');
}

/**
 * Lists every shipment table in the base (name ending in "Shipment"),
 * via Airtable's metadata API rather than a hardcoded list, since new
 * tables are added regularly.
 *
 * @returns {Promise<Array<{id: string, name: string}>>} Table names,
 *   from the ({@link
 *   https://airtable.com/developers/web/api/list-tables|list-tables})
 *   endpoint.
 */
async function listShipmentTables() {
    const response = await fetch(AIRTABLE_META_URL, {
        headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` },
    });

    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
        const detail = body.error?.message || `HTTP ${response.status}`;
        throw new Error(`Could not list Airtable tables: ${detail}`);
    }

    return body.tables
        .filter((table) => /shipment$/i.test(table.name.trim()))
        .map((table) => ({ id: table.id, name: table.name }));
}

function extractShipmentQueryTokens(text) {
    return tokenize(stripSlackMentions(text))
        .filter((token) => !STOPWORDS.has(token));
}

// Real SKUs never contain quotes/parens -- also guards against breaking
// out of an Airtable filterByFormula string literal.
const SKU_TOKEN_PATTERN = /^[A-Za-z0-9._-]+$/;

// Left out of STOPWORDS so isAllShipmentsQuery can still see these.
const ALL_SHIPMENTS_WORDS = new Set(['all', 'every', 'everything']);

/**
 * Checks whether a message is asking about every shipment rather than
 * naming one.
 *
 * @param {string} text - The message text.
 * @returns {boolean} True if every meaningful word is an "all
 *   shipments" word.
 */
function isAllShipmentsQuery(text) {
    const tokens = extractShipmentQueryTokens(text);
    return tokens.length > 0 &&
        tokens.every((token) => ALL_SHIPMENTS_WORDS.has(token));
}

// Keeps a sequential all-shipments query under Airtable's 5 req/sec limit.
const AIRTABLE_MIN_REQUEST_INTERVAL_MS = 220;

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Breaks a tie between candidate tables by sampled record creation time
// (a table's own name never carries a year). A candidate with no usable
// signal sorts last rather than aborting the comparison.
async function pickNewestTable(tables) {
    let newest = null;
    let newestTime = -Infinity;

    for (const table of tables) {
        let createdTime = null;
        try {
            createdTime = await getTableCreatedTime(table.name);
        } catch (error) {
            console.error(
                `Failed to check creation time for "${table.name}":`,
                error.message
            );
        }

        const time = createdTime ? createdTime.getTime() : -Infinity;
        if (time > newestTime) {
            newestTime = time;
            newest = table;
        }
        await delay(AIRTABLE_MIN_REQUEST_INTERVAL_MS);
    }

    return newest;
}

function buildDisambiguationNote(matches, winner) {
    const names = matches.map((table) => `"${table.name}"`).join(', ');
    return (
        `Multiple shipments matched: ${names}. ` +
        `Using the most recent: "${winner.name}".`
    );
}

/**
 * Resolves a user's shipment reference to a real Airtable table. Tries
 * an exact token match first (cheap, no LLM call); falls back to an LLM
 * fuzzy match only if that finds nothing. Multiple matches from either
 * path are resolved by recency rather than asking the user to
 * disambiguate.
 *
 * @param {string} text - The user's shipment reference (e.g. "sept 10",
 *   "current").
 * @returns {Promise<{status: 'ok', table: {id: string, name: string},
 *   note?: string} | {status: 'ambiguous', matches: Array<{id: string,
 *   name: string}>} | {status: 'not_found', queryTokens: string[]}>}
 */
async function findShipmentTable(text) {
    const queryTokens = extractShipmentQueryTokens(text);
    const tables = await listShipmentTables();

    let matches = queryTokens.length > 0
        ? tables.filter((table) => {
            const tableTokens = tokenize(table.name);
            return queryTokens.every((token) => tableTokens.includes(token));
        })
        : [];

    // Gated on queryTokens, not raw text, so a pure-filler message
    // (e.g. "current") still resolves to 'not_found' with no LLM call.
    if (matches.length === 0 && queryTokens.length > 0) {
        const tableNames = tables.map((table) => table.name);
        const ranked = await matchShipmentName(text, tableNames);
        if (!ranked.error && ranked.matches.length > 0) {
            const byName = new Map(
                tables.map((table) => [table.name.toLowerCase(), table])
            );
            matches = ranked.matches
                .map((name) => byName.get((name || '').toLowerCase()))
                .filter(Boolean);
        }
    }

    if (matches.length === 0) {
        return { status: 'not_found', queryTokens };
    }
    if (matches.length === 1) {
        return { status: 'ok', table: matches[0] };
    }

    const winner = await pickNewestTable(matches);
    if (!winner) {
        return { status: 'ambiguous', matches };
    }
    return {
        status: 'ok',
        table: winner,
        note: buildDisambiguationNote(matches, winner),
    };
}

/**
 * Fetches remaining-label and not-checked-in counts for every known
 * shipment table, one at a time. A single table failing doesn't abort
 * the rest. The not-checked-in count catches shipments that have some
 * rows checked in (even fully printed) but others individually not -- a
 * distinction invisible to the remaining-labels filter alone.
 *
 * @returns {Promise<Array<{shipment: string, items: Array<{sku: string,
 *   quantity: number}> | null, notCheckedInCount: number | null, error:
 *   string | null}>>} `notCheckedInCount`/`items` are null (not zero) on
 *   a schema-drift table or a transient failure -- treat null as
 *   "unknown".
 */
async function fetchRemainingLabelsForAllShipments() {
    const tables = await listShipmentTables();
    const results = [];

    for (const table of tables) {
        let payload;
        try {
            payload = await fetchRemainingLabelsForTable(table.name);
        } catch (error) {
            results.push({
                shipment: table.name,
                items: null,
                notCheckedInCount: null,
                error: describeAirtableError(error),
            });
            await delay(AIRTABLE_MIN_REQUEST_INTERVAL_MS);
            continue;
        }
        await delay(AIRTABLE_MIN_REQUEST_INTERVAL_MS);

        let notCheckedInCount = null;
        try {
            const notCheckedIn = await fetchNotCheckedInForTable(table.name);
            notCheckedInCount = notCheckedIn.items
                ? notCheckedIn.items.length
                : null;
        } catch (error) {
            console.error(
                `Failed to check not-checked-in SKUs for "${table.name}":`,
                error.message
            );
        }
        await delay(AIRTABLE_MIN_REQUEST_INTERVAL_MS);

        results.push({
            shipment: payload.shipment,
            items: payload.items,
            notCheckedInCount,
            error: null,
        });
    }

    return results;
}

module.exports = {
    listShipmentTables,
    findShipmentTable,
    isAllShipmentsQuery,
    fetchRemainingLabelsForAllShipments,
    SKU_TOKEN_PATTERN,
};
