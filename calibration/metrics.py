"""Metrics on the documented 0-100 integer score scale; undefined statistics are null."""
import warnings
import numpy as np
from sklearn.metrics import cohen_kappa_score

def quadratic_weighted_kappa(y_true, y_pred):
    a, b = np.asarray(y_true, dtype=float), np.asarray(y_pred, dtype=float)
    if not len(a) or a.shape != b.shape or not np.isfinite(a).all() or not np.isfinite(b).all():
        raise ValueError("finite paired scores required")
    if np.any((a < 0) | (a > 100) | (b < 0) | (b > 100)):
        raise ValueError("score range is 0..100")
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        value = cohen_kappa_score(np.floor(a + .5).astype(int), np.floor(b + .5).astype(int),
                                 labels=list(range(101)), weights="quadratic")
    return float(value) if np.isfinite(value) else None

def compute_all_metrics(y_true, y_pred):
    a, b = np.asarray(y_true, dtype=float), np.asarray(y_pred, dtype=float)
    qwk = quadratic_weighted_kappa(a, b)
    r = float(np.corrcoef(a, b)[0, 1]) if len(a) > 1 and np.std(a) > 1e-8 and np.std(b) > 1e-8 else None
    return {"mae": float(np.mean(np.abs(a-b))), "rmse": float(np.sqrt(np.mean((a-b)**2))),
            "pearson_r": r, "qwk": qwk, "qwk_scale": "0-100, rounded half-up to integer"}

def compute_score_consistency(repeated_scores):
    scores = np.asarray(repeated_scores, dtype=float)
    if scores.ndim != 2 or scores.shape[1] < 2:
        return {"mean_variance": None, "mean_std": None, "mean_spread": None}
    if not np.isfinite(scores).all() or np.any((scores < 0) | (scores > 100)):
        raise ValueError("finite 0-100 scores required")
    return {"mean_variance": float(np.var(scores, axis=1, ddof=1).mean()),
            "mean_std": float(np.std(scores, axis=1, ddof=1).mean()),
            "mean_spread": float(np.ptp(scores, axis=1).mean())}
