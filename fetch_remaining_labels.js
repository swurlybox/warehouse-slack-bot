require('dotenv').config();
const Airtable = require('airtable');

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID || 'app5sCWXMPQpuJodj';
const SHIPMENT_TABLE = 'Next Shipment';

if (!AIRTABLE_API_KEY) {
    console.error('Missing AIRTABLE_API_KEY environment variable. Set it in .env (see .env.example).');
    process.exit(1);
}

const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);

/* Queries the current in-progress shipment table for rows still needing labels
    printed and maps them into the { shipment, items: [{ sku, quantity }] }
    payload shape the print endpoint expects. `quantity` comes straight from
    the Labels formula field (ASINS/Case x Cases) -- already computed. */
async function fetchRemainingLabels() {
    const items = [];

    await base(SHIPMENT_TABLE)
        .select({
            filterByFormula: 'NOT({Label Printed})',
            fields: ['SKU', 'Labels'],
        })
        .eachPage((records, fetchNextPage) => {
            for (const record of records) {
                const sku = record.get('SKU');
                const quantity = record.get('Labels');

                if (!sku || !Number.isFinite(quantity)) {
                    console.warn(`Skipping record ${record.id}: missing SKU or Labels value.`);
                    continue;
                }

                items.push({ sku, quantity });
            }
            fetchNextPage();
        });

    return { shipment: SHIPMENT_TABLE, items };
}

/* Only run as a CLI script when invoked directly (`node fetch_remaining_labels.js`
    or `npm run fetch-remaining-labels`) -- when required as a module (e.g. by
    slack_bot.js) this just exports the function below. */
if (require.main === module) {
    fetchRemainingLabels()
        .then((payload) => {
            console.log(JSON.stringify(payload, null, 2));
        })
        .catch((error) => {
            console.error('Failed to fetch remaining labels from Airtable:', error.message);
            process.exit(1);
        });
}

module.exports = { fetchRemainingLabels };
