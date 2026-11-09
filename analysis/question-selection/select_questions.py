"""Step 2 of 3: pick the 100 questions per study that physicians will review.

What this is for:
    This is the actual selection (Option 4 in the google doc v2 section). Output is the list of 100
    question IDs per study, each with which group it came from and its sampling weight

How to run:
    Same as question_metrics.py, from the app repo's data/source/ folder:
        python3 select_questions.py
    Writes selected_questions_real_pocqi.csv and selected_questions_medsp1000.csv.
    It recomputes the lifts itself (same math as question_metrics.py), so it doesn't
    need step 1's CSVs to exist.

The design, tldr:
    100 questions = ~40 "high-lift" questions (H) + ~60 random ones (L)

    H: questions where some judge lifted its own answer unusually far, with ~5 per judge
       so all 8 judges get cases → this is what Reviewer 2's question needs
       ("does a judge prefer its own incorrect answer")
    L: plain random sample of everything else → keeps the main result representative
       of the whole dataset

Why "unusually far" is measured per judge (the z-score part):
    If you just take the biggest raw lifts, GPT-5.6 Sol takes over (it's the peak judge on
    76 of the top 144 Real-POCQi questions) and Claude Opus gets 0. That's bc everyone
    already ranks Opus's answers near the top, so Opus has no room to lift them further.
    So instead each judge's lift is compared to that judge's own usual lift (z-score).
    A 1.5 place lift is huge for Opus even though it's normal for Sol.

Why there are weights:
    H questions were picked on purpose, so they're over-represented vs the real dataset.
    Each question gets weight = (size of the pool it came from) / (number picked from that
    pool), i.e. how many questions in the full dataset it "stands for". If the analysis
    uses these weights, the main result describes all 620 (or all 200) questions again,
    same as if we'd sampled at random. H and L don't overlap (every question is in exactly
    one pool), so these weights are exact, not approximations.

Why it's deterministic:
    Instead of random.random(), every "random" choice sorts questions by a sha256 hash of
    (seed, study, group, question_id). Same idea as the app's own sampling code. Means
    anyone who reruns this gets the exact same 100 in the exact same order, and the
    selection is fixed before any physician data exists (so nobody can say we picked
    questions after seeing results).
"""
import csv
import hashlib
import json
from collections import defaultdict
from statistics import mean

SEED = "pe-selection-v1"  # change this and you get a different (equally valid) sample
N_TOTAL, N_PER_JUDGE = 100, 5  # 100 per study (Reviewer 1's number), ~5 H questions per judge
STUDIES = {
    "real_pocqi": ("real-pocqi-llm-judgments.jsonl", "real-pocqi-questions.jsonl", "specialty"),
    # MedSP1000 doesn't get specialty balancing, so everything goes in one group "all"
    "medsp1000": ("medsp1000-llm-judgments.jsonl", "medsp1000-scenarios.jsonl", None),
}


def h(*parts):
    # the hash used for all "random" ordering (see "Why it's deterministic" above)
    return hashlib.sha256(":".join(parts).encode()).hexdigest()


def proportional(groups, n):
    # Splits n picks across groups in proportion to group size (used to spread the random
    # L sample across Real-POCQi specialties). "Largest remainder" rounding: give every
    # group the whole-number part of its share, then hand the leftover picks to whichever
    # groups got rounded down the most. Guarantees the picks add up to exactly n.
    total = sum(len(v) for v in groups.values())
    raw = {g: n * len(v) / total for g, v in groups.items()}
    alloc = {g: int(x) for g, x in raw.items()}
    for g in sorted(raw, key=lambda g: (-(raw[g] - alloc[g]), g))[: n - sum(alloc.values())]:
        alloc[g] += 1
    return alloc


