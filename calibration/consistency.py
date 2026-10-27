"""Reliability from observed repeated grades. No simulated noise reduction claims."""
import numpy as np
from calibration.pipeline import consistency_report

def evaluate_grading_consistency(df):
    return consistency_report(df)

def compute_essay_reliability_badge(scores_list):
    arr = np.asarray(scores_list, dtype=float)
    if not np.isfinite(arr).all() or np.any((arr < 0) | (arr > 100)):
        raise ValueError('finite scores between 0 and 100 required')
    if len(arr) < 2:
        return {'std': None, 'variance': None, 'tier': 'Unknown', 'label': '重复评分不足，一致性待验证'}
    return {'std': float(np.std(arr, ddof=1)), 'variance': float(np.var(arr, ddof=1)),
            'tier': 'Observed', 'label': '重复评分波动；不等同于人工评分准确性'}
