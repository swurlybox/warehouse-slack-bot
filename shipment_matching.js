const { Anthropic } = require("@anthropic-ai/sdk");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!ANTHROPIC_API_KEY) {
    console.error('Missing ANTHROPIC_API_KEY environment variable. Set it in .env (see .env.example).');
    process.exit(1);
}

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

/* A fallback for when shipment_lookup.js's cheap token match finds nothing
    -- shipment table names mix abbreviated and full month names
    inconsistently (e.g. "Oct 2 Shipment" vs. "October 2 Shipment" are
    genuinely different shipments, not the same one written two ways), so
    a plain abbreviation-expansion map would risk resolving to the wrong
    actual shipment. This asks the model for every plausible
    interpretation rather than picking one itself -- including more than
    one when the query is genuinely ambiguous between two real tables --
    and leaves picking a single winner to shipment_lookup.js's own
    recency tie-break (findShipmentTable's pickNewestTable), which has a
    real signal (a record's createdTime, which carries the actual year)
    that this model call has no way to know. */
const SYSTEM_PROMPT = `You match a warehouse worker's shipment reference against a list of real shipment table names from an Airtable base, then call match_shipment_name with your answer.

Shipment tables are named "<Month> <Day> Shipment", e.g. "Sept 10 Shipment", "October 2 Shipment", "August 21 Shipment" -- month names appear in a mix of abbreviated and full forms inconsistently, and there is no year in the name at all. The query may use a different abbreviation, a different date format, or casual phrasing for the same shipment.

Return every table name that's a plausible interpretation of the query -- including more than one when the query is genuinely ambiguous between two real tables (e.g. "oct 2" plausibly means both "Oct 2 Shipment" and "October 2 Shipment" if both exist -- return both; a separate process picks between them, that is not your job here). Only return names that actually appear in the given list, copied exactly. Zero matches is correct when nothing in the list plausibly fits -- never guess or invent a name.`;

const tool = {
    name: "match_shipment_name",
    description: "Match a shipment reference against real shipment table names",
    input_schema: {
        type: "object",
        properties: {
            matches: {
                type: "array",
                description: "Table names that plausibly match the query, copied exactly from the given list. Can be empty, one, or more than one.",
                items: { type: "string" }
            }
        },
        required: ["matches"]
    }
};

/* Returns { matches: string[] } (possibly empty -- a genuine "nothing
    plausible" result, not a failure) on success, or { error: true } if
    the API call itself didn't complete -- same split as
    product_matching.js's rankProductMatches. Callers must still
    cross-check returned names against the real table list before trusting
    them (see shipment_lookup.js's findShipmentTable) -- this function
    asks the model to only echo back given names, but that's a prompt
    instruction, not a guarantee. */
async function matchShipmentName(query, tableNames) {
    let claude_response;
    try {
        claude_response = await client.messages.create({
            model: "claude-haiku-4-5",
            max_tokens: 1024,
            system: SYSTEM_PROMPT,
            tools: [tool],
            tool_choice: { type: "tool", name: "match_shipment_name" },
            messages: [
                {
                    role: "user",
                    content: JSON.stringify({ query, tableNames }),
                }
            ]
        });
    } catch (error) {
        if (error instanceof Anthropic.AuthenticationError) {
            console.error('Shipment name matching failed: invalid or missing ANTHROPIC_API_KEY.', error.message);
        } else if (error instanceof Anthropic.RateLimitError) {
            console.error('Shipment name matching failed: rate limited by the Anthropic API.', error.message);
        } else if (error instanceof Anthropic.APIError) {
            console.error(`Shipment name matching failed: Anthropic API error (${error.status}).`, error.message);
        } else {
            console.error('Shipment name matching failed:', error.message);
        }
        return { error: true };
    }

    const output = claude_response.content[0].input;
    return { matches: output.matches || [] };
}

module.exports = { matchShipmentName };
