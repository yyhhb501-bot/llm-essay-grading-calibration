// No verified human-labeled calibration model has been supplied.
// Replace only after reviewing training provenance and holdout results.
if (window.ScoreCalibrator) window.ScoreCalibrator.configure(null);
