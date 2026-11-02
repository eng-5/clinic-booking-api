function verifyApiKey(req, res, next) {
    const apiKey = process.env.API_KEY;
    const currentKey = req.headers['x-api-key'];
    if (!currentKey || currentKey !== apiKey) {
        return res.status(401).json({ error: 'UnAuthorised entry' });
    }
    next();
}

module.exports = verifyApiKey;