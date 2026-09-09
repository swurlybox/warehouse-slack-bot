const { Anthropic } = require("@anthropic-ai/sdk");

const client = new Anthropic({
    apiKey: process.env["ANTHROPIC_API_KEY"],
});

/* Rule-based intent parsing: matches on action + scope + target keyword
    groups rather than an LLM call -- no API cost, predictable, and the
    command surface this bot handles is narrow enough that keyword rules
    are sufficient. Add a new command by adding another rule to
    INTENT_RULES; the first rule whose every group has at least one match
    wins. */
const INTENT_RULES = [
    /* Must come before 'print_remaining_labels' -- "test print remaining
        labels" satisfies that rule's groups too ('print' + a remaining-word
        + a label/shipment word are all present), so the more specific
        test/dry rule needs first look or it would never fire. */
    {
        intent: 'test_print_remaining_labels',
        groups: [
            ['test', 'dry'],
            ['print'],
            ['remaining', 'left', 'outstanding', 'unprinted'],
            ['label', 'labels', 'shipment', 'shipments'],
        ],
    },
    /* Listed before 'help' on purpose -- it requires every one of three
        groups to match, so it's the more specific rule and should get first
        look at a message that happens to contain "help" too (e.g. "can you
        help print the remaining labels"). This is the REAL print -- it
        actually sends labels to the physical printer. */
    {
        intent: 'print_remaining_labels',
        groups: [
            ['print'],
            ['remaining', 'left', 'outstanding', 'unprinted'],
            ['label', 'labels', 'shipment', 'shipments'],
        ],
    },
    /* Must come before 'print_specific_skus' for the same reason as
        test_print_remaining_labels above -- "test print sku X from Y
        shipment" satisfies that rule's groups too. No shipment-word group
        here on purpose: a message missing "from ... shipment" entirely
        (e.g. "test print sku X") should still reach this intent so
        parseSkuPrintCommand's own usage-error message fires, instead of
        falling all the way to the generic 'unknown' fallback just because
        the word "shipment" itself never appeared. */
    {
        intent: 'test_print_specific_skus',
        groups: [
            ['test', 'dry'],
            ['print'],
            ['sku', 'skus'],
        ],
    },
    /* A targeted reprint of specific SKUs (see slack_bot.js's
        handlePrintSpecificSkus) -- bypasses the unprinted/checked-in filter
        on purpose, since the point is reprinting something outside it (e.g.
        a damaged label). Doesn't overlap with print_remaining_labels above
        (no remaining/left/outstanding/unprinted word here), so order
        relative to that rule doesn't matter, only relative to its own test
        variant just above. Same no-shipment-word reasoning as that rule. */
    {
        intent: 'print_specific_skus',
        groups: [
            ['print'],
            ['sku', 'skus'],
        ],
    },
    /* Also listed before 'help' for the same reason -- "can you help check
        the status of the august 21 shipment" should resolve to this, not
        help. Doesn't require 'print' (or an authorized user) since it's
        read-only. */
    {
        intent: 'query_shipment_status',
        groups: [
            ['status', 'check', 'query', 'lookup', 'find'],
            ['shipment', 'shipments'],
        ],
    },
    {
        intent: 'help',
        groups: [['help', 'commands', 'usage']],
    },
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
                /* ... spread operator unpacks the array so no nested arrays happen. */
                enum: [...INTENT_RULES.map(rule => rule.intent), 'unknown']
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

function tokenize(text) {
    return text.toLowerCase().match(/[a-z0-9]+/g) || [];
}

/* Produces the same { skus?, shipmentRef? } shape the LLM path returns
    from its classify_intent tool call, but via the rule-based path's
    existing regex extraction -- so slack_bot.js's handlers can consume
    either path's output identically without knowing which one ran.
    Only the SKU-targeted intents need SKU parsing; the shipment-name-only
    intents just pass the raw message through as shipmentRef, since
    findShipmentTable's own stopword-stripping (shipment_lookup.js)
    already pulls the name out of it regardless of surrounding command
    phrasing -- no separate extraction step exists for those today. */
function extractRuleBasedEntities(intent, text) {
    if (intent === 'print_specific_skus' || intent === 'test_print_specific_skus') {
        /* Required lazily, not at module load, so classifying an intent
            that isn't SKU-specific (e.g. in a standalone unit test) never
            triggers shipment_lookup.js's own AIRTABLE_API_KEY check. */
        const { parseSkuPrintCommand } = require('./airtable/shipment_lookup');
        const parsed = parseSkuPrintCommand(text);
        return parsed ? { skus: parsed.skus, shipmentRef: parsed.shipmentQuery } : {};
    }

    if (intent === 'print_remaining_labels' || intent === 'test_print_remaining_labels' || intent === 'query_shipment_status') {
        return { shipmentRef: text };
    }

    return {};
}

/* Returns { intent, skus?, shipmentRef?, confidence? } -- the same shape
    regardless of which parser produced it, so callers never need to branch
    on INTENT_PARSER themselves. 'unknown' is an explicit, expected result
    -- not a failure -- for any message that doesn't satisfy a full rule (or
    that the LLM couldn't classify); callers should reply with example usage
    rather than failing silently. 'parser_error' is a different, genuine
    failure (the LLM call itself didn't complete) -- kept distinct from
    'unknown' so slack_bot.js can tell a user "I didn't catch a command"
    apart from "something's actually broken right now", instead of
    conflating an infrastructure failure with the user having typed
    something unparseable. The rule-based path has no equivalent failure
    mode -- it's pure local computation, nothing to catch. */
async function parseIntent(text) {
    if (process.env.INTENT_PARSER == "llm_based") {
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

    else {
        const tokens = tokenize(text);

        for (const rule of INTENT_RULES) {
            const matchesEveryGroup = rule.groups.every((group) =>
                group.some((word) => tokens.includes(word))
            );

            if (matchesEveryGroup) {
                return { intent: rule.intent, ...extractRuleBasedEntities(rule.intent, text) };
            }
        }

        return { intent: 'unknown' };
    }
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
