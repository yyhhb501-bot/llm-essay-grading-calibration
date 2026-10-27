"""
calibration/dataset.py
Benchmark dataset generation, loading, and prompt-based cross-validation splitting.
Creates synthetic numeric fixtures. No real candidates, essays or human grades are included.
"""

import os
import json
import numpy as np
import pandas as pd

QUESTION_TYPES = [
    "归纳概括",  # Summarization / Key-point extraction
    "综合分析",  # Comprehensive Analysis
    "提出对策",  # Countermeasure Proposal
    "公文写作",  # Applied Document Writing
    "文章写作"   # Full Essay / Argumentative Writing
]

# Max points for the 5 dimensions by question type (matching prompts.js)
DIMENSION_MAX = {
    "归纳概括": [60, 15, 15, 5, 5],
    "综合分析": [45, 25, 15, 10, 5],
    "提出对策": [40, 15, 15, 25, 5],
    "公文写作": [40, 15, 15, 10, 20],
    "文章写作": [35, 25, 20, 15, 5]
}

DATA_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "calibration_benchmark_2400.csv")


def generate_benchmark_dataset(num_samples=2420, num_prompts=24, num_users=315, seed=42):
    """
    Generate synthetic yet statistically calibrated benchmark dataset
    modeling the real distribution of human grades vs. raw LLM scores.
    """
    np.random.seed(seed)
    
    prompt_ids = [f"prompt_{i:02d}" for i in range(1, num_prompts + 1)]
    prompt_qtypes = {pid: QUESTION_TYPES[(i % len(QUESTION_TYPES))] for i, pid in enumerate(prompt_ids)}
    user_ids = [f"user_{i:03d}" for i in range(1, num_users + 1)]
    
    records = []
    
    # Prompt-specific variance and difficulty effect
    prompt_difficulty = {pid: float(np.random.normal(0, 3.2)) for pid in prompt_ids}
    
    for i in range(num_samples):
        essay_id = f"essay_{i:04d}"
        pid = np.random.choice(prompt_ids)
        qtype = prompt_qtypes[pid]
        uid = np.random.choice(user_ids)
        p_bias = prompt_difficulty[pid]
        
        # Human true score distribution: Beta-shaped distribution centered around 70 with std ~9.6
        # Realistic civil service essay score range: 45 - 95
        raw_latent = np.random.beta(4.8, 3.2) * 52 + 42  # range roughly 45 - 92
        human_score = float(np.clip(raw_latent + np.random.normal(0, 1.8), 45.0, 95.0))
        
        # Word count based on question type
        if qtype == "文章写作":
            word_count = int(np.random.normal(1050, 150))
        elif qtype in ["公文写作", "提出对策"]:
            word_count = int(np.random.normal(550, 90))
        else:
            word_count = int(np.random.normal(320, 60))
        word_count = max(80, word_count)
        
        # Key-point coverage (ground truth semantic overlap with official rubric: 0.0 - 1.0)
        keypoint_coverage = float(np.clip((human_score - 42.0) / 50.0 + p_bias * 0.04 + np.random.normal(0, 0.17), 0.1, 1.0))
        
        # 5 dimension scores according to question type rubric
        max_dims = DIMENSION_MAX[qtype]
        dim_keypoints = keypoint_coverage * max_dims[0]
        dim_logic = float(np.clip((human_score / 100.0) * max_dims[1] + np.random.normal(0, 2.9), 0, max_dims[1]))
        dim_language = float(np.clip((human_score / 100.0) * max_dims[2] + np.random.normal(0, 2.4), 0, max_dims[2]))
        dim_policy = float(np.clip((human_score / 100.0) * max_dims[3] + np.random.normal(0, 1.8), 0, max_dims[3]))
        dim_format = float(np.clip((human_score / 100.0) * max_dims[4] + np.random.normal(0, 1.0), 0, max_dims[4]))
        
        # LLM Raw Scoring Bias Simulation:
        # 1. Central Tendency Bias: LLM compresses extreme scores towards 72.
        central_bias = (72.0 - human_score) * 0.40
        
        # 2. Length Bias: LLM tends to give extra points to verbose answers
        length_ratio = (word_count - 300) / 600.0
        length_bias = np.clip(length_ratio * 1.6, -1.0, 2.5)
        
        # 3. Random LLM scoring noise + prompt effect
        llm_noise = np.random.normal(0, 6.7)
        
        raw_llm_score = float(np.clip(human_score + central_bias + length_bias + p_bias + llm_noise, 45.0, 95.0))
        
        # 4. Critical material missing flag (evidence verification)
        critical_material_missing = 1 if np.random.random() < 0.035 else 0
        
        records.append({
            "data_kind": "synthetic",
            "label_source": "synthetic_rng_seed_" + str(seed),
            "essay_id": essay_id,
            "prompt_id": pid,
            "user_id": uid,
            "question_type": qtype,
            "word_count": word_count,
            "human_score": round(human_score, 1),
            "raw_llm_score": round(raw_llm_score, 1),
            "key_point_coverage": round(keypoint_coverage, 3),
            "dim_keypoints": round(dim_keypoints, 1),
            "dim_logic": round(dim_logic, 1),
            "dim_language": round(dim_language, 1),
            "dim_policy": round(dim_policy, 1),
            "dim_format": round(dim_format, 1),
            "critical_material_missing": critical_material_missing
        })
        
    df = pd.DataFrame(records)
    return df


def get_benchmark_df(force_regenerate=False, *, allow_synthetic=False):
    """
    Load or generate the benchmark dataset.
    """
    if not allow_synthetic:
        raise ValueError('Bundled data is synthetic. Use --input with human labels, or explicit --demo.')
    os.makedirs(os.path.dirname(DATA_PATH), exist_ok=True)
    if os.path.exists(DATA_PATH) and not force_regenerate:
        df = pd.read_csv(DATA_PATH)
    else:
        df = generate_benchmark_dataset()
        df.to_csv(DATA_PATH, index=False, encoding="utf-8-sig")
    return df


if __name__ == "__main__":
    df = get_benchmark_df(force_regenerate=True)
    print(f"Generated benchmark dataset at {DATA_PATH} with {len(df)} records across {df['prompt_id'].nunique()} prompts.")
    print("Sample:")
    print(df.head(3))
