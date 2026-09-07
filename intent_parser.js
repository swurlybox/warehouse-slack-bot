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

function tokenize(text) {
    return text.toLowerCase().match(/[a-z0-9]+/g) || [];
}

/* Returns { intent }. 'unknown' is an explicit, expected result -- not a
    failure -- for any message that doesn't satisfy a full rule; callers
    should reply with example usage rather than failing silently. */
function parseIntent(text) {
    const tokens = tokenize(text);

    for (const rule of INTENT_RULES) {
        const matchesEveryGroup = rule.groups.every((group) =>
            group.some((word) => tokens.includes(word))
        );

        if (matchesEveryGroup) {
            return { intent: rule.intent };
        }
    }

    return { intent: 'unknown' };
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
