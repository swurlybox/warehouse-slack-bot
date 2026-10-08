/**
 * @module intent_parser
 * LLM-based intent classification and entity extraction (shipment name,
 * SKUs, product query) for every incoming Slack message, via one forced
 * tool call to Claude.
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

// LLM-only classification (a rule-based alternative existed and was
// removed -- it didn't scale to structured per-item data like per-SKU
// quantities).
const KNOWN_INTENTS = [
    'print_remaining_labels',
    'test_print_remaining_labels',
    'print_specific_skus',
    'test_print_specific_skus',
    'print_by_product_name',
    'test_print_by_product_name',
    'query_shipment_status',
    'help',
];

// Spelled out with worked examples (not just field descriptions) because
// the model, given only the bare schema, would sometimes fold a
// message's leading SKU into shipment_ref instead of extracting the
// real shipment name.
const SYSTEM_PROMPT = (
    `You classify Slack messages for a warehouse shipment-label ` +
    `printing bot. Every message is one worker's request; call ` +
    `classify_intent with your answer.\n\n` +

    `Three kinds of things can appear in a message, and they never overlap:\n` +
    `- A SKU is a product identifier made of alphanumeric segments ` +
    `separated by dashes (e.g. "0F-CA35-B7BM", "NL-Y7SI-8FGG"). Put ` +
    `every SKU-shaped token in \`skus\`, never in \`shipment_ref\` -- ` +
    `even when the SKU is the first word of the sentence or reads as ` +
    `its grammatical subject. Example: "NL-Y7SI-8FGG needs a real ` +
    `print, it's from the sept 10 shipment" names exactly one SKU ` +
    `(NL-Y7SI-8FGG, goes in \`skus\`) and one shipment (sept 10, goes ` +
    `in \`shipment_ref\`) -- the SKU coming first in the sentence does ` +
    `not make it the shipment.\n` +
    `- A shipment reference is a shipment name, date, or the word ` +
    `"current" (e.g. "August 21 Shipment", "sept 10", "current") -- ` +
    `never a SKU-shaped token.\n` +
    `- A product-name query is a free-text description of a product ` +
    `in plain words (e.g. "kikkoman soy sauce", "the ginseng tea") -- ` +
    `not a SKU code and not a shipment name. Put it in \`product_query\`. ` +
    `Use it only when the message describes a product this way instead ` +
    `of quoting its exact SKU; the system looks up matching SKUs ` +
    `separately, so you don't need to (and can't) know the real SKU ` +
    `yourself here.\n\n` +

    `A message may also say how many labels to print for a given SKU ` +
    `(e.g. "print 5 of NL-Y7SI-8FGG", "NL-Y7SI-8FGG x3", "10 labels ` +
    `for NL-Y7SI-8FGG", "AV-4FL8-PKNH:20"). When it does, attach that ` +
    `number as \`quantity\` on that SKU's own entry in \`skus\` -- ` +
    `quantities are per-SKU, not a single number for the whole ` +
    `message, since a request can name several SKUs and only give a ` +
    `quantity for some of them. Never invent or default a quantity: ` +
    `omit the field entirely for a SKU the message doesn't give one ` +
    `for, and let the caller look up its normal quantity separately. ` +
    `This doesn't apply to \`product_query\` -- that field never ` +
    `carries a quantity itself (the system asks for one later, after ` +
    `the user picks a specific product).\n\n` +

    `Intent meanings:\n` +
    `- print_remaining_labels / test_print_remaining_labels: print or ` +
    `dry-run every still-unprinted label for ONE named shipment. Use ` +
    `ONLY when the message names no specific SKU and describes no ` +
    `product by name.\n` +
    `- print_specific_skus / test_print_specific_skus: print or ` +
    `dry-run specific, named SKU(s), regardless of their printed ` +
    `status. Use whenever the message names one or more SKUs by their ` +
    `exact code, even if it also mentions "remaining" or "left" in ` +
    `passing.\n` +
    `- print_by_product_name / test_print_by_product_name: print or ` +
    `dry-run a product the message describes by name/words rather ` +
    `than by exact SKU code (e.g. "print the kikkoman soy sauce from ` +
    `the sept 10 shipment"). Still requires a shipment reference, ` +
    `same as the other print intents. Extract only \`product_query\` ` +
    `and \`shipment_ref\` here -- never guess a SKU.\n` +
    `- query_shipment_status: read-only status check, for one ` +
    `shipment or all of them.\n` +
    `- help: asking what the bot can do.\n\n` +

    `Rule of thumb: an exact SKU code in the message means one of the ` +
    `*_specific_skus variants; a product described by name instead of ` +
    `its SKU means one of the *_by_product_name variants; neither ` +
    `means one of the *_remaining_labels variants. Never more than ` +
    `one of these three at once.`
);

const tool = {
    name: "classify_intent",
    description: "Classify a warehouse Slack message into a known print intent",
    input_schema: {
        type: "object",
        properties: {
            intent: {
                type: "string",
                enum: [...KNOWN_INTENTS, 'unknown']
            },
            skus: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        sku: {
                            type: "string",
                            description: (
                                "A dash-separated alphanumeric product " +
                                "code (e.g. \"0F-CA35-B7BM\"). Never put " +
                                "one of these in shipment_ref below, " +
                                "even if it appears earlier in the " +
                                "sentence than the shipment name."
                            )
                        },
                        quantity: {
                            type: "integer",
                            description: (
                                "How many labels to print for this SKU, " +
                                "only if the message states one for it " +
                                "(e.g. \"print 5 of SKU X\", \"SKU X " +
                                "x3\"). Omit when the message doesn't " +
                                "give a quantity for this SKU -- never " +
                                "guess or default one."
                            )
                        }
                    },
                    required: ["sku"]
                },
                description: (
                    "SKUs mentioned in the message, if any, each with " +
                    "an optional per-SKU print quantity."
                )
            },
            shipment_ref: {
                type: "string",
                // "all" is spelled out explicitly rather than an
                // omitted field, since downstream code
                // (isAllShipmentsQuery) checks this field's content,
                // not its presence.
                description: (
                    "Explicit shipment identifier if one specific " +
                    "shipment is named (e.g. 'August 21 Shipment', " +
                    "'current'). If the user is asking about every " +
                    "shipment rather than naming one, set this to " +
                    "\"all\" instead of omitting it. Omit only when " +
                    "neither applies."
                )
            },
            product_query: {
                type: "string",
                description: (
                    "Free-text product description (e.g. \"kikkoman " +
                    "soy sauce\"), only for print_by_product_name/" +
                    "test_print_by_product_name -- the message names a " +
                    "product by words rather than its exact SKU code. " +
                    "Omit for every other intent."
                )
            },
            confidence: { type: "number" }
        },
        required: ["intent", "confidence"]
    }
};

/**
 * Classifies a Slack message's intent and extracts its entities via an
 * LLM call.
 *
 * @param {string} text - The incoming message text.
 * @returns {Promise<{intent: string, skus?: Array<{sku: string,
 *   quantity?: number}>, shipmentRef?: string, productQuery?: string,
 *   confidence?: number}>} The classification. `intent: 'unknown'` is
 *   an expected result for an unparseable message, not a failure.
 *   `intent: 'parser_error'` means the API call itself didn't complete
 *   (network error, rate limit, bad key) -- distinct from `'unknown'`
 *   so callers can tell "couldn't understand you" apart from
 *   "something's actually broken right now".
 */
