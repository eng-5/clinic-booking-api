const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');


exports.getSlots = catchAsync(async (req, res, next) => {
    res.status(200).json({ status: 'success' })
})