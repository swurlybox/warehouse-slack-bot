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
                description: "SKU identifiers mentioned in the message, if any"
            },
            shipment_ref: { type: "string", description: "Explicit shipment identifier if mentioned, else omit" },
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
