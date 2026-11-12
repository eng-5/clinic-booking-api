// src/middleware/requireJson.js
const AppError = require('../utils/appError');

function requireJson(req, res, next) {
    // We only care about methods that actually send a request body (POST, PUT, PATCH)
    const methodsWithBodies = ['POST', 'PUT', 'PATCH'];

    if (methodsWithBodies.includes(req.method)) {
        const contentType = req.headers['content-type'];

        // Check if the header is missing or doesn't include 'application/json'
        if (!contentType || !contentType.includes('application/json')) {
            // If you want it to flow into your centralized error handler:
            return next(new AppError('Content-Type must be application/json', 400));
        }
    }

    next(); // Pass it along to the next middleware (like express.json())
}

module.exports = requireJson;