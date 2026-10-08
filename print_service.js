/**
 * @module print_service
 * HTTP client for the RPi print server's /print and /dry-print routes.
 */
const PRINT_SERVER_URL = process.env.PRINT_SERVER_URL;
const PRINT_SERVER_API_KEY = process.env.PRINT_SERVER_API_KEY;

if (!PRINT_SERVER_URL || !PRINT_SERVER_API_KEY) {
    console.error(
        'Missing PRINT_SERVER_URL or PRINT_SERVER_API_KEY. ' +
        'Set them in .env (see .env.example).'
    );
    process.exit(1);
}

// Items pass straight through -- the print server only cares about
// sku/quantity, not which shipment they came from.
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
        throw new Error(
            `Could not reach print server at ${PRINT_SERVER_URL}: ${detail}`
        );
    }

    const body = await response.json().catch(() => ({}));

    // Response body is the print automation's own internal output, not
    // surfaced to callers beyond the error case.
    if (!response.ok) {
        throw new Error(
            body.error || `Print server returned HTTP ${response.status}`
        );
    }
}

/**
 * Sends labels to the physical printer. Cannot be undone once accepted.
 *
 * @param {Array<{sku: string, quantity: number}>} items - Labels to print.
 * @returns {Promise<void>}
 */
function submitPrintJob(items) {
    return postPrintJob('/print', items);
}

/**
 * Downloads the label PDFs without sending them to a physical printer.
 *
 * @param {Array<{sku: string, quantity: number}>} items - Labels to
 *   generate.
 * @returns {Promise<void>}
 */
function submitTestPrintJob(items) {
    return postPrintJob('/dry-print', items);
}

module.exports = { submitPrintJob, submitTestPrintJob };
