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
