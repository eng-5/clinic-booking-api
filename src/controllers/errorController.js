// src/controllers/errorController.js
//
// The one place where every failure becomes {"error": "<message>"}.
// Rules:
//   - never mutate the error object
//   - only trust a status that is an integer from 400 to 599, otherwise 500
//   - 5xx: log the real error server-side, tell the client nothing specific
//   - 4xx: the message is intentional (AppError, body-parser), so the client sees it
//   - body-parser messages can quote the client's input, so they get fixed wording

const CLIENT_MESSAGES = {
    'entity.parse.failed': 'invalid JSON body',
    'entity.too.large': 'request body too large',
};

function resolveStatus(err) {
    const candidate = err.statusCode ?? err.status;
    const valid = Number.isInteger(candidate) && candidate >= 400 && candidate <= 599;
    return valid ? candidate : 500;
}

function logServerError(err, req) {
    // pino-http attaches req.log (tagged with the request id). Fall back to console
    // so this handler can never crash because a logger is missing.
    if (req && req.log && typeof req.log.error === 'function') {
        req.log.error({ err }, 'unhandled error');
    } else {
        console.error('unhandled error', err);
    }
}

// Express only treats a function as an error handler if it declares all four parameters.
module.exports = (err, req, res, next) => {
    // If a response has already started we can't write another one. Let Express finish it.
    if (res.headersSent) return next(err);

    const status = resolveStatus(err);
    let message;

    if (status >= 500) {
        logServerError(err, req);
        message = 'internal server error';
    } else {
        message =
            CLIENT_MESSAGES[err.type] ||
            (typeof err.message === 'string' && err.message) ||
            'request failed';
    }

    res.status(status).json({ error: message });
};