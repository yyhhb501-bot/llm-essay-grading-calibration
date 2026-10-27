"""Explicit-input entry point. See calibration/README.md for provenance requirements."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from calibration.pipeline import main, run_experiment

if __name__ == '__main__':
    main()
