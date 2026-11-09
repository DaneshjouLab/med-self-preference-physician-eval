# Question selection for the physician annotation

This folder picks which questions physicians actually review (and backs up why), for the "selection process for questions" doc Shlok asked about. The full reasoning is in the question selection plan google doc. This README is the short version plus how to run things.

Nothing in here touches the app. It's just Python scripts reading the committed `data/source/` files and writing CSVs.

## tldr of the design

Per study (Real-POCQi and MedSP1000):

- **100 questions, 2 physicians each** (= 200 case reviews per study). This is the number the reviewers asked for (100 questions with two or more raters)
- **~40 "high-lift" questions (H):** questions where some judge ranked its own answer unusually far above where the other 7 judges put it. Picked so each of the 8 judges gets ~5, bc otherwise GPT-5.6 Sol takes over (it's the top self-lifter on 76 of the top 144 Real-POCQi questions) and Claude Opus gets 0
- **~60 random questions (L):** plain random sample of everything else so the main result still describes the whole dataset. Real-POCQi is spread across specialties in proportion
- **every question has a sampling weight** so the H questions don't skew the population-level result
- **no separate "high disagreement" group:** disagreement and self-preference turn out to be mostly the same signal here (correlation −0.63 in Real-POCQi, −0.50 in MedSP1000), so there are only 16 / 10 questions that are high disagreement but low self-preference. Judge agreement (Kendall's W) is recorded for every question and used in the analysis instead

Final counts:

| | Real-POCQi | MedSP1000 |
|---|---|---|
| H (high-lift) | 40 of 125 | 36 of 41 |
| L (random) | 60 of 495 | 64 of 159 |
| Total | 100 | 100 |

MedSP1000 only has 2 high-lift questions for Sol and 4 for Sonnet, so the random group fills the rest. Real-POCQi covers 28 of 30 specialties.

## How to run

Needs Python 3 with numpy and scipy (scipy only for `check_final_design.py`). Run from `data/source/` since that's where the input files are:

```bash
cd data/source
python3 ../../analysis/question-selection/question_metrics.py   # step 1, ~1 sec
python3 ../../analysis/question-selection/select_questions.py    # step 2, ~1 sec
python3 ../../analysis/question-selection/check_final_design.py  # step 3, ~10 sec
```

Heads up: the scripts write their outputs into whatever folder you run them from (so `data/source/`). Copies of every output are already committed in this folder, so just delete the ones that land in `data/source/` after. Everything is seeded, so reruns give byte-identical files (I checked).

## Files

| File | What it is |
|---|---|
| `question_metrics.py` | Step 1. Scores all 620 + 200 questions on self-preference (lift per judge, average, peak) and judge agreement |
| `question_metrics_<study>.csv` | Output of step 1, one row per question |
| `select_questions.py` | Step 2. The actual selection (H + L, weights, seeded shuffle) |
| `selected_questions_<study>.csv` | **The 100 picked questions per study.** This is the main thing |
| `check_final_design.py` | Step 3. Simulates fake physician panels 1,000 times to check the design vs a plain random 100 |
| `check_final_design_output.txt` | Output of step 3 |
| `selection_design.py` | Shared simulation code that step 3 imports. Its own `main()` is an older version with a disagreement group that we dropped, you can ignore that part |

Every script has comments at the top explaining what it does and why, so start there if something looks weird.

## Columns in `selected_questions_<study>.csv`

| Column | Meaning |
|---|---|
| `study` | `real_pocqi` or `medsp1000` |
| `question_id` | same IDs as `data/source/` and the sample manifests in `data/study/` |
| `stratum` | `L` (random) or `H:<judge>` (high-lift, picked for that judge) |
| `sampling_weight` | how many questions in the full dataset this one stands for. Use it in the analysis, don't show it to anyone |
| `group` | specialty for Real-POCQi, `all` for MedSP1000 |
| `lift_judge` | for H questions, the judge it was picked for (empty for L) |
| `qarb` | average self-preference across the 8 judges on this question |
| `peak`, `peak_judge` | biggest raw lift on the question and whose it was |
| `kendall_w` | how much the 8 judges agree (1 = same ranking, 0 = no agreement) |

Rows are already in a shuffled order with H and L mixed, so splitting the list into consecutive blocks gives every physician about the same mix.

## What the check shows

From `check_final_design_output.txt` ("share" = how much physicians side with the self-preferring judge, 0 = side with the other 7, 1 = side with the own judge):

| | Random 100 | This design |
|---|---|---|
| Bias in the main estimate | none | none |
| 95% spread, Real-POCQi / MedSP1000 | ±0.09 / ±0.12 | ±0.10 / ±0.12 |
| Own answers lifted 2+ places, least-covered judge | 4 / 4 | 8 / 7 |

So basically same precision as pure random, but ~2x the high-lift cases for the judges that would otherwise barely get any.

The fake physicians are tuned to agree with each other at Spearman 0.45, which is an assumption. If real physicians agree less, every spread gets wider.

## How this connects to the app (not done in this PR)

- The CSVs list **question IDs, not the app's question numbers**. The admin box numbers (`1-5, 8`) are `sample_index + 1` in the currently frozen sample (`data/study/*-sample-manifest.json`), which is the earlier random 100
- Overlap between this list and the current frozen sample: **12 of 100** for Real-POCQi, **53 of 100** for MedSP1000
- None of the first 5 questions in the current Real-POCQi sample are in this list (if those are the 5 already on Railway)
- So the frozen sample would need to be swapped for this list before assigning anyone. Since imported content is insert-only, that's probably a fresh import / new study setup and not an edit. Up to you how you'd want to do that
