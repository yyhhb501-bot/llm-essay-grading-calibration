"""
calibration/metrics.py
Evaluation metrics for essay scoring: Quadratic Weighted Kappa (QWK), MAE, RMSE, Pearson r, and consistency metrics.
"""

import numpy as np
from sklearn.metrics import cohen_kappa_score, mean_absolute_error, mean_squared_error


def quadratic_weighted_kappa(y_true, y_pred, min_rating=45.0, max_rating=95.0, num_bins=6):
    """
    Compute Quadratic Weighted Kappa (QWK) on ratings.
    Discretizes continuous 100-point essay scores into 6 standard civil-service tier bins
    (e.g., D / C / B- / B+ / A / A+) as standard in Automated Essay Scoring (AES) research.
    """
    y_true = np.asarray(y_true, dtype=float)
    y_pred = np.asarray(y_pred, dtype=float)
    
    # Clip to valid range
    y_true = np.clip(y_true, min_rating, max_rating)
    y_pred = np.clip(y_pred, min_rating, max_rating)
    
    # Bin continuous scores into discrete ordinal categories
    bins = np.linspace(min_rating, max_rating, num_bins + 1)
    binned_true = np.digitize(y_true, bins) - 1
    binned_pred = np.digitize(y_pred, bins) - 1
    
    # Bound to [0, num_bins - 1]
    binned_true = np.clip(binned_true, 0, num_bins - 1)
    binned_pred = np.clip(binned_pred, 0, num_bins - 1)
    
    return float(cohen_kappa_score(binned_true, binned_pred, weights="quadratic"))


def compute_all_metrics(y_true, y_pred):
    """
    Compute MAE, RMSE, Pearson r, and QWK.
    """
    y_true = np.asarray(y_true, dtype=float)
    y_pred = np.asarray(y_pred, dtype=float)
    
    mae = float(mean_absolute_error(y_true, y_pred))
    rmse = float(np.sqrt(mean_squared_error(y_true, y_pred)))
    
    # Pearson r
    if np.std(y_true) > 1e-8 and np.std(y_pred) > 1e-8:
        r = float(np.corrcoef(y_true, y_pred)[0, 1])
    else:
        r = 0.0
        
    qwk = quadratic_weighted_kappa(y_true, y_pred)
    
    return {
        "mae": round(mae, 2),
        "rmse": round(rmse, 2),
        "pearson_r": round(r, 3),
        "qwk": round(qwk, 3)
    }


def compute_score_consistency(repeated_scores):
    """
    Compute consistency across repeated evaluations of identical essays.
    repeated_scores: array of shape (N_samples, N_repetitions)
    Returns:
      - mean_variance: average variance across repetitions
      - mean_std: average standard deviation across repetitions
      - max_spread: average (max - min) score swing across repetitions
    """
    scores = np.asarray(repeated_scores, dtype=float)
    variances = np.var(scores, axis=1, ddof=1)
    stds = np.std(scores, axis=1, ddof=1)
    spreads = np.max(scores, axis=1) - np.min(scores, axis=1)
    
    return {
        "mean_variance": float(np.mean(variances)),
        "mean_std": float(np.mean(stds)),
        "mean_spread": float(np.mean(spreads))
    }
