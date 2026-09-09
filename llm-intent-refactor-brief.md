# Refactor: Make intent parsing pluggable (rule-based ↔ LLM-based)

## Context
`warehouse-slack-bot` currently uses a single rule-based intent parser (`INTENT_RULES`, keyword-group matching in `intent_parser.js`). We're adding an LLM-based parser (Claude API, forced tool use via a `classify_intent` tool) as a second, swappable implementation, selected at runtime via an `INTENT_PARSER` env var (`rule_based` | `llm_based`).

## The problem this refactor solves
The rule-based parser isn't just a classifier — it also acts as a **phrasing gatekeeper**. Because a message only reaches an intent like `print_specific_skus` after matching required keyword groups (e.g. "print" + "sku(s)"), the downstream handler functions (e.g. `parseSkuPrintCommand`) were written assuming a fairly rigid phrasing shape, and extract fields like SKU codes or shipment names via **regex** against the raw message text.

The LLM parser breaks that assumption: it can correctly classify intent from arbitrary phrasing the regex was never designed to parse (e.g. "hey can you get SKU ABC123 printed, it's for the shipment we started today"). If the LLM path reuses the same regex-based extraction, it will misparse or fail on inputs the classifier itself handled correctly.

## The fix
Have the LLM extract structured entities in the **same tool call** that does classification, so regex is never involved on the LLM path. Refactor downstream handlers to accept **already-extracted structured data**, not raw text — so both parser paths can call the same shared handler functions.

### Updated `classify_intent` tool schema (LLM path)
```javascript
{
  name: "classify_intent",
  description: "Classify a warehouse Slack message and extract any relevant entities",
  input_schema: {
    type: "object",
    properties: {
      intent: {
        type: "string",
        enum: [...INTENT_RULES.map(rule => rule.intent), 'unknown']
      },
      skus: {
        type: "array",
        items: { type: "string" },
        description: "SKU identifiers mentioned in the message, if any"
      },
      shipment_ref: {
        type: "string",
        description: "Shipment name or identifier mentioned, if any (e.g. 'August 21 Shipment', 'current')"
      },
      confidence: { type: "number" }
    },
    required: ["intent", "confidence"]
  }
}
```
Note: the `enum` is derived directly from `INTENT_RULES` (plus an `'unknown'` fallback) so the two implementations' intent vocabularies can't drift apart as rules are added.

## Required refactor steps

1. **Extract a shared handler signature.** Identify each existing handler function currently coupled to regex-parsed text (e.g. `handlePrintSpecificSkus`, `parseSkuPrintCommand`, any handler for `print_remaining_labels`, `query_shipment_status`, etc.). Refactor each to accept a plain structured object instead of raw text — e.g. `handlePrintSpecificSkus({ skus, shipmentRef })` instead of `handlePrintSpecificSkus(text)`.

2. **Keep the rule-based path's own extraction logic intact**, but have it produce the same structured shape as its final output — i.e. the regex extraction still happens, but its result is passed into the new shared handler signature rather than the handler doing regex internally.

3. **Wire the LLM path** to pass its tool-call output (`skus`, `shipment_ref`) directly into the same shared handlers — no regex involved on this path at all.

4. **Preserve the pluggable parser architecture already in place**: both `rule_based.js` and `llm_based.js` should continue to live behind the same `intent_parser/index.js` factory (selected via `INTENT_PARSER` env var), each ultimately producing a common shape (e.g. `{ intent, skus?, shipmentRef?, confidence? }`) that the rest of the bot (`slack_bot.js`) consumes identically regardless of which parser produced it.

5. **Validate extracted values before acting, regardless of parser.** Since this is a physical-action pipeline (real print jobs, real labels), add validation after extraction — e.g. confirm `skus` match the real SKU format from the Airtable base ("Shipment Workflow", `app5sCWXMPQpuJodj`), confirm `shipmentRef` resolves to an actual shipment table — before any print-triggering call reaches `rpi-job-scheduler`. This applies to both parser paths, but is more load-bearing on the LLM path since its input phrasing is unconstrained.

## Non-goals / things NOT to change
- Don't touch the rule-based `INTENT_RULES` matching logic itself (order-sensitive comment blocks explain deliberate rule precedence — preserve as-is).
- Don't introduce a `tool_result` round-trip or multi-turn conversation with Claude — the LLM's role is strictly single-call classification + extraction. All decision logic and action-taking after that point stays in our own code (if/else or lookup-table dispatch on `intent`).
- Don't change the Express (`rpi-job-scheduler`) side of the pipeline — this refactor is scoped entirely to `warehouse-slack-bot`'s intent-parsing layer.

## Goal end-state
Two interchangeable intent parser implementations, selected via `.env`, both producing a shared output shape, both feeding the same downstream handler functions — with zero regex dependency on the LLM path, and validation as a shared safety net before any physical print action is triggered.
