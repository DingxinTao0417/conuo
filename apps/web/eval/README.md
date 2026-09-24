# Conuo AI evaluation

## Offline retrieval

The default test suite runs `eval/retrieval.eval.test.ts`. It loads only the synthetic corpus in this directory, calls local keyword retrieval and grounding, and never calls a model or the network. Add a JSON object per line to `datasets/core.jsonl`; the strict schema in `lib/dataset.ts` rejects unknown fields, unknown categories, and invalid scopes.

Run it directly from `apps/web` with `npm run eval:retrieval`. Reports are written under the repository `work/eval/` directory. The committed baseline is `baselines/retrieval.json`. After an intentional retrieval improvement, update it locally with `CONUO_EVAL_UPDATE_BASELINE=1 npm run eval:retrieval` and record the before and after scores in the implementation status.

## Model evaluation

The model suite is skipped unless `CONUO_EVAL_MODEL=1`. It requires the server-only model configuration and can use a separate judge through `CONUO_EVAL_JUDGE_BASE_URL`, `CONUO_EVAL_JUDGE_API_KEY`, and `CONUO_EVAL_JUDGE_NAME`. `CONUO_EVAL_MAX_CASES` defaults to 20 and is bounded to 200. A model run writes a timestamped JSON report and Markdown summary under `work/eval/`; it is never part of the default test run.

```sh
cd apps/web
CONUO_EVAL_MODEL=1 CONUO_EVAL_MAX_CASES=40 npx vitest run eval/model.eval.test.ts
```

All corpus files are self-authored. Do not add user documents, copied textbook passages, or web pages.

## 反馈转评测用例

回答反馈默认只保存评分和原因，不保存问题或回答内容。只有用户明确勾选附上内容后，反馈才可作为人工整理评测样本的输入。

由具备 `service_role` 权限的维护人员只读导出负面反馈：

```sql
select request_id, question, answer, reasons, comment, contract_version
from public.answer_feedback
where rating = 'down' and include_content = true
order by created_at;
```

人工逐条重写为去除个人信息的自有评测用例，确认资料范围和引用仍然适用后，再追加到 `datasets/core.jsonl`。不要把导出结果直接提交到仓库，也不要自动生成评测集。
