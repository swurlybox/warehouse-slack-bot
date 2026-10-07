require('dotenv').config();
const { fetchRemainingLabelsForTable, tableHasAnyCheckedIn, getTableCreatedTime, describeAirtableError } = require('./fetch_remaining_labels');
const { matchShipmentName } = require('../shipment_matching');

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID || 'app5sCWXMPQpuJodj';
const AIRTABLE_META_URL = `https://api.airtable.com/v0/meta/bases/${AIRTABLE_BASE_ID}/tables`;

if (!AIRTABLE_API_KEY) {
    console.error('Missing AIRTABLE_API_KEY environment variable. Set it in .env (see .env.example).');
    process.exit(1);
}

/* Command verbs and filler words stripped out before matching a user's
    message against table names -- whatever tokens are left over are treated
    as the shipment name they meant, regardless of where in the sentence they
    appeared (e.g. "check status for the next shipment" and "check the next
    shipment's status" both reduce to ["next"]). Covers both the read-only
    query command's verbs and the print command's, since callers reuse this
    for "print remaining labels for the <name> shipment" too -- a plain
    "print remaining labels for the current shipment" should reduce to no
    tokens at all (correctly failing to resolve to any shipment -- there is
    no default fallback), not a bogus name made of leftover command words. */
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

/* Slack renders an @-mention in message text as literal markup, e.g.
    "<@U0BTJ9R4TQT> check status of the shipment" -- strip it before
    tokenizing so the bot's own mentioned user ID doesn't become a required
    (and unmatchable) token in the query. */
function stripSlackMentions(text) {
    return text.replace(/<@[^>]+>/g, ' ');
}

/* Lists every table in the base whose name ends in "Shipment" -- this
    excludes unrelated tables (e.g. "Imported Data images, pack size and
    FNSKU copy"). Uses Airtable's metadata API instead of a hardcoded list
    since a new shipment table gets added roughly every couple weeks; this
    requires the API key to have the schema.bases:read scope. */
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
    return tokenize(stripSlackMentions(text)).filter((token) => !STOPWORDS.has(token));
}

/* Same character class as rpi-job-scheduler's validate_label_requests.js SKU
    check -- real SKUs never contain quotes or parens, so this doubles as a
    guard against building an Airtable filterByFormula out of anything that
    could break out of its string literal. */
const SKU_TOKEN_PATTERN = /^[A-Za-z0-9._-]+$/;

/* Deliberately left out of STOPWORDS above -- these words need to survive
    into the leftover token list so isAllShipmentsQuery can recognize them,
    rather than being silently discarded like other filler. */
const ALL_SHIPMENTS_WORDS = new Set(['all', 'every', 'everything']);

/* True when, once command filler is stripped, every word the user typed is
    an "all shipments" word and nothing else -- e.g. "check status of all
    shipments" or "check every shipment's status", but not "check status of
    all the august 21 shipment" (which still names one). */
function isAllShipmentsQuery(text) {
    const tokens = extractShipmentQueryTokens(text);
    return tokens.length > 0 && tokens.every((token) => ALL_SHIPMENTS_WORDS.has(token));
}

/* Airtable enforces 5 requests/sec per base; this keeps a sequential
    all-shipments query comfortably under that (~4.5 req/sec) instead of
    firing one request per table in parallel. The official `airtable` client
    already retries individual requests on HTTP 429 with backoff (see
    node_modules/airtable/lib/base.js), so this pacing is a first line of
    defense against tripping the limit at all, not the only protection. */
const AIRTABLE_MIN_REQUEST_INTERVAL_MS = 220;

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/* Picks the newest of several candidate tables by sampling one record's
    createdTime from each (see fetch_remaining_labels.js's
    getTableCreatedTime for why that's the signal used, not the table
    name). A candidate that errors or has no records at all sorts last
    rather than aborting the comparison -- one flaky lookup shouldn't break
    resolving an otherwise-clear winner. Returns null only if every
    candidate came back with no usable signal at all, in which case the
    caller falls back to asking the user to disambiguate. */
