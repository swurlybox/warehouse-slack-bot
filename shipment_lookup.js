require('dotenv').config();

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
    shipment's status" both reduce to ["next"]). */
const STOPWORDS = new Set([
    'shipment', 'shipments', 'the', 'a', 'an', 'for', 'of', 'in', 'on',
    'status', 'check', 'query', 'lookup', 'find', 'show', 'about', 'me',
    'please', 'whats', 'what', 'is', 'are',
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

/* Matches the meaningful words left in the user's message against known
    shipment table names, requiring every one of the user's words to appear
    somewhere in a table's name (e.g. ["august", "21"] matches "August 21
    Shipment"). Returns 'ok' with a single table, 'ambiguous' with every
    table that matched, or 'not_found' when nothing did (including when the
    user gave no usable words at all, e.g. just "check shipment"). */
async function findShipmentTable(text) {
    const queryTokens = extractShipmentQueryTokens(text);
    if (queryTokens.length === 0) {
        return { status: 'not_found', queryTokens };
    }

    const tables = await listShipmentTables();
    const matches = tables.filter((table) => {
        const tableTokens = tokenize(table.name);
        return queryTokens.every((token) => tableTokens.includes(token));
    });

    if (matches.length === 1) {
        return { status: 'ok', table: matches[0] };
    }
    if (matches.length > 1) {
        return { status: 'ambiguous', matches };
    }
    return { status: 'not_found', queryTokens };
}

module.exports = { listShipmentTables, findShipmentTable };
