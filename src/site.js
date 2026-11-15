// src/site.js
//
// Serves the web page and its config. Mounted BEFORE the API-key check, because a browser has no
// key when it first asks for the page. Everything in public/ is world-readable: never put a
// secret in that folder.

const path = require('path');
const express = require('express');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function mountSite(app, { publicKey }) {
    // The page learns its (low-privilege) key here, so the key never has to be committed.
    app.get('/config.js', (req, res) => {
        const config = JSON.stringify({ publicKey: publicKey || null })
            .replace(/</g, '\\u003c'); // can never close a <script> tag
        res.set('Cache-Control', 'no-store');
        res.type('application/javascript').send(`window.__CONFIG__ = ${config};\n`);
    });

    // Static files from public/ only (dotfiles are ignored by default). Anything that is not a
    // file there falls through to the API-key check and the normal 401 / 404 behaviour.
    app.use(express.static(PUBLIC_DIR, { index: 'index.html', dotfiles: 'ignore', maxAge: 0 }));
}

module.exports = { mountSite };