/* Rule-based intent parsing: matches on action + scope + target keyword
    groups rather than an LLM call -- no API cost, predictable, and the
    command surface this bot handles is narrow enough that keyword rules
    are sufficient. Add a new command by adding another rule to
    INTENT_RULES; the first rule whose every group has at least one match
    wins. */
const INTENT_RULES = [
    /* Listed before 'help' on purpose -- it requires every one of three
        groups to match, so it's the more specific rule and should get first
        look at a message that happens to contain "help" too (e.g. "can you
        help print the remaining labels"). */
    {
        intent: 'print_remaining_labels',
        groups: [
            ['print'],
            ['remaining', 'left', 'outstanding', 'unprinted'],
            ['label', 'labels', 'shipment', 'shipments'],
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
