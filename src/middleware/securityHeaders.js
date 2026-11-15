// src/middleware/securityHeaders.js
//
// Tells the browser to load ONLY the page's own files. If someone ever managed to inject markup
// into the page, the browser would refuse to run their script or send data to another site.
// No 'unsafe-inline' anywhere: the page keeps its JavaScript and CSS in separate files.

const POLICY = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
].join('; ');

module.exports = (req, res, next) => {
    res.set('Content-Security-Policy', POLICY);
    res.set('X-Content-Type-Options', 'nosniff'); // don't guess a file's type
    res.set('Referrer-Policy', 'no-referrer');
    next();
};