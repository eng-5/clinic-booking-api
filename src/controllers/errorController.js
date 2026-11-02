// controllers/errorController.js

module.exports = (err, req, res, next) => {
    // if (err.name === 'ValidationError') {
    //     err.statusCode = 400;
    //     err.message = Object.values(err.errors).map(e => e.message).join(', ')
    //     err.status = 'fail'
    // }
    // if (err.name === 'CastError') {
    //     err.statusCode = 400;
    //     err.status = 'fail';
    //     err.message = `Invalid ${err.path}: ${err.value}`;
    // }
    // req.log.error(err.stack);
    err.statusCode = err.statusCode || 500;
    err.status = err.status || 'error';

    res.status(err.statusCode).json({
        error: err,
    })
}