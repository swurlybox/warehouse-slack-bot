const PRINT_SERVER_URL = process.env.PRINT_SERVER_URL;
const PRINT_SERVER_API_KEY = process.env.PRINT_SERVER_API_KEY;

if (!PRINT_SERVER_URL || !PRINT_SERVER_API_KEY) {
    console.error('Missing PRINT_SERVER_URL or PRINT_SERVER_API_KEY. Set them in .env (see .env.example).');
    process.exit(1);
}

/* Posts { sku, quantity } items to the given RPi print server route. That
    route only cares about sku/quantity -- not which shipment they came from
    -- so callers pass the items array straight through, not the
    { shipment, items } wrapper Airtable data comes back in. Throws with a
    descriptive message on any failure (network or non-2xx) so callers can
    relay something useful back to Slack. */
async function postPrintJob(path, items) {
    let response;
    try {
        response = await fetch(`${PRINT_SERVER_URL}${path}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${PRINT_SERVER_API_KEY}`,
            },
            body: JSON.stringify(items),
        });
    } catch (error) {
        const detail = error.cause?.message || error.message;
        throw new Error(`Could not reach print server at ${PRINT_SERVER_URL}: ${detail}`);
    }

    const body = await response.json().catch(() => ({}));

    /* Deliberately not returned to callers beyond this point: the response
        body is the print automation's own machine-readable output, which
        can change shape independently of this bot. Callers should only
        need to know whether the job was accepted, not parse its internals. */
    if (!response.ok) {
        throw new Error(body.error || `Print server returned HTTP ${response.status}`);
    }
}

/* Sends labels to the PHYSICAL printer. Cannot be undone once accepted --
    callers should confirm with the user before calling this. */
function submitPrintJob(items) {
    return postPrintJob('/print', items);
}

/* Dry run: downloads the label PDFs but never sends them to a physical
    printer. Safe to call without any confirmation step. */
function submitTestPrintJob(items) {
    return postPrintJob('/dry-print', items);
}

module.exports = { submitPrintJob, submitTestPrintJob };
