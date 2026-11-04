const crypto = require('crypto');

const sha256 = (value) => crypto.createHash('sha256').update(value).digest();

function keysMatch(provided, expected) {
    return crypto.timingSafeEqual(sha256(provided), sha256(expected));
}
function verifyApiKey(apiKey) {
    return (req, res, next) => {
        const currentKey = req.headers['x-api-key'];
        if (!currentKey || typeof currentKey !== 'string' || !keysMatch(currentKey, apiKey)) {
            return res.status(401).json({ error: 'Unauthorised entry' });
        }
        next();
    }
}

module.exports = verifyApiKey;