"""
Score calibration package for LLM essay grading.
"""
import sys
import os

pkg_dir = os.path.dirname(os.path.abspath(__file__))
root_dir = os.path.dirname(pkg_dir)
if root_dir not in sys.path:
    sys.path.insert(0, root_dir)
