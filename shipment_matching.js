/**
 * @module shipment_matching
 * LLM fallback for fuzzy shipment-table-name matching, used only when
 * exact token matching (in airtable/shipment_lookup.js) finds nothing.
 */
const { Anthropic } = require("@anthropic-ai/sdk");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!ANTHROPIC_API_KEY) {
    console.error(
        'Missing ANTHROPIC_API_KEY environment variable. ' +
        'Set it in .env (see .env.example).'
    );
    process.exit(1);
}

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// Asks for every plausible match rather than one pick -- "Oct 2" and
// "October 2" are different real shipments, not two spellings of one.
const SYSTEM_PROMPT = (
    `You match a warehouse worker's shipment reference against a list ` +
    `of real shipment table names from an Airtable base, then call ` +
    `match_shipment_name with your answer.\n\n` +
    `Shipment tables are named "<Month> <Day> Shipment", e.g. "Sept 10 ` +
    `Shipment", "October 2 Shipment", "August 21 Shipment" -- month ` +
    `names appear in a mix of abbreviated and full forms inconsistently, ` +
    `and there is no year in the name at all. The query may use a ` +
    `different abbreviation, a different date format, or casual ` +
    `phrasing for the same shipment.\n\n` +
    `Return every table name that's a plausible interpretation of the ` +
    `query -- including more than one when the query is genuinely ` +
    `ambiguous between two real tables (e.g. "oct 2" plausibly means ` +
    `both "Oct 2 Shipment" and "October 2 Shipment" if both exist -- ` +
    `return both; a separate process picks between them, that is not ` +
    `your job here). Only return names that actually appear in the ` +
    `given list, copied exactly. Zero matches is correct when nothing ` +
    `in the list plausibly fits -- never guess or invent a name.`
);

const tool = {
    name: "match_shipment_name",
    description: "Match a shipment reference against real shipment table names",
    input_schema: {
        type: "object",
        properties: {
            matches: {
                type: "array",
                description: (
                    "Table names that plausibly match the query, copied " +
                    "exactly from the given list. Can be empty, one, or " +
                    "more than one."
                ),
                items: { type: "string" }
            }
        },
        required: ["matches"]
    }
};

/**
 * Matches a shipment reference against real shipment table names via an
 * LLM call.
 *
 * @param {string} query - The user's shipment reference (e.g. "oct 2").
 * @param {string[]} tableNames - Real shipment table names to match
 *   against.
 * @returns {Promise<{matches: string[]} | {error: true}>} Plausible
 *   matches (callers must still cross-check these against the real
 *   table list -- the model is only asked, not guaranteed, to echo back
 *   given names), or `{error: true}` if the API call itself failed.
 */
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
            console.error(
                'Shipment name matching failed: invalid or missing ' +
                'ANTHROPIC_API_KEY.',
                error.message
            );
        } else if (error instanceof Anthropic.RateLimitError) {
            console.error(
                'Shipment name matching failed: rate limited by the ' +
                'Anthropic API.',
                error.message
            );
        } else if (error instanceof Anthropic.APIError) {
            console.error(
                `Shipment name matching failed: Anthropic API error ` +
                `(${error.status}).`,
                error.message
            );
        } else {
            console.error('Shipment name matching failed:', error.message);
        }
        return { error: true };
    }

    const output = claude_response.content[0].input;
    return { matches: output.matches || [] };
}

module.exports = { matchShipmentName };
