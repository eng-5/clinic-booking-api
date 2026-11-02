const express = require('express');
const router = express.Router();
const { getSlots } = require('../controllers/slotsController');

router.get('/', getSlots)
// GET
// /slots
// Level 1 · List slots

module.exports = router;