def metrics(path):
    # Same lift math as question_metrics.py (D = outside judges' average rank minus own
    # judge's rank, positive = judge favored its own answer), plus the per-judge z-scores
    ranks = defaultdict(lambda: defaultdict(dict))
    for line in open(path):
        r = json.loads(line)
        ranks[r["question_id"]][r["judge_model"]][r["generator_model"]] = r["original_rank"]
    out = {}
    allD = defaultdict(list)  # every lift each judge had, across all questions
    for q, bj in ranks.items():
        models = sorted(bj)
        if len(models) != 8 or any(len(bj[j]) != 8 for j in models):
            continue
        D = {j: mean(bj[k][j] for k in models if k != j) - bj[j][j] for j in models}
        # Kendall's W, written out for 8 judges and 8 answers: 12*S / (8^2 * (8^3 - 8))
        tot = [sum(bj[j][g] for j in models) for g in models]
        mt = mean(tot)
        w = 12 * sum((t - mt) ** 2 for t in tot) / (64 * (512 - 8))
        out[q] = {"qarb": mean(D.values()), "peak": max(D.values()),
                  "peak_judge": max(D, key=D.get), "kendall_w": w, "D": D}
        for j, v in D.items():
            allD[j].append(v)
    # each judge's usual lift (mean) and how much it normally varies (sd)
    mu = {j: mean(v) for j, v in allD.items()}
    sd = {j: (sum((x - mu[j]) ** 2 for x in v) / (len(v) - 1)) ** 0.5 for j, v in allD.items()}
    for q, m in out.items():
        # z = how unusual this lift is *for this judge*. The question's score is its most
        # unusual lift, and zpeak_judge is the judge that question gets assigned to
        z = {j: (m["D"][j] - mu[j]) / sd[j] for j in m["D"]}
        m["zpeak"] = max(z.values())
        m["zpeak_judge"] = max(z, key=z.get)
    return out


for study, (judg, items, group_key) in STUDIES.items():
    M = metrics(judg)
    group = {}
    for line in open(items):
        r = json.loads(line)
        group[r["question_id"]] = r.get(group_key, "all") if group_key else "all"

    # Split into the two pools: top 20% by most-unusual lift → H, everything else → L.
    # 20% was a judgment call: big enough that every judge has some H questions
    # (125 in Real-POCQi, 41 in MedSP1000), small enough that H really is the extreme end
    zs = sorted(m["zpeak"] for m in M.values())
    cut = zs[int(0.8 * (len(zs) - 1))]
    H = [q for q in M if M[q]["zpeak"] >= cut]
    L = [q for q in M if M[q]["zpeak"] < cut]
    rows = []

    def row(q, stratum, weight):
        # one output row. lift_judge only filled in for H questions (the judge it was
        # picked for). peak_judge is the raw-lift peak, kept for reference
        m = M[q]
        return {"study": study, "question_id": q, "stratum": stratum, "sampling_weight": round(weight, 4),
                "group": group[q], "lift_judge": m["zpeak_judge"] if stratum != "L" else "",
                "qarb": round(m["qarb"], 3), "peak": round(m["peak"], 3), "peak_judge": m["peak_judge"],
                "kendall_w": round(m["kendall_w"], 3)}

    # H: split the H pool by which judge each question belongs to, then take up to 5
    # from each judge's sub-pool. Weight = that sub-pool's size / number taken
    by_j = defaultdict(list)
    for q in H:
        by_j[M[q]["zpeak_judge"]].append(q)
    for j, qs in sorted(by_j.items()):
        k = min(N_PER_JUDGE, len(qs))  # some judges have < 5 (MedSP1000: Sol 2, Sonnet 4)
        for q in sorted(qs, key=lambda q: h(SEED, study, "H", j, q))[:k]:
            rows.append(row(q, "H:" + j.split("/")[-1], len(qs) / k))

    # L: whatever's left of the 100 comes from L. So if a judge has < 5 H questions,
    # L just gets bigger (that's why MedSP1000 ends up 64 L + 36 H instead of 60 + 40).
    # Real-POCQi spreads L across specialties in proportion; MedSP1000 is one group
    n_l = N_TOTAL - len(rows)
    by_g = defaultdict(list)
    for q in L:
        by_g[group[q]].append(q)
    for g, k in proportional(by_g, n_l).items():
        for q in sorted(by_g[g], key=lambda q: h(SEED, study, "L", g, q))[:k]:
            # weight uses the whole L pool (not per specialty) bc the specialty split is
            # proportional, so every L question has ~the same chance of being picked
            # (rounding to whole questions makes it slightly off for small specialties)
            rows.append(row(q, "L", len(L) / n_l))
    strata = {"H": H, "L": L}

    # Shuffle the final 100 so H and L are mixed. This matters for allocation: physicians
    # get consecutive blocks of this list, so a shuffled list means everyone gets about
    # the same mix of H and L, and nobody can guess which group a question is in
    rows.sort(key=lambda r: h(SEED, study, "order", r["question_id"]))
    with open(f"selected_questions_{study}.csv", "w", newline="") as fh:
        wtr = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        wtr.writeheader()
        wtr.writerows(rows)
    print(f"{study}: population {len(M)}; H cutoff z >= {cut:.3f}; H {len(H)}, L {len(L)}; "
          f"H per judge {dict((j.split('/')[-1], len(v)) for j, v in sorted(by_j.items()))}; "
          f"selected {len(rows)} -> selected_questions_{study}.csv")
