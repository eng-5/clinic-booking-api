// src/routes/slotsRouter.js
const express = require('express');
const slotsController = require('../controllers/slotsController');

module.exports = ({ pool, clock }) => {
    const router = express.Router();
    const { getSlots } = slotsController({ pool, clock });

    router.get('/', getSlots); // Level 1: list slots

    return router;
}