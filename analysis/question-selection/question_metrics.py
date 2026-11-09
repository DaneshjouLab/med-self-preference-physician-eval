"""Step 1 of 3: score every question on self-preference and judge disagreement.

What this is for:
    Before picking which questions physicians see, we need to know which questions
    actually show self-preference. So this goes through all 620 Real-POCQi questions and
    all 200 MedSP1000 scenarios and computes a few numbers per question.
    Nothing here picks questions yet, that's select_questions.py.

How to run:
    Input is the committed source data in the app repo
    (DaneshjouLab/med-self-preference-physician-eval, data/source/). cd into that folder
    and run:
        python3 question_metrics.py
    Writes question_metrics_real_pocqi.csv and question_metrics_medsp1000.csv
    (one row per question).

The core number, "lift" (same thing as the paper's answer rank bias D_jq):
    Each of the 8 models is both a generator (writes an answer) and a judge (ranks all 8
    answers, 1 = best, 8 = worst). For question q and model j:
        own_jq     = rank judge j gave model j's own answer
        outside_jq = average rank the other 7 judges gave that same answer
        D_jq       = outside_jq - own_jq
    So positive D means judge j ranked its own answer better than everyone else did.
    e.g. Opus judge puts Opus's answer 2nd, other 7 judges average 4.5 → D = 2.5

Per-question summaries (these are the columns in the CSV):
    qarb      = average of D across the 8 models (the QARB from Shlok's doc, i.e. net
                self-preference on the question)
    peak      = the single biggest D on the question, and peak_judge = whose it was
                (catches one judge going way off even if the others don't)
    breadth   = how many of the 8 judges lifted their own answer by 1+ places
    kendall_w = how much the 8 judges agree on the ranking overall
                (1 = identical rankings, 0 = no agreement, so low W = high disagreement)
    D_<model> = the raw lift for each model, so you can see the whole profile

FYI: these use raw ranks instead of the paper's position-adjusted ranks. The adjustment
only shifts things a little and raw ranks are what's in data/source so anyone can rerun
this without the paper's pipeline.
"""
import csv
import json
from collections import defaultdict
from statistics import mean

# study → (judgment file, question/scenario file, field to group by)
# Real-POCQi groups by specialty (used later for specialty-proportional sampling);
# MedSP1000 groups by which source dataset the scenario came from (just for reference)
STUDIES = {
    "real_pocqi": ("real-pocqi-llm-judgments.jsonl", "real-pocqi-questions.jsonl", "specialty"),
    "medsp1000": ("medsp1000-llm-judgments.jsonl", "medsp1000-scenarios.jsonl", "source_dataset"),
}


def kendalls_w(rank_rows):
    # Standard Kendall's W (no ties since each judge gives a strict 1 to 8 ranking).
    # rank_rows = one list per judge, each holding the rank it gave every answer.
    # Idea: add up each answer's ranks across judges. If the judges agree, some answers
    # get all low ranks and others all high ranks, so the totals are spread out.
    # If they don't agree, every total ends up near the middle. W is that spread,
    # rescaled to 0 to 1.
    m, n = len(rank_rows), len(rank_rows[0])  # m judges, n answers
    totals = [sum(r[i] for r in rank_rows) for i in range(n)]
    mbar = mean(totals)
    s = sum((t - mbar) ** 2 for t in totals)
    return 12 * s / (m ** 2 * (n ** 3 - n))


for study, (judg, items, group_key) in STUDIES.items():
    # Each line in the judgments file is one judge's rank for one answer on one question.
    # Rebuild them into ranks[question][judge][generator] = rank
    ranks = defaultdict(lambda: defaultdict(dict))
    for line in open(judg):
        r = json.loads(line)
        ranks[r["question_id"]][r["judge_model"]][r["generator_model"]] = r["original_rank"]
    meta = {}
    for line in open(items):
        r = json.loads(line)
        meta[r["question_id"]] = r
    rows = []
    for q, by_judge in ranks.items():
        models = sorted(by_judge)
        # only keep questions with the full 8 judges x 8 answers. Every question in the
        # frozen data is complete (all 620 + 200 come through), so this is just a safety check
        if len(models) != 8 or any(len(by_judge[j]) != 8 for j in models):
            continue
        D = {}
        for j in models:
            own = by_judge[j][j]  # judge j's rank of model j's answer
            outside = mean(by_judge[k][j] for k in models if k != j)  # other 7 judges
            D[j] = outside - own
        w = kendalls_w([[by_judge[j][g] for g in models] for j in models])
        rows.append({
            "question_id": q,
            "group": meta.get(q, {}).get(group_key, ""),
            "qarb": round(mean(D.values()), 4),
            "peak": round(max(D.values()), 4),
            "peak_judge": max(D, key=D.get),
            "breadth": sum(v >= 1 for v in D.values()),
            "kendall_w": round(w, 4),
            **{f"D_{j.split('/')[-1]}": round(v, 4) for j, v in D.items()},
        })
    out = f"question_metrics_{study}.csv"
    with open(out, "w", newline="") as fh:
        wtr = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        wtr.writeheader()
        wtr.writerows(rows)
    print(study, len(rows), "questions ->", out)
