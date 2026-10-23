"""
calibration/models.py
Implementation of Ridge Regression and Gradient-Boosted Trees (GBDT) calibrators.
Supports prompt-split GroupKFold cross-validation, feature extraction, and JSON weight export.
"""

import json
import numpy as np
from sklearn.linear_model import Ridge
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import Pipeline


FEATURE_NAMES = [
    "raw_llm_score",
    "key_point_coverage",
    "dim_keypoints",
    "dim_logic",
    "dim_language",
    "dim_policy",
    "dim_format",
    "word_count",
    "type_guina",
    "type_zonghe",
    "type_duice",
    "type_gongwen",
    "type_wenzhang"
]


def extract_features(df):
    """
    Extract numerical feature matrix X and target y from DataFrame.
    """
    X = np.zeros((len(df), len(FEATURE_NAMES)), dtype=float)
    X[:, 0] = df["raw_llm_score"].values
    X[:, 1] = df["key_point_coverage"].values
    X[:, 2] = df["dim_keypoints"].values
    X[:, 3] = df["dim_logic"].values
    X[:, 4] = df["dim_language"].values
    X[:, 5] = df["dim_policy"].values
    X[:, 6] = df["dim_format"].values
    X[:, 7] = df["word_count"].values / 100.0  # scaled word count
    
    # One-hot encode question types
    qtypes = df["question_type"].values
    X[:, 8] = (qtypes == "归纳概括").astype(float)
    X[:, 9] = (qtypes == "综合分析").astype(float)
    X[:, 10] = (qtypes == "提出对策").astype(float)
    X[:, 11] = (qtypes == "公文写作").astype(float)
    X[:, 12] = (qtypes == "文章写作").astype(float)
    
    y = df["human_score"].values if "human_score" in df.columns else None
    groups = df["prompt_id"].values if "prompt_id" in df.columns else None
    
    return X, y, groups


class RidgeCalibrator:
    """
    Calibrator using Ridge Regression with feature normalization.
    """
    def __init__(self, alpha=10.0):
        self.alpha = alpha
        self.pipeline = Pipeline([
            ("scaler", StandardScaler()),
            ("ridge", Ridge(alpha=alpha, random_state=42))
        ])
        self.is_fitted = False
        
    def fit(self, X, y):
        self.pipeline.fit(X, y)
        self.is_fitted = True
        return self
        
    def predict(self, X):
        preds = self.pipeline.predict(X)
        return np.clip(preds, 0.0, 100.0)
    
    def get_coefficients(self):
        """
        Return dict of feature weights for inspection and JS export.
        """
        scaler = self.pipeline.named_steps["scaler"]
        ridge = self.pipeline.named_steps["ridge"]
        
        # Raw scale weights: w_raw = w_norm / std
        raw_weights = ridge.coef_ / scaler.scale_
        intercept = ridge.intercept_ - np.sum((ridge.coef_ * scaler.mean_) / scaler.scale_)
        
        weights_dict = {name: float(w) for name, w in zip(FEATURE_NAMES, raw_weights)}
        weights_dict["intercept"] = float(intercept)
        return weights_dict


class GBDTCalibrator:
    """
    Calibrator using Gradient-Boosted Trees (HistGradientBoostingRegressor).
    """
    def __init__(self, max_iter=120, max_depth=5, learning_rate=0.06, l2_regularization=2.0):
        self.model = HistGradientBoostingRegressor(
            max_iter=max_iter,
            max_depth=max_depth,
            learning_rate=learning_rate,
            l2_regularization=l2_regularization,
            random_state=42
        )
        self.is_fitted = False
        
    def fit(self, X, y):
        self.model.fit(X, y)
        self.is_fitted = True
        return self
        
    def predict(self, X):
        preds = self.model.predict(X)
        return np.clip(preds, 0.0, 100.0)


class EnsembleCalibrator:
    """
    Blends Ridge (robust linear bias correction) and GBDT (non-linear interactions).
    """
    def __init__(self, ridge_weight=0.55):
        self.ridge = RidgeCalibrator(alpha=12.0)
        self.gbdt = GBDTCalibrator(max_iter=100, learning_rate=0.05)
        self.ridge_weight = ridge_weight
        
    def fit(self, X, y):
        self.ridge.fit(X, y)
        self.gbdt.fit(X, y)
        return self
        
    def predict(self, X):
        p_ridge = self.ridge.predict(X)
        p_gbdt = self.gbdt.predict(X)
        blended = self.ridge_weight * p_ridge + (1.0 - self.ridge_weight) * p_gbdt
        return np.clip(blended, 0.0, 100.0)
