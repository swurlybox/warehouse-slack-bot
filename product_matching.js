/**
 * @module product_matching
 * LLM-based ranking of a shipment's product rows against a free-text
 * product-name query (e.g. "the kikkoman soy sauce").
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

// Separate from intent_parser.js's classification call -- runs after
// the shipment is resolved, once the real candidate list is known.
const SYSTEM_PROMPT = (
    `You match a warehouse worker's free-text product description ` +
    `against a list of real candidate products from one shipment, ` +
    `then call rank_product_matches with your answer.\n\n` +
    `Match on every detail the query actually gives, not just the ` +
    `general product category. If the query names a brand (e.g. ` +
    `"kikkoman"), only candidates from that same brand count -- a ` +
    `different brand's product in the same category (e.g. a different ` +
    `soy sauce brand, when the query said "kikkoman soy sauce") is NOT ` +
    `a match, even to round out the list. The same goes for any other ` +
    `specific detail the query states (flavor, size, variant): treat ` +
    `it as a real constraint, not a suggestion. A vague query with no ` +
    `such details (e.g. just "soy sauce") can match broadly across ` +
    `brands -- the precision required scales with how specific the ` +
    `query actually was.\n\n` +
    `Zero matches is a correct answer when nothing plausible exists ` +
    `in the given candidates. Never pad the list with weaker guesses ` +
    `just to reach a particular count -- a shorter, precise list beats ` +
    `a fuller, loose one.`
);

const tool = {
    name: "rank_product_matches",
    description: (
        "Rank candidate products against a free-text product description"
    ),
    input_schema: {
        type: "object",
        properties: {
            matches: {
                type: "array",
                description: (
                    "Up to 10 candidates that plausibly match the " +
                    "query, best match first. Fewer than 10 -- " +
                    "including zero -- is expected and correct when " +
                    "that's all that plausibly matches."
                ),
                items: {
                    type: "object",
                    properties: {
                        sku: {
                            type: "string",
                            description: (
                                "Must be copied exactly, verbatim, " +
                                "from one of the candidate SKUs given " +
                                "-- never a SKU that wasn't in the " +
                                "candidate list."
                            )
                        },
                        confidence: {
                            type: "number",
                            description: "0 to 1."
                        }
                    },
                    required: ["sku", "confidence"]
                },
                maxItems: 10
            }
        },
        required: ["matches"]
    }
};

/**
 * Ranks a shipment's product candidates against a free-text product
 * description via an LLM call.
 *
 * @param {string} query - The user's product description (e.g. "the
 *   kikkoman soy sauce").
 * @param {Array<{sku: string, productName: string}>} candidates -
 *   Candidate products from one shipment.
 * @returns {Promise<{matches: Array<{sku: string, confidence: number}>}
 *   | {error: true}>} Ranked matches, best first (callers must still
 *   re-validate returned SKUs against the real candidate list -- this
 *   is model output reaching a physical-print pipeline), or `{error:
 *   true}` if the API call itself failed.
 */
async function rankProductMatches(query, candidates) {
    let claude_response;
    try {
        claude_response = await client.messages.create({
            model: "claude-haiku-4-5",
            max_tokens: 1024,
            system: SYSTEM_PROMPT,
            tools: [tool],
            tool_choice: { type: "tool", name: "rank_product_matches" },
            messages: [
                {
                    role: "user",
                    content: JSON.stringify({
                        query,
                        candidates: candidates.map(({ sku, productName }) => {
                            return { sku, productName };
                        }),
                    }),
                }
            ]
        });
    } catch (error) {
        if (error instanceof Anthropic.AuthenticationError) {
            console.error(
                'Product match ranking failed: invalid or missing ' +
                'ANTHROPIC_API_KEY.',
                error.message
            );
        } else if (error instanceof Anthropic.RateLimitError) {
            console.error(
                'Product match ranking failed: rate limited by the ' +
                'Anthropic API.',
                error.message
            );
        } else if (error instanceof Anthropic.APIError) {
            console.error(
                `Product match ranking failed: Anthropic API error ` +
                `(${error.status}).`,
                error.message
            );
        } else {
            console.error('Product match ranking failed:', error.message);
        }
        return { error: true };
    }

    const output = claude_response.content[0].input;
    return { matches: output.matches || [] };
}

module.exports = { rankProductMatches };
