// src/utils/validate.js
const AppError = require('./appError');

// Parses `data` with a Zod schema. On failure it throws a 400 AppError carrying the first
// problem, for example "slots.0.start: Invalid ISO datetime". The error handler turns that
// into {"error": "..."}; handlers never build 400 responses by hand.
function parse(schema, data) {
    const result = schema.safeParse(data);
    if (result.success) return result.data;

    const issue = result.error.issues[0];
    const path = issue.path.join('.');
    throw new AppError(path ? `${path}: ${issue.message}` : issue.message, 400);
}

module.exports = { parse };
