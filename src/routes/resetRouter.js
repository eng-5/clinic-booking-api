// src/routes/resetRouter.js
const express = require('express');
const resetController = require('../controllers/resetController');

module.exports = ({ pool, clock }) => {
    const router = express.Router();
    const { resetAllSlots } = resetController({ pool, clock });

    router.post('/', resetAllSlots); // Level 1: replace all slots

    return router;
};