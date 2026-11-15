// src/middleware/internalAuth.js
//
// Who is calling? Two keys, two roles:
//   adminKey  -> req.role = 'admin'   everything (the key given to the graders)
//   publicKey -> req.role = 'public'  only what the web page needs (see requireAdmin)
// No key, or a key that matches neither, is 401.
//
// A browser cannot keep a secret: the public key is visible to anyone who opens the page. So
// the page's key is made LOW-PRIVILEGE instead of secret.

const crypto = require('crypto');

// Hash both sides first: timingSafeEqual needs equal lengths, and a hash is always 32 bytes.
const sha256 = (value) => crypto.createHash('sha256').update(value).digest();
const matches = (provided, expected) => crypto.timingSafeEqual(sha256(provided), sha256(expected));

function authenticate({ adminKey, publicKey }) {
    return (req, res, next) => {
        const provided = req.headers['x-api-key'];

        if (typeof provided === 'string' && provided !== '') {
            // Compute BOTH comparisons before deciding, so the time taken doesn't hint at which key matched.
            const isAdmin = matches(provided, adminKey);
            const isPublic = publicKey ? matches(provided, publicKey) : false;

            if (isAdmin) { req.role = 'admin'; return next(); }
            if (isPublic) { req.role = 'public'; return next(); }
        }
        return res.status(401).json({ error: 'Unauthorised entry' });
    };
}

module.exports = authenticate;