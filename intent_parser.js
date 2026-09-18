const { Anthropic } = require("@anthropic-ai/sdk");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!ANTHROPIC_API_KEY) {
    console.error('Missing ANTHROPIC_API_KEY environment variable. Set it in .env (see .env.example).');
    process.exit(1);
}

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

/* LLM-based intent classification: a forced tool call to Claude does both
    classification and entity extraction in one request. This used to be one
    of two swappable implementations (a keyword-matching rule-based path was
    the other), selected via an INTENT_PARSER env var. That path was removed
    -- its regex/keyword-group grammar didn't scale to structured per-item
    data (e.g. a SKU's requested print quantity), it doubled the design and
    testing work for every new command, and the one place determinism
    actually mattered for physical-print safety -- the confirm/cancel gate
    in handlers/print_confirmation.js -- runs before intent parsing even
    starts and never depended on which parser produced the pending print.
    The remaining cost of LLM-only classification is a hard dependency on
    ANTHROPIC_API_KEY and the Anthropic API being reachable; see
    parseIntent's 'parser_error' result for how that failure is surfaced. */
const KNOWN_INTENTS = [
    'print_remaining_labels',
    'test_print_remaining_labels',
    'print_specific_skus',
    'test_print_specific_skus',
    'query_shipment_status',
    'help',
];

/* Disambiguates two failure modes seen in live testing where the model,
    given only the bare schema below with no domain context, would get
    confused by a message that leads with a SKU as its grammatical subject
    (e.g. "NL-Y7SI-8FGG needs a real print, it's from the sept 10
    shipment"): sometimes classifying the whole message as
    print_remaining_labels (print EVERYTHING outstanding for a shipment --
    a much bigger physical-print action than the one SKU actually named),
    and sometimes classifying the intent correctly but duplicating the SKU
    into shipment_ref instead of extracting the real shipment name. Spelled
    out as an explicit system prompt (cheap, cacheable, and separate from
    the per-message user content) rather than folded into the tool's field
    descriptions alone, since this needs worked examples to reliably land,
    not just a one-line rule. */
const SYSTEM_PROMPT = `You classify Slack messages for a warehouse shipment-label printing bot. Every message is one worker's request; call classify_intent with your answer.

Two kinds of things can appear in a message, and they never overlap:
- A SKU is a product identifier made of alphanumeric segments separated by dashes (e.g. "0F-CA35-B7BM", "NL-Y7SI-8FGG"). Put every SKU-shaped token in \`skus\`, never in \`shipment_ref\` -- even when the SKU is the first word of the sentence or reads as its grammatical subject. Example: "NL-Y7SI-8FGG needs a real print, it's from the sept 10 shipment" names exactly one SKU (NL-Y7SI-8FGG, goes in \`skus\`) and one shipment (sept 10, goes in \`shipment_ref\`) -- the SKU coming first in the sentence does not make it the shipment.
- A shipment reference is a shipment name, date, or the word "current" (e.g. "August 21 Shipment", "sept 10", "current") -- never a SKU-shaped token.

Intent meanings:
- print_remaining_labels / test_print_remaining_labels: print or dry-run every still-unprinted label for ONE named shipment. Use ONLY when the message names no specific SKU.
- print_specific_skus / test_print_specific_skus: print or dry-run specific, named SKU(s), regardless of their printed status. Use whenever the message names one or more SKUs, even if it also mentions "remaining" or "left" in passing.
- query_shipment_status: read-only status check, for one shipment or all of them.
- help: asking what the bot can do.

Rule of thumb: if a message names any SKU at all, the intent is one of the *_specific_skus variants, never a *_remaining_labels variant.`;

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
                items: { type: "string" },
                description: "SKU identifiers mentioned in the message, if any -- dash-separated alphanumeric product codes (e.g. \"0F-CA35-B7BM\"). Never put one of these in shipment_ref below, even if it appears earlier in the sentence than the shipment name."
            },
            /* Downstream code (shipment_lookup.js's isAllShipmentsQuery) only
                recognizes an all-shipments request by finding a lone
                all/every/everything token in this field -- if the model just
                omitted shipment_ref for a request naming no single shipment
                (its natural reading of "if mentioned, else omit" below),
                that check silently misses and the request gets treated as
                an unresolved single-shipment name instead. Spelling out the
                all-shipments case explicitly keeps this a single string
                field rather than adding a second boolean the rest of the
                code would also have to check. */
            shipment_ref: {
                type: "string",
                description: "Explicit shipment identifier if one specific shipment is named (e.g. 'August 21 Shipment', 'current'). If the user is asking about every shipment rather than naming one, set this to \"all\" instead of omitting it. Omit only when neither applies."
            },
            confidence: { type: "number" }
        },
        required: ["intent", "confidence"]
    }
};

/* Returns { intent, skus?, shipmentRef?, confidence? }. 'unknown' is an
    explicit, expected result -- not a failure -- for any message the model
    couldn't classify; callers should reply with example usage rather than
    failing silently. 'parser_error' is a different, genuine failure (the
    API call itself didn't complete -- network error, rate limit, bad key)
    -- kept distinct from 'unknown' so slack_bot.js can tell a user "I
    didn't catch a command" apart from "something's actually broken right
    now", instead of conflating an infrastructure failure with the user
    having typed something unparseable. */
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
                    content: `${text}`, /* Slack message text */
                }
            ]
        });
    } catch (error) {
        /* Most-specific-first, per the SDK's typed exception classes --
            distinguishes retryable/operational causes in the logs even
            though the user-facing outcome (a 'parser_error' intent) is
            the same for all of them. */
        if (error instanceof Anthropic.AuthenticationError) {
            console.error('Intent classification failed: invalid or missing ANTHROPIC_API_KEY.', error.message);
        } else if (error instanceof Anthropic.RateLimitError) {
            console.error('Intent classification failed: rate limited by the Anthropic API.', error.message);
        } else if (error instanceof Anthropic.APIError) {
            console.error(`Intent classification failed: Anthropic API error (${error.status}).`, error.message);
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
        confidence: output.confidence,
    };
}

const SHIPMENT_ID_PATTERN = /shipment\s*#?\s*([a-z0-9-]+)/i;

/* Kept separate from intent matching on purpose: resolving "current
    shipment" and recognizing an explicit ID ("shipment 0842") are different
    concerns that will evolve independently. Returns the matched ID, or
    null when no explicit shipment was named -- callers currently fall back
    to "Next Shipment" in that case. */
function extractShipmentId(text) {
    const match = text.match(SHIPMENT_ID_PATTERN);
    return match ? match[1] : null;
}

module.exports = { parseIntent, extractShipmentId };
