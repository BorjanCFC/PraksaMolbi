// Middleware za proverka dali studentot e najavен
exports.isAuthenticated = (req, res, next) => {
  if (req.session && req.session.studentId) {
    return next();
  }
  req.flash('error', 'Ве молиме најавете се.');
  res.redirect('/login');
};
