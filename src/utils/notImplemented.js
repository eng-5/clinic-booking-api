// src/utils/notImplemented.js
//
// Placeholder for handlers that are not built yet. A handler that never responds makes a
// request hang until the test timeout (30 seconds). Answering 501 makes an unfinished
// feature fail fast with a clear message, so a red test is readable.
// Each milestone replaces one of these stubs with the real handler.

module.exports = (req, res) => res.status(501).json({ error: 'not implemented' });