"""Shared simulation code (used by check_final_design.py).

Why this file is here:
    check_final_design.py imports the helper functions below (load, sim_phys,
    calibrate_sigma, share_estimate), so this has to sit in the same folder.
    You don't need to read the main() at the bottom: it's an earlier comparison I ran
    with a separate high-disagreement group (50 random + 30 high self-preference +
    20 high disagreement). That's the version we dropped bc the disagreement group barely
    exists (16 Real-POCQi / 10 MedSP1000 questions). The final design is checked in
    check_final_design.py.

How the simulation works, tldr:
    We don't have physician data yet, so we fake physicians and check whether a design
    can recover the right answer.

    1. Pick a "truth" for how much physicians agree with the self-preferring judge,
       called the share:
           share 0   → physicians rank like the other 7 judges (self-preference is bias)
           share 1   → physicians rank like the own judge (the own judge was right)
           share 0.5 → halfway
    2. Fake physicians rank the 8 answers by that truth plus random noise. The noise is
       tuned so two fake physicians agree at Spearman 0.45 (calibrate_sigma), i.e. they
       disagree with each other a fair amount, like real clinicians do. This is an
       assumption: if real physicians agree less, every spread gets wider.
    3. Draw a sample of questions the way a design would, simulate 2 physicians on each,
       and estimate the share back (share_estimate).
    4. Repeat 1,000 times. A good design gets the right share on average (no bias)
       with a small spread.
"""
import json
from collections import defaultdict

import numpy as np

RNG = np.random.default_rng(20261108)  # fixed seed so the simulation gives the same numbers every run
N_SIMS = 1000
STUDIES = {"Real-POCQi": "real-pocqi-llm-judgments.jsonl",
           "MedSP1000": "medsp1000-llm-judgments.jsonl"}


def load(path):
    # Reads the judgments into arrays. For every question and model:
    #   own     = rank the model's own judge gave its answer
    #   outside = average rank the other 7 judges gave it
    #   D       = outside - own (the lift, same as question_metrics.py)
    #   w       = Kendall's W per question
    ranks = defaultdict(lambda: defaultdict(dict))
    for line in open(path):
        r = json.loads(line)
        ranks[r["question_id"]][r["judge_model"]][r["generator_model"]] = r["original_rank"]
    C = []
    for q, bj in ranks.items():
        models = sorted(bj)
        if len(models) == 8 and all(len(bj[j]) == 8 for j in models):
            C.append([[bj[j][g] for g in models] for j in models])
    C = np.array(C, dtype=float)              # C[q, judge, generator]
    own = np.einsum("qgg->qg", C)              # the diagonal: judge j on generator j
    outside = (C.sum(axis=1) - own) / 7
    D = outside - own                          # positive = own judge favors its answer
    tot = C.sum(axis=1)                        # Kendall's W across the 8 judges
    w = 12 * ((tot - tot.mean(axis=1, keepdims=True)) ** 2).sum(axis=1) / (64 * (512 - 8))
    return own, outside, D, w


def ranks(x):
    # turns scores into ranks 1 to 8 along the last axis
    return np.argsort(np.argsort(x, axis=-1), axis=-1) + 1.0


def sim_phys(latent, raters, sigma):
    # Fake physicians: each one ranks the 8 answers by the "true" quality (latent) plus
    # noise. Returns the average rank across the raters (e.g. 2 physicians per question)
    noisy = latent[:, None, :] + RNG.normal(0, sigma, (latent.shape[0], raters, latent.shape[1]))
    return ranks(noisy).mean(axis=1)


def calibrate_sigma(outside, rho=0.45):
    # Finds the noise level where two fake physicians agree at Spearman 0.45
    # (binary search on sigma, using 300 questions)
    from scipy import stats
    lo, hi = 0.01, 20.0
    for _ in range(40):
        mid = (lo + hi) / 2
        a, b = sim_phys(outside[:300], 1, mid), sim_phys(outside[:300], 1, mid)
        r = np.mean([stats.spearmanr(x, y)[0] for x, y in zip(a, b)])
        lo, hi = (mid, hi) if r > rho else (lo, mid)
    return (lo + hi) / 2