async function parseIntent(text) {
    let claude_response;
    try {
        claude_response = await client.messages.create({
            model: "claude-haiku-4-5",
            max_tokens: 1024,
            system: SYSTEM_PROMPT,
            tools: [tool],
            tool_choice: { type: "tool", name: "classify_intent"},
            messages: [
                {
                    role: "user",
                    content: `${text}`,
                }
            ]
        });
    } catch (error) {
        // Most-specific-first, per the SDK's typed exception classes --
        // distinguishes causes in the logs even though the user-facing
        // result is the same.
        if (error instanceof Anthropic.AuthenticationError) {
            console.error(
                'Intent classification failed: invalid or missing ' +
                'ANTHROPIC_API_KEY.',
                error.message
            );
        } else if (error instanceof Anthropic.RateLimitError) {
            console.error(
                'Intent classification failed: rate limited by the ' +
                'Anthropic API.',
                error.message
            );
        } else if (error instanceof Anthropic.APIError) {
            console.error(
                `Intent classification failed: Anthropic API error ` +
                `(${error.status}).`,
                error.message
            );
        } else {
            console.error('Intent classification failed:', error.message);
        }
        return { intent: 'parser_error' };
    }

    const output = claude_response.content[0].input;
    return {
        intent: output.intent,
        skus: output.skus,
        shipmentRef: output.shipment_ref,
        productQuery: output.product_query,
        confidence: output.confidence,
    };
}

const SHIPMENT_ID_PATTERN = /shipment\s*#?\s*([a-z0-9-]+)/i;

/**
 * Extracts an explicit shipment ID (e.g. "shipment 0842") via regex,
 * independent of LLM classification. Currently only used for
 * diagnostic logging alongside `parseIntent`'s own `shipmentRef`, not
 * as a fallback.
 *
 * @param {string} text - The incoming message text.
 * @returns {string | null} The matched ID, or null if no explicit
 *   shipment ID was named.
 */
function extractShipmentId(text) {
    const match = text.match(SHIPMENT_ID_PATTERN);
    return match ? match[1] : null;
}

module.exports = { parseIntent, extractShipmentId };
