"""Ablations use the same unseen-question holdout as the main experiment."""
from calibration.pipeline import run_experiment

def run_feature_ablation(df, data_kind):
    return run_experiment(df, data_kind)[0]['ablations']
