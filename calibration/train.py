"""
calibration/train.py
Main training script: runs GroupKFold cross-validation by prompt_id to test generalization to unseen prompts.
Outputs MAE, RMSE, Pearson r, and QWK for Raw LLM, Ridge Regression, and GBDT.
Exports calibrated model weights to JSON for JavaScript and production inference.
"""

import os
import sys

PKG_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(PKG_DIR)
if ROOT_DIR not in sys.path:
    sys.path.insert(0, ROOT_DIR)

import json
import numpy as np
import pandas as pd
from sklearn.model_selection import GroupKFold

from calibration.dataset import get_benchmark_df
from calibration.models import (
    extract_features,
    FEATURE_NAMES,
    RidgeCalibrator,
    GBDTCalibrator,
    EnsembleCalibrator
)
from calibration.metrics import compute_all_metrics

WEIGHTS_PATH = os.path.join(os.path.dirname(__file__), "calibrator_weights.json")


def run_cross_validation(df, n_splits=5):
    """
    Evaluate Raw LLM vs. Ridge vs. GBDT vs. Ensemble using GroupKFold (split by prompt_id).
    """
    # Exclude samples with missing critical material (scores withheld by design)
    valid_df = df[df["critical_material_missing"] == 0].copy().reset_index(drop=True)
    
    X, y, groups = extract_features(valid_df)
    raw_scores = valid_df["raw_llm_score"].values
    
    gkf = GroupKFold(n_splits=n_splits)
    
    raw_preds = np.zeros(len(valid_df))
    ridge_preds = np.zeros(len(valid_df))
    gbdt_preds = np.zeros(len(valid_df))
    ensemble_preds = np.zeros(len(valid_df))
    
    for fold, (train_idx, test_idx) in enumerate(gkf.split(X, y, groups=groups)):
        X_train, y_train = X[train_idx], y[train_idx]
        X_test, y_test = X[test_idx], y[test_idx]
        
        # 1. Raw LLM
        raw_preds[test_idx] = raw_scores[test_idx]
        
        # 2. Ridge
        ridge = RidgeCalibrator(alpha=14.0).fit(X_train, y_train)
        ridge_preds[test_idx] = ridge.predict(X_test)
        
        # 3. GBDT
        gbdt = GBDTCalibrator(max_iter=100, learning_rate=0.05).fit(X_train, y_train)
        gbdt_preds[test_idx] = gbdt.predict(X_test)
        
        # 4. Ensemble
        ens = EnsembleCalibrator().fit(X_train, y_train)
        ensemble_preds[test_idx] = ens.predict(X_test)

    results = {
        "raw_llm": compute_all_metrics(y, raw_preds),
        "ridge": compute_all_metrics(y, ridge_preds),
        "gbdt": compute_all_metrics(y, gbdt_preds),
        "ensemble": compute_all_metrics(y, ensemble_preds)
    }
    
    return results, valid_df, X, y


def train_and_export():
    df = get_benchmark_df()
    print("=" * 65)
    print(" LLM Essay Grading & Score Calibration System - GroupKFold Benchmark")
    print(f" Total Samples: {len(df)} | Unseen Prompts: {df['prompt_id'].nunique()} | Splits: 5-fold (by prompt)")
    print("=" * 65)
    
    results, valid_df, X, y = run_cross_validation(df)
    
    print("\n[Cross-Validation Results on Unseen Prompts]:")
    print(f"{'Method':<22} | {'MAE (pts)':<10} | {'RMSE':<8} | {'Pearson r':<10} | {'QWK':<8}")
    print("-" * 65)
    for name, m in results.items():
        disp_name = {
            "raw_llm": "Raw LLM (Zero-Shot)",
            "ridge": "Ridge Regression",
            "gbdt": "Gradient-Boosted Trees",
            "ensemble": "Ensemble (Ridge+GBDT)"
        }[name]
        print(f"{disp_name:<22} | {m['mae']:<10} | {m['rmse']:<8} | {m['pearson_r']:<10} | {m['qwk']:<8}")
    print("-" * 65)
    
    # Train full model for weights export
    full_ridge = RidgeCalibrator(alpha=14.0).fit(X, y)
    weights = full_ridge.get_coefficients()
    
    export_data = {
        "feature_names": FEATURE_NAMES,
        "weights": weights,
        "metrics_summary": results,
        "metadata": {
            "total_samples": len(df),
            "valid_samples": len(valid_df),
            "num_prompts": int(df["prompt_id"].nunique()),
            "cv_strategy": "GroupKFold by prompt_id (generalization to unseen prompts)"
        }
    }
    
    with open(WEIGHTS_PATH, "w", encoding="utf-8") as f:
        json.dump(export_data, f, indent=2, ensure_ascii=False)
        
    print(f"\n[OK] Model weights and metadata exported to {WEIGHTS_PATH}")
    return results


if __name__ == "__main__":
    train_and_export()
