# 评分校准实验

当前没有真实人工评分数据，未验证 MAE/QWK 改善、实际用户量或重复评分可靠性。仓库 CSV、旧权重和旧日志均为模拟产物，不能用于简历中的实测成果。网站默认禁用统计校准，显示原始 AI 训练指数。

## 运行

Python 3.10+，安装 `python -m pip install -r calibration/requirements.txt`。

```powershell
# 显式模拟演示：只验证流程，不报告业务成效
python run_calibration_repro.py --demo --output .runtime/calibration-demo
# 真实人工标注：输出目录必须尚不存在
python run_calibration_repro.py --input path/to/human-labels.csv --data-kind human --output .runtime/human-run-001
python -m unittest discover -s calibration/tests
```

`example-schema.csv` 只有表头，无虚构人工标签。分数统一为百分制；`key_point_coverage` 为 0–1；五维输入为该量表中的原始维度分数；`word_count` 为真实作答字数。题目 ID 必须精确到单道题，不能仅填写套卷 ID。`essay_id` 对同一篇作答稳定，重复评分用相同 ID。`human_score` 必须来自独立人工评分，`label_source` 填可追溯的标注记录，真实行的 `data_kind` 为 `human`。不得把已有模拟 CSV 改个标记充作真实数据。

至少 12 篇完整作答、6 道不同题目才执行流程；这是代码最小条件，不足以支持可靠的研究结论。实际研究需更多有代表性的独立标注、标注者一致性评估和不确定性区间。

## 评估契约

- 先排除缺关键材料的行；重复评分平均为一篇训练样本，另统计观测方差。
- 按题目留出 25% 组；Ridge 的正则参数只在训练题目上用 GroupKFold 选择，归一化也只拟合训练折。固定参数的梯度提升树作为比较模型，禁止随机早停验证造成题目混用。
- 同一留出集输出原始分、Ridge、GBDT 的 MAE/RMSE/Pearson/QWK、去覆盖率及去五维的消融、按人工分段/题型/字数的偏差。QWK 明确采用 0–100 四舍五入整数尺度，不再把旧六档指标混作同一指标。不可据留出集反复调参后继续称其未见数据。
- 无重复评分记录则方差为 null，不能写“高置信度”；稳定性不等于准确性。
- `report.json` 记录输入摘要和训练/测试题目哈希；`model.json` 导出训练题目上的 Ridge 系数和字数除以 100 的特征契约，不把测试标签用于最终模型拟合。

## 网站接入

浏览器运行时支持 `ScoreCalibrator.configure(model)`。模型需为该管线导出的 Ridge，并且来源为 human、人工标签已独立审核、`approved_for_runtime` 明确为 true。训练命令不会自动设置这两个审核标记，也不会部署。审核确认后再将模型写入 `site/js/calibration-model.js`：`window.ScoreCalibrator.configure({...});`。这属于研究者的可追溯审核声明，程序不能自动证明标签真实。

每次预测要求实际原始总分、覆盖率、五维分、题型和字数全部存在；零分保留，缺失不推算。未经审核的模型及模拟权重一律拒绝。不具备要点覆盖率的自由输入可正常使用 LLM 批改，但不产生校准分。

## 后续批次

```powershell
python -m calibration.weekly_eval_routine --input path/to/new-human-labels.csv --model .runtime/human-run-001/model.json --data-kind human
```

新批次不得含训练题目；这个命令只做人工触发的批次评估，没有部署定时任务、自动收集用户作答或自动重训。报告和真实标注保存在被忽略的 `.runtime/`，不会上传 GitHub。