def share_estimate(own, outside, phys, wts):
    """Estimates how far physicians move toward the own judge, from the sample.

    Basically: on answers where the own judge disagreed with the other 7 (x), how much do
    the physicians also move off the other 7 (y)? The slope of y on x is the share.
        x = own - outside   (how far the own judge moved off the panel)
        y = phys - outside  (how far physicians moved off the panel)

    Two details that matter:
    - Everything is centered within each question first. Every physician's 8 ranks
      always add up to 36 (1+2+...+8), so you can't just average raw ranks across
      questions. My first version did that and the estimate came out basically meaningless
    - The outside rank is a second predictor. Answers the panel ranks near the
      top or bottom have less room to move, and without this the slope gets biased.

    wts = sampling weight per question (all 1s for a simple random sample, the weights
    from select_questions.py for our design). Weighted least squares, so H questions
    don't count extra in the population estimate.
    The raw slope isn't on a 0 to 1 scale yet; callers divide by a benchmark (the slope
    you'd get if physicians fully agreed with the own judge) to rescale it.
    """
    x = own - outside
    y = phys - outside
    z = outside.copy()
    x, y, z = [a - a.mean(axis=1, keepdims=True) for a in (x, y, z)]
    W = np.repeat(wts, x.shape[1])
    X = np.stack([x.ravel(), z.ravel()], 1)
    XtW = X.T * W
    return np.linalg.solve(XtW @ X, XtW @ y.ravel())[0]


# ==== everything below is the earlier comparison (not the final design) ====

def strata(D, w):
    # earlier version's groups: top 20% raw peak lift, plus a high disagreement /
    # low self-preference group
    qarb = D.mean(axis=1)
    peak = D.max(axis=1)
    n = len(qarb)
    hi_sp = peak >= np.quantile(peak, 0.8)                       # top 20% by peak own-judge lift
    hi_dis = (w <= np.quantile(w, 0.2)) & (qarb <= np.median(qarb)) & ~hi_sp
    rest = ~hi_sp & ~hi_dis
    return hi_sp, hi_dis, rest


def draw(design, D, w):
    n = len(D)
    if design == "random":
        idx = RNG.choice(n, 100, replace=False)
        return idx, np.ones(100)
    hi_sp, hi_dis, rest = strata(D, w)
    pools = {"sp": np.flatnonzero(hi_sp), "dis": np.flatnonzero(hi_dis), "all": np.arange(n)}
    sp = RNG.choice(pools["sp"], min(30, len(pools["sp"])), replace=False)
    dis = RNG.choice(pools["dis"], min(20, len(pools["dis"])), replace=False)
    left = np.setdiff1d(pools["all"], np.concatenate([sp, dis]))
    rnd = RNG.choice(left, 100 - len(sp) - len(dis), replace=False)
    idx = np.concatenate([rnd, sp, dis])
    # inclusion probabilities by stratum membership (approximate, from the stratum sizes)
    # (the final design avoids this by keeping the pools separate, so its weights are exact)
    p = np.empty(len(idx))
    for k, q in enumerate(idx):
        if hi_sp[q]:
            p[k] = 1 - (1 - len(sp) / hi_sp.sum()) * (1 - len(rnd) / len(left))
        elif hi_dis[q]:
            p[k] = 1 - (1 - len(dis) / hi_dis.sum()) * (1 - len(rnd) / len(left))
        else:
            p[k] = len(rnd) / len(left)
    return idx, 1 / p


def main():
    for study, path in STUDIES.items():
        own, outside, D, w = load(path)
        sigma = calibrate_sigma(outside)
        hi_sp, hi_dis, rest = strata(D, w)
        print(f"\n=== {study}: {len(D)} questions; strata sizes: high self-preference {hi_sp.sum()}, "
              f"high disagreement/low self-preference {hi_dis.sum()}, rest {rest.sum()}")
        for share in (0.0, 0.5):
            latent = (1 - share) * outside + share * own
            for design in ("random", "stratified"):
                est, n2, n3 = [], [], []
                for _ in range(N_SIMS):
                    idx, wts = draw(design, D, w)
                    phys = sim_phys(latent[idx], 2, sigma)
                    est.append(share_estimate(own[idx], outside[idx], phys, wts))
                    n2.append((D[idx] >= 2).sum())
                    n3.append((D[idx] >= 3).sum())
                est = np.array(est)
                # rescale to the share scale with the full-agreement benchmark
                bench = share_estimate(own, outside, sim_phys(own, 2, sigma), np.ones(len(own)))
                e = est / bench
                print(f"  true share {share:.1f} | {design:10s} | mean estimate {e.mean():+.2f} | "
                      f"spread (95% of runs) +/-{1.96 * e.std():.2f} | pairs with lift >=2: {np.mean(n2):.0f}, "
                      f">=3: {np.mean(n3):.0f}")


if __name__ == "__main__":
    main()
