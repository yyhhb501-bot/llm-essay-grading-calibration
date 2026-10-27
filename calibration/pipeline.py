"""Explicit-input calibration experiments. Synthetic runs never activate a website model."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.linear_model import Ridge
from sklearn.model_selection import GroupKFold, GroupShuffleSplit, GridSearchCV
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from calibration.dataset import QUESTION_TYPES
from calibration.metrics import compute_all_metrics
from calibration.models import FEATURE_NAMES, extract_features

NUMERIC = FEATURE_NAMES[:8]
DIMENSIONS = FEATURE_NAMES[2:7]
REQUIRED = ['essay_id', 'prompt_id', 'question_type', 'human_score',
            'critical_material_missing', 'data_kind', 'label_source', *NUMERIC]


def digest(value):
    return hashlib.sha256(str(value).encode('utf-8')).hexdigest()


def validate_dataset(df, kind):
    """Fail closed instead of inferring a human label or replacing absent features."""
    if kind not in ('human', 'synthetic'):
        raise ValueError('data kind must be human or synthetic')
    missing = set(REQUIRED) - set(df.columns)
    if missing:
        raise ValueError('missing columns: ' + ', '.join(sorted(missing)))
    df = df.copy()
    for column in ['essay_id', 'prompt_id', 'question_type', 'data_kind', 'label_source']:
        if df[column].isna().any() or df[column].astype(str).str.strip().eq('').any():
            raise ValueError('empty identifier/provenance: ' + column)
        df[column] = df[column].astype(str).str.strip()
    if not df['data_kind'].eq(kind).all():
        raise ValueError('row provenance does not match --data-kind')
    if kind == 'human' and df['label_source'].str.contains(
            r'synthetic|simulat|random|rng|模拟|合成', case=False, regex=True).any():
        raise ValueError('synthetic labels cannot be declared human')
    if not df['question_type'].isin(QUESTION_TYPES).all():
        raise ValueError('unknown question_type')
    for column in ['human_score', 'critical_material_missing', *NUMERIC]:
        df[column] = pd.to_numeric(df[column], errors='raise')
        if not np.isfinite(df[column].to_numpy(dtype=float)).all():
            raise ValueError('missing/nonfinite numeric value: ' + column)
    for column in ['human_score', 'raw_llm_score', *DIMENSIONS]:
        if not df[column].between(0, 100).all():
            raise ValueError('score must be within 0..100: ' + column)
    if not df['key_point_coverage'].between(0, 1).all():
        raise ValueError('coverage must be within 0..1')
    if not df['word_count'].between(1, 100000).all():
        raise ValueError('word_count out of range')
    if not df['critical_material_missing'].isin([0, 1]).all():
        raise ValueError('critical_material_missing must be 0 or 1')
    for column in ['prompt_id', 'human_score', 'word_count', 'question_type']:
        if df.groupby('essay_id')[column].nunique().gt(1).any():
            raise ValueError('inconsistent repeated essay identity/label: ' + column)
    if df.groupby('prompt_id')['question_type'].nunique().gt(1).any():
        raise ValueError('prompt_id must identify a single question, not an entire paper')
    # Repeated evaluations are kept for reliability; average them for training so
    # essays with many repeated requests do not receive disproportionate weight.
    return df


def consistency_report(df):
    rows = []
    for essay_id, group in df.groupby('essay_id'):
        if len(group) < 2:
            continue
        scores = group['raw_llm_score'].to_numpy(dtype=float)
        rows.append({'essay_hash': digest(essay_id), 'n': len(scores),
                     'variance': float(np.var(scores, ddof=1)),
                     'std': float(np.std(scores, ddof=1)),
                     'spread': float(np.ptp(scores))})
    return {'repeated_essays': len(rows),
            'mean_variance': float(np.mean([r['variance'] for r in rows])) if rows else None,
            'status': 'observed_repeats' if rows else 'not_measured', 'essays': rows}


def aggregate_essays(df):
    numeric = ['human_score', 'critical_material_missing', *NUMERIC]
    methods = {c: 'mean' for c in numeric}
    methods.update({c: 'first' for c in df.columns if c not in numeric and c != 'essay_id'})
    return df.groupby('essay_id', sort=True, as_index=False).agg(methods)


def bias_report(df, predictions):
    frame = df.copy()
    frame['error'] = np.asarray(predictions) - frame['human_score'].to_numpy()
    frame['score_band'] = pd.cut(frame['human_score'], [-1, 60, 80, 100],
                                labels=['0-60', '60-80', '80-100'])
    frame['length_band'] = pd.cut(frame['word_count'], [0, 300, 800, 100000],
                                 labels=['1-300', '301-800', '801+'])
    result = {}
    for column in ['score_band', 'question_type', 'length_band']:
        result[column] = {str(k): {'n': len(g), 'mean_error': float(g['error'].mean()),
                                  'mae': float(g['error'].abs().mean())}
                          for k, g in frame.groupby(column, observed=True)}
    return result


def ridge_search(X, y, groups):
    folds = GroupKFold(n_splits=min(3, len(set(groups))))
    search = GridSearchCV(make_pipeline(StandardScaler(), Ridge()),
                          {'ridge__alpha': [1.0, 10.0, 100.0]}, cv=folds,
                          scoring='neg_mean_absolute_error', error_score='raise')
    search.fit(X, y, groups=groups)
    return search


def run_experiment(df, kind, seed=42, input_sha256=None):
    df = validate_dataset(df, kind)
    eligible = df[df['critical_material_missing'].eq(0)].copy()
    reliability = consistency_report(eligible)
    grouped = aggregate_essays(eligible)
    if len(grouped) < 12 or grouped['prompt_id'].nunique() < 6:
        raise ValueError('need at least 12 eligible essays across 6 distinct questions')
    X, y, groups = extract_features(grouped)
    train_idx, test_idx = next(GroupShuffleSplit(n_splits=1, test_size=.25,
                                                 random_state=seed).split(X, y, groups))
    train_questions = set(groups[train_idx])
    test_questions = set(groups[test_idx])
    assert not train_questions & test_questions
    if len(train_questions) < 3:
        raise ValueError('need at least 3 training question groups')
    ridge = ridge_search(X[train_idx], y[train_idx], groups[train_idx])
    # A fixed GBDT comparator. No early stopping on a randomly split validation set.
    gbdt = HistGradientBoostingRegressor(max_iter=80, max_depth=3,
                                        learning_rate=.05, early_stopping=False,
                                        random_state=seed).fit(X[train_idx], y[train_idx])
    predictions = {'raw_llm': X[test_idx, 0],
                   'ridge': np.clip(ridge.predict(X[test_idx]), 0, 100),
                   'gbdt': np.clip(gbdt.predict(X[test_idx]), 0, 100)}
    metrics = {name: compute_all_metrics(y[test_idx], pred) for name, pred in predictions.items()}
    ablations = {}
    for name, indices in [('without_coverage', [i for i in range(X.shape[1]) if i != 1]),
                          ('without_dimensions', [i for i in range(X.shape[1]) if i not in range(2, 7)])]:
        sub = ridge_search(X[train_idx][:, indices], y[train_idx], groups[train_idx])
        pred = np.clip(sub.predict(X[test_idx][:, indices]), 0, 100)
        ablations[name] = compute_all_metrics(y[test_idx], pred)
    report = {
        'schema_version': 1, 'data_kind': kind,
        'notice': 'Synthetic functional demonstration; not real-world performance.' if kind == 'synthetic'
                  else 'Metrics on supplied human-labeled data; label provenance is user-attested.',
        'source_sha256': input_sha256, 'seed': seed, 'input_rows': len(df),
        'excluded_missing_material_rows': int(df['critical_material_missing'].sum()),
        'unique_essays': len(grouped), 'train_essays': len(train_idx), 'test_essays': len(test_idx),
        'train_question_hashes': sorted(digest(q) for q in train_questions),
        'test_question_hashes': sorted(digest(q) for q in test_questions),
        'strategy': 'question-group holdout; Ridge alpha chosen by train-only grouped CV; fixed GBDT comparator',
        'metrics': metrics, 'ridge_alpha': ridge.best_params_['ridge__alpha'],
        'ablations': ablations,
        'bias': {name: bias_report(grouped.iloc[test_idx], pred) for name, pred in predictions.items()},
        'consistency': reliability,
        'runtime_model': 'ridge',
        'runtime_selection': 'Ridge chosen in advance for portable inference; holdout not used for selection',
    }
    # Keep the evaluated model trained only on training questions. Test questions
    # remain unseen, including when this artifact is used for future evaluation.
    pipeline = ridge.best_estimator_
    scaler, estimator = pipeline.steps[0][1], pipeline.steps[1][1]
    coef = estimator.coef_ / scaler.scale_
    intercept = estimator.intercept_ - np.sum(estimator.coef_ * scaler.mean_ / scaler.scale_)
    model = {'schema_version': 1, 'model_type': 'ridge', 'feature_names': FEATURE_NAMES,
             'feature_transform': {'word_count': 'divide_by_100'},
             'weights': {**dict(zip(FEATURE_NAMES, map(float, coef))), 'intercept': float(intercept)},
             'training_provenance': {'data_kind': kind, 'source_sha256': input_sha256,
                                     'train_essays': len(train_idx), 'human_labels_verified': False},
             'approved_for_runtime': False,
             'train_question_hashes': report['train_question_hashes'],
             'metrics': metrics['ridge']}
    return report, model


def predict_export(model, X):
    return np.clip(model['weights']['intercept'] +
                   np.asarray(X) @ np.array([model['weights'][f] for f in model['feature_names']]), 0, 100)


def evaluate_new_batch(df, kind, model):
    df = validate_dataset(df, kind)
    if kind != model['training_provenance']['data_kind']:
        raise ValueError('evaluation and training data provenance must match')
    if {digest(q) for q in df['prompt_id']} & set(model['train_question_hashes']):
        raise ValueError('new batch overlaps training questions; evaluation refused')
    df = aggregate_essays(df[df['critical_material_missing'].eq(0)])
    if not len(df):
        raise ValueError('no eligible new essays')
    X, y, _ = extract_features(df)
    return {'data_kind': kind, 'n': len(df), 'raw_llm': compute_all_metrics(y, X[:, 0]),
            'ridge': compute_all_metrics(y, predict_export(model, X)),
            'notice': 'Manual batch evaluation. No scheduler, retraining or deployment has run.'}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path)
    parser.add_argument('--data-kind', choices=['human', 'synthetic'], default='human')
    parser.add_argument('--demo', action='store_true', help='explicit synthetic smoke run')
    parser.add_argument('--output', type=Path, default=Path('.runtime/calibration'))
    parser.add_argument('--seed', type=int, default=42)
    args = parser.parse_args(argv)
    if args.demo:
        if args.input:
            parser.error('--demo and --input are mutually exclusive')
        from calibration.dataset import generate_benchmark_dataset
        df = generate_benchmark_dataset(num_samples=120, num_prompts=8, seed=args.seed)
        kind, fingerprint = 'synthetic', digest(df.to_csv(index=False))
    elif args.input:
        df = pd.read_csv(args.input, keep_default_na=False)
        kind, fingerprint = args.data_kind, hashlib.sha256(args.input.read_bytes()).hexdigest()
    else:
        parser.error('provide --input human-labels.csv, or explicitly --demo; no real data is bundled')
    if args.input and args.input.resolve().is_relative_to(args.output.resolve()):
        parser.error('input must be outside the output directory')
    if args.output.exists():
        parser.error('output already exists; choose a new output directory')
    report, model = run_experiment(df, kind, args.seed, fingerprint)
    args.output.mkdir(parents=True)
    for name, value in [('report.json', report), ('model.json', model)]:
        (args.output / name).write_text(json.dumps(value, ensure_ascii=False, indent=2,
                                                  allow_nan=False), encoding='utf-8')
    print(json.dumps({'data_kind': kind, 'metrics': report['metrics'],
                      'consistency': report['consistency']['status'],
                      'approved_for_runtime': False, 'output': str(args.output)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
