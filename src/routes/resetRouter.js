const express = require('express');
const router = express.Router();
const { resetAllSlots } = require('../controllers/resetController');

router.post('/', resetAllSlots);

// POST
// /reset
// Level 1 · Replace all slots


module.exports = router;