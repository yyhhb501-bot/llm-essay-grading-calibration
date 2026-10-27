# 简历项目的可验证表述

2026-10-27：依据当前源代码与验收。真实人工评分、MAE/QWK 改善和用户规模尚未提供，不应写成既有成果。模拟数据只用于功能自测。

## 英文参考

**LLM-based Essay Grading and Score-Calibration System — Independent Developer**

- Built a web application for Chinese civil-service essay practice, combining the question, source materials, and candidate response to provide structured multi-dimensional feedback and revision suggestions; added evidence checks and instructions to withhold scores when essential material is absent.
- Implemented a reproducible Ridge and gradient-boosted tree calibration workflow with question-group holdout evaluation, training-only grouped cross-validation, MAE/QWK metrics, feature ablation, and bias analysis by score band, question type, and response length. Validated pipeline behavior with explicitly labeled synthetic fixtures; real human-labeled evaluation is pending.
- Integrated a portable browser inference interface that rejects unapproved or synthetic calibration models and incomplete features, preserves raw AI scores by default, and reports repeat-score variability only when repeated observations are available.
- Implemented account authentication, streaming model responses, a searchable practice-paper library, and local per-account history; maintained a GitHub repository with setup instructions and isolated regression checks.

## 暂时不能写成成果

MAE 6.8→4.1、QWK 0.52→0.71、300 多用户、2,400 多篇真实作答、每周真实回流重训、重复评分方差降低等，均需真实原始记录和独立验证。论文式指标不可从模拟数据或自设噪声反推。功能已实现也不等于这些历史成果成立。
