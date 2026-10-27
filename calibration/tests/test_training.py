"""Only synthetic fixtures; no test result is evidence of real grading accuracy."""
import copy
import json
import subprocess
import unittest
from pathlib import Path
import numpy as np
from calibration.dataset import generate_benchmark_dataset
from calibration.metrics import quadratic_weighted_kappa
from calibration.pipeline import (run_experiment, validate_dataset, predict_export,
                                  consistency_report, evaluate_new_batch)
from calibration.models import extract_features
from calibration.consistency import compute_essay_reliability_badge

ROOT = Path(__file__).resolve().parents[2]


class TrainingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.df = generate_benchmark_dataset(num_samples=90, num_prompts=8)
        cls.report, cls.model = run_experiment(cls.df, 'synthetic', input_sha256='a' * 64)

    def test_question_split_and_provenance(self):
        r = self.report
        self.assertFalse(set(r['train_question_hashes']) & set(r['test_question_hashes']))
        self.assertEqual(self.model['training_provenance']['data_kind'], 'synthetic')
        self.assertFalse(self.model['approved_for_runtime'])
        self.assertIn('gbdt', r['metrics'])
        self.assertIn('without_dimensions', r['ablations'])
        json.dumps(r, allow_nan=False)

    def test_missing_and_nonfinite_features(self):
        for value in [float('nan'), float('inf'), '']:
            df = self.df.copy()
            df['key_point_coverage'] = df['key_point_coverage'].astype(object)
            df.loc[0, 'key_point_coverage'] = value
            with self.assertRaises((ValueError, TypeError)):
                validate_dataset(df, 'synthetic')

    def test_zero_is_valid(self):
        df = self.df.copy()
        df.loc[0, ['human_score', 'raw_llm_score', 'key_point_coverage', 'dim_format']] = 0
        validate_dataset(df, 'synthetic')

    def test_synthetic_cannot_silently_be_human(self):
        with self.assertRaises(ValueError):
            run_experiment(self.df, 'human')
        df = self.df.copy()
        df['data_kind'] = 'human'
        with self.assertRaises(ValueError):
            validate_dataset(df, 'human')

    def test_score_ranges(self):
        for column, value in [('human_score', 101), ('raw_llm_score', -1),
                              ('critical_material_missing', 2), ('key_point_coverage', 1.1)]:
            df = self.df.copy()
            df.loc[0, column] = value
            with self.assertRaises(ValueError):
                validate_dataset(df, 'synthetic')

    def test_repeated_essay_question_leakage_rejected(self):
        df = self.df.copy()
        df.loc[1, 'essay_id'] = df.loc[0, 'essay_id']
        df.loc[1, 'prompt_id'] = 'different_question'
        with self.assertRaises(ValueError):
            validate_dataset(df, 'synthetic')

    def test_missing_repeats_is_unknown(self):
        self.assertIsNone(consistency_report(self.df)['mean_variance'])
        self.assertIsNone(compute_essay_reliability_badge([75])['variance'])
        repeated = self.df.iloc[[0, 0]].copy()
        repeated.iloc[0, repeated.columns.get_loc('raw_llm_score')] = 60
        repeated.iloc[1, repeated.columns.get_loc('raw_llm_score')] = 64
        self.assertAlmostEqual(consistency_report(repeated)['mean_variance'], 8)

    def test_qwk_full_score_range(self):
        self.assertAlmostEqual(quadratic_weighted_kappa([0, 50, 100], [0, 50, 100]), 1)
        self.assertIsNone(quadratic_weighted_kappa([50, 50], [50, 50]))

    def test_new_batch_cannot_reuse_training_questions(self):
        with self.assertRaises(ValueError):
            evaluate_new_batch(self.df, 'synthetic', self.model)

    def test_python_javascript_parity_and_runtime_gate(self):
        X, _, _ = extract_features(self.df.iloc[:4])
        expected = np.round(predict_export(self.model, X) * 10) / 10
        # Test-only fake approval exercises inference. Never export this fixture.
        fixture = copy.deepcopy(self.model)
        fixture['training_provenance'].update(data_kind='human', human_labels_verified=True)
        fixture['approved_for_runtime'] = True
        rows = []
        for _, row in self.df.iloc[:4].iterrows():
            rows.append({'raw_total': row['raw_llm_score'], 'coverage': row['key_point_coverage'],
                         'word_count': row['word_count'], 'question_type': row['question_type'],
                         'dimensions': {name: row[name] for name in self.model['feature_names'][2:7]}})
        script = """
const fs=require('fs'), assert=require('assert'), c=require('./site/js/vendor/calibration.js');
const x=JSON.parse(fs.readFileSync(0,'utf8'));
assert.equal(c.configure(x.synthetic),false);
assert.equal(c.calibrateScore(x.rows[0]),null);
assert.equal(c.configure(x.fixture),true);
const scores=x.rows.map(r=>c.calibrateScore(r).calibrated_score);
const missing={...x.rows[0]}; delete missing.coverage;
assert.equal(c.calibrateScore(missing),null);
assert.equal(c.reliability([70]).variance,null);
assert.equal(c.reliability([60,64]).variance,8);
const zero={...x.rows[0], raw_total:0, coverage:0, dimensions:{dim_keypoints:0,dim_logic:0,dim_language:0,dim_policy:0,dim_format:0}};
assert.ok(c.calibrateScore(zero));
assert.equal(c.configure(null),false);
console.log(JSON.stringify(scores));
"""
        result = subprocess.run(['node', '-e', script], cwd=ROOT, capture_output=True, text=True,
                                input=json.dumps({'synthetic': self.model, 'fixture': fixture, 'rows': rows}))
        self.assertEqual(result.returncode, 0, result.stderr)
        np.testing.assert_allclose(json.loads(result.stdout), expected, atol=1e-8)


if __name__ == '__main__':
    unittest.main()
