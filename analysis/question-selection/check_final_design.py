"""Step 3 of 3: check that the final design actually works, vs just picking 100 at random.

What this is for:
    Backs up the "Trying to back up option 4 w stats" table in the doc. The worry with
    any non-random sample is that it skews the result or makes it noisier. So this
    simulates both designs 1,000 times on the real judge rankings and compares them.
    (How the fake physicians work is explained at the top of selection_design.py.)

How to run:
    From the app repo's data/source/ folder, with selection_design.py in the same
    folder as this file:
        python3 check_final_design.py
    Output is saved in check_final_design_output.txt. Takes ~10 seconds.

What the output columns mean:
    share 0.0 / 0.5 = the "truth" we planted (0 = physicians side with the other 7
                      judges, 0.5 = physicians halfway toward the own judge)
    estimate +/-    = average estimate across the 1,000 runs, and the range that 95%
                      of runs fall in. Average close to the planted share = no bias.
                      Smaller +/- = more precise
    own answers lifted >=2 places, per judge
                    = for each judge, how many of its own answers in the sample it lifted
                      2+ places. "min" is the judge that got the fewest. This is the
                      number Reviewer 2's question depends on (can't say whether a judge
                      favors its own wrong answers if we only see ~4 of its lifts)

Note: this re-draws the sample with fresh random numbers every run, so it checks
the design in general, not just the one list in selected_questions_<study>.csv.
The H/L split here is the same as select_questions.py.
"""
import sys
import numpy as np
sys.path.insert(0, __file__.rsplit("/", 1)[0])  # so it finds selection_design.py next to it
import selection_design as S

S.N_SIMS = 1000


def zsplit(D):
    # same H pool as select_questions.py: z-score each judge's lifts against that
    # judge's own usual range, take each question's most unusual lift, top 20% → H.
    # zj = which judge that most unusual lift belongs to
    z = (D - D.mean(axis=0)) / D.std(axis=0, ddof=1)
    zp, zj = z.max(axis=1), z.argmax(axis=1)
    H = zp >= np.sort(zp)[int(0.8 * (len(zp) - 1))]
    return H, zj


def draw_final(D, H, zj):
    # one random draw of the final design: up to 5 H questions per judge, rest from L,
    # with weight = pool size / number picked (same as select_questions.py)
    idx, wt = [], []
    for j in range(8):
        pool = np.flatnonzero(H & (zj == j))
        k = min(5, len(pool))
        if k:
            idx += list(S.RNG.choice(pool, k, replace=False))
            wt += [len(pool) / k] * k
    L = np.flatnonzero(~H)
    nl = 100 - len(idx)
    idx += list(S.RNG.choice(L, nl, replace=False))
    wt += [len(L) / nl] * nl
    return np.array(idx), np.array(wt)


for study, path in S.STUDIES.items():
    own, out, D, w = S.load(path)
    sig = S.calibrate_sigma(out)
    # benchmark for rescaling: the slope you'd get using every question with physicians
    # who fully agree with the own judge. Dividing by it puts estimates on the 0 to 1 scale
    bench = S.share_estimate(own, out, S.sim_phys(own, 2, sig), np.ones(len(own)))
    H, zj = zsplit(D)
    print(f"\n=== {study}")
    for share in (0.0, 0.5):
        lat = (1 - share) * out + share * own  # the planted "true" quality physicians see
        for design in ("random", "final"):
            e, per_judge = [], []
            for _ in range(S.N_SIMS):
                if design == "random":
                    idx = S.RNG.choice(len(D), 100, replace=False)
                    wt = np.ones(100)  # simple random sample, every question counts the same
                else:
                    idx, wt = draw_final(D, H, zj)
                ph = S.sim_phys(lat[idx], 2, sig)  # 2 fake physicians per question
                e.append(S.share_estimate(own[idx], out[idx], ph, wt) / bench)
                per_judge.append((D[idx] >= 2).sum(axis=0))
            e = np.array(e)
            pj = np.mean(per_judge, axis=0)
            print(f"  share {share:.1f} | {design:6s} | estimate {e.mean():+.2f} +/-{1.96 * e.std():.2f} | "
                  f"own answers lifted >=2 places, per judge: min {pj.min():.0f}, median {np.median(pj):.0f}, max {pj.max():.0f}")