async function pickNewestTable(tables) {
    let newest = null;
    let newestTime = -Infinity;

    for (const table of tables) {
        let createdTime = null;
        try {
            createdTime = await getTableCreatedTime(table.name);
        } catch (error) {
            console.error(`Failed to check creation time for "${table.name}":`, error.message);
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
    return `Multiple shipments matched: ${names}. Using the most recent: "${winner.name}".`;
}

/* Matches the meaningful words left in the user's message against known
    shipment table names first, requiring every one of the user's words to
    appear somewhere in a table's name (e.g. ["august", "21"] matches
    "August 21 Shipment") -- cheap, deterministic, and handles the common
    well-formed case (e.g. "sept 10") for free, with no LLM call at all.
    Only if that finds nothing at all does it fall back to an LLM-based
    match (shipment_matching.js) over the same never-invent-a-name
    discipline used for SKU and product-name matching elsewhere in this
    bot -- shipment naming mixes abbreviated and full month names
    inconsistently, and (see "Oct 2 Shipment" vs. "October 2 Shipment")
    two genuinely different shipments can have confusingly similar names,
    so this needs real judgment rather than a hardcoded abbreviation map.
    Either path can turn up more than one plausible table; when it does,
    recency breaks the tie (pickNewestTable) instead of asking the user to
    disambiguate -- the returned 'ok' result carries a `note` in that case
    so callers can tell the user what was picked and why.
    Returns 'ok' (optionally with `note`), 'ambiguous' only if recency
    tie-break itself couldn't produce a winner (every candidate had no
    usable signal -- shouldn't normally happen), or 'not_found' when
    nothing matched either way. */
async function findShipmentTable(text) {
    const queryTokens = extractShipmentQueryTokens(text);
    const tables = await listShipmentTables();

    let matches = queryTokens.length > 0
        ? tables.filter((table) => {
            const tableTokens = tokenize(table.name);
            return queryTokens.every((token) => tableTokens.includes(token));
        })
        : [];

    /* Gated on queryTokens, not the raw text -- "current" (or any other
        pure-filler message) has non-empty raw text but zero meaningful
        tokens once STOPWORDS strips it, and must still resolve straight to
        'not_found' with no LLM call at all, exactly as before: there is
        deliberately no default shipment (see extractShipmentQueryTokens'
        own docstring above), and that has to hold regardless of which
        matching path is asked to resolve it. */
    if (matches.length === 0 && queryTokens.length > 0) {
        const ranked = await matchShipmentName(text, tables.map((table) => table.name));
        if (!ranked.error && ranked.matches.length > 0) {
            const byName = new Map(tables.map((table) => [table.name.toLowerCase(), table]));
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
    return { status: 'ok', table: winner, note: buildDisambiguationNote(matches, winner) };
}

/* Fetches remaining-label data for every known shipment table, one at a
    time. A single table failing (e.g. a transient Airtable error even after
    the client's own retries are exhausted) doesn't abort the rest -- it's
    recorded per-table so the caller can report partial results instead of
    an all-or-nothing failure.
    Also flags whether each table has had anything checked in at all
    (`hasAnyCheckedIn`) -- status_handlers.js uses this to distinguish a
    shipment that's genuinely fully printed from one that just hasn't been
    started yet, which otherwise look identical (both have zero rows
    matching the remaining-labels filter). Deliberately only checked for
    tables whose remaining-labels fetch above already succeeded: that
    success already confirms the Checked In field exists there, so a table
    with the schema-drift problem (missing that field entirely) already
    landed in the `error` branch and is skipped here rather than queried
    again for the same missing field. `hasAnyCheckedIn` stays null for
    those (and for any transient failure on this second check) -- callers
    should treat null as "unknown", not "nothing checked in". */
async function fetchRemainingLabelsForAllShipments() {
    const tables = await listShipmentTables();
    const results = [];

    for (const table of tables) {
        let payload;
        try {
            payload = await fetchRemainingLabelsForTable(table.name);
        } catch (error) {
            results.push({ shipment: table.name, items: null, hasAnyCheckedIn: null, error: describeAirtableError(error) });
            await delay(AIRTABLE_MIN_REQUEST_INTERVAL_MS);
            continue;
        }
        await delay(AIRTABLE_MIN_REQUEST_INTERVAL_MS);

        let hasAnyCheckedIn = null;
        try {
            hasAnyCheckedIn = (await tableHasAnyCheckedIn(table.name)).hasAny;
        } catch (error) {
            console.error(`Failed to check checked-in status for "${table.name}":`, error.message);
        }
        await delay(AIRTABLE_MIN_REQUEST_INTERVAL_MS);

        results.push({ shipment: payload.shipment, items: payload.items, hasAnyCheckedIn, error: null });
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
