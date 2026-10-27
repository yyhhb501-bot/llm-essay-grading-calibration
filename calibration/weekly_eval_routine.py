"""Manual evaluation of a genuinely new batch. No cron/retraining is installed."""
import argparse
import json
from pathlib import Path
import pandas as pd
from calibration.pipeline import evaluate_new_batch

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--input', type=Path, required=True)
    p.add_argument('--model', type=Path, required=True)
    p.add_argument('--data-kind', choices=['human', 'synthetic'], default='human')
    a = p.parse_args()
    print(json.dumps(evaluate_new_batch(pd.read_csv(a.input, keep_default_na=False), a.data_kind,
                     json.loads(a.model.read_text(encoding='utf-8'))), ensure_ascii=False, allow_nan=False, indent=2))

if __name__ == '__main__':
    main()
