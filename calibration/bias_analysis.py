"""Bias estimates use held-out essays, never training-set fitted predictions."""
from calibration.pipeline import bias_report, run_experiment

def analyze_biases(df, data_kind):
    return run_experiment(df, data_kind)[0]['bias']
