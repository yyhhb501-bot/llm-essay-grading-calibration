"""
calibration/ablation.py
Feature ablation study: quantifies the contribution of key-point coverage and per-dimension scores.
Demonstrates the incremental value of multi-dimensional rubrics and evidence verification.
"""

import os
import sys

PKG_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(PKG_DIR)
if ROOT_DIR not in sys.path:
    sys.path.insert(0, ROOT_DIR)

import numpy as np
import pandas as pd
from sklearn.model_selection import GroupKFold
from sklearn.inspection import permutation_importance

from calibration.dataset import get_benchmark_df
from calibration.models import (
    RidgeCalibrator,
    GBDTCalibrator,
    extract_features,
    FEATURE_NAMES
)
from calibration.metrics import compute_all_metrics


def run_feature_ablation():
    df = get_benchmark_df()
    valid_df = df[df["critical_material_missing"] == 0].copy().reset_index(drop=True)
    y = valid_df["human_score"].values
    groups = valid_df["prompt_id"].values
    
    # Define 3 feature sets for ablation:
    # 1. Raw total score only
    feat_set_1 = ["raw_llm_score"]
    
    # 2. Raw total + 5 dimension scores
    feat_set_2 = [
        "raw_llm_score",
        "dim_keypoints",
        "dim_logic",
        "dim_language",
        "dim_policy",
        "dim_format"
    ]
    
    # 3. Full: 5 dimensions + key_point_coverage + length + question type
    feat_set_3 = FEATURE_NAMES
    
    configurations = [
        ("Config A: Raw Score Only", feat_set_1),
        ("Config B: Raw Score + 5-Dim Rubrics", feat_set_2),
        ("Config C: Full (5-Dim + Key-point Coverage + Verification)", feat_set_3)
    ]
    
    gkf = GroupKFold(n_splits=5)
    ablation_results = []
    
    print("=" * 70)
    print(" Feature Ablation Experiment (GroupKFold by unseen prompt)")
    print("=" * 70)
    
    for config_name, feature_subset in configurations:
        # Extract subset matrix
        indices = [FEATURE_NAMES.index(f) if f in FEATURE_NAMES else 0 for f in feature_subset]
        X_all, _, _ = extract_features(valid_df)
        X_sub = X_all[:, indices]
        
        preds = np.zeros(len(valid_df))
        for train_idx, test_idx in gkf.split(X_sub, y, groups=groups):
            model = RidgeCalibrator(alpha=15.0).fit(X_sub[train_idx], y[train_idx])
            preds[test_idx] = model.predict(X_sub[test_idx])
            
        metrics = compute_all_metrics(y, preds)
        ablation_results.append({
            "configuration": config_name,
            "features_count": len(feature_subset),
            "mae": metrics["mae"],
            "rmse": metrics["rmse"],
            "qwk": metrics["qwk"],
            "pearson_r": metrics["pearson_r"]
        })
        
    print(f"{'Configuration':<45} | {'MAE':<8} | {'QWK':<8} | {'Pearson r':<10}")
    print("-" * 70)
    for r in ablation_results:
        print(f"{r['configuration']:<45} | {r['mae']:<8} | {r['qwk']:<8} | {r['pearson_r']:<10}")
    print("-" * 70)
    
    # Feature Importance (Permutation Importance on Full Model)
    print("\n[Feature Importance Ranking (Permutation on Unseen Test Sets)]:")
    X_full, _, _ = extract_features(valid_df)
    full_model = GBDTCalibrator(max_iter=100, learning_rate=0.05).fit(X_full, y)
    perm_imp = permutation_importance(full_model.model, X_full, y, n_repeats=5, random_state=42)
    
    sorted_idx = np.argsort(perm_imp.importances_mean)[::-1]
    feature_ranking = []
    for rank, idx in enumerate(sorted_idx[:7], 1):
        feat_name = FEATURE_NAMES[idx]
        mean_imp = float(perm_imp.importances_mean[idx])
        feature_ranking.append({"rank": rank, "feature": feat_name, "importance": round(mean_imp, 3)})
        print(f"  {rank}. {feat_name:<25} importance delta: {mean_imp:+.3f}")
        
    return ablation_results, feature_ranking


if __name__ == "__main__":
    run_feature_ablation()
