"use client";

import { useState } from "react";
import { STUDIES, STUDY_IDS, type StudyId } from "@/lib/studies";
import type { ReviewerProgress, StudyProgress, ValidationReport } from "@/server/admin";
import type { PlanStatus } from "@/server/plans";
import { StudyPlanCard, type EligibleReviewer } from "./StudyPlanCard";
import { Button, Card, cx, Pill, SectionLabel } from "./ui";

type SerializedStudy = Omit<StudyProgress, "submittedAt" | "lastSavedAt"> & { submittedAt: string | null; lastSavedAt: string | null };
export type Reviewer = Omit<ReviewerProgress, "studies"> & { studies: SerializedStudy[] };

const DATASETS = [
  ["rankings", "Physician rankings", "One row per reviewer × question × response with final rank and confirmation."],
  ["rubric_scores", "Physician rubric scores", "Five 0–5 scores per response with mean and sum."],
  ["error_annotations", "Clinical error annotations", "Separate instrument: error flag, categories, note."],
  ["assignments", "Assignments & completion", "Queue, stored presentation order, status, timestamps, active time."],
  ["llm_judgments", "Original LLM judgments", "Every judge's rank and scores for imported questions."],
  ["response_key", "Response key (unblinding)", "response_id → generator model and original generation_id."],
  ["analysis", "Analysis-ready join", "Physician judgments × every LLM judge for the same response, joined by ID."],
  ["plan", "Study plans", "Every planned case with its block (or calibration) and its graders by position."],
  ["reviewers", "Reviewer background", "Reviewer code, specialty and years in practice; no names."],
] as const;

async function post(url: string, body: unknown) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (HTTP ${res.status})`);
  return data;
}

export function AdminPanel({
  reviewers,
  itemCounts,
  validation,
  studySeeds,
  plans,
  eligible,
  defaultPlanSeeds,
}: {
  reviewers: Reviewer[];
  itemCounts: Record<StudyId, number>;
  validation: ValidationReport;
  studySeeds: Record<StudyId, string | null>;
  plans: Record<StudyId, PlanStatus | null>;
  eligible: Record<StudyId, EligibleReviewer[]>;
  defaultPlanSeeds: Record<StudyId, string>;
}) {
  const [message, setMessage] = useState<{ tone: "done" | "danger"; text: string } | null>(null);
  const run = async (fn: () => Promise<string | void>) => {
    try {
      const text = await fn();
      if (text) setMessage({ tone: "done", text });
      else window.location.reload();
    } catch (e) {
      setMessage({ tone: "danger", text: e instanceof Error ? e.message : "Request failed" });
    }
  };

  const physicians = reviewers.filter((r) => r.role === "reviewer");
  const totals = physicians
    .flatMap((r) => r.studies)
    .reduce((a, s) => ({ assigned: a.assigned + s.assigned, complete: a.complete + s.complete }), { assigned: 0, complete: 0 });

  return (
    <main className="mx-auto max-w-[1300px] space-y-6 px-6 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Study administration</h1>
          <p className="text-sm text-muted">Physicians cannot access this page. Evaluation content is not shown here.</p>
        </div>
      </div>

      {message && (
        <div
          role="status"
          className={cx(
            "sticky top-3 z-20 flex items-start justify-between gap-3 rounded-xl border px-4 py-3 text-sm shadow-md",
            message.tone === "done" ? "border-done-line bg-done-soft text-done" : "border-[#f5c2bd] bg-danger-soft text-danger",
          )}
        >
          <span className="whitespace-pre-wrap select-all">{message.text}</span>
          <button type="button" className="underline" onClick={() => setMessage(null)}>
            Dismiss
          </button>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Imported"
          value={STUDY_IDS.map((s) => `${itemCounts[s]} ${STUDIES[s].name}`).join(" · ")}
        />
        <Stat label="Physician reviewers" value={physicians.length} />
        <Stat label="Assignments completed" value={`${totals.complete} / ${totals.assigned}`} />
        <Card className="p-4">
          <div className="text-sm text-muted">Data mapping check</div>
          <div className="mt-1 flex items-center gap-2">
            {validation.ok ? <Pill tone="done">All checks passed</Pill> : <Pill tone="danger">{validation.problems.length} problems</Pill>}
          </div>
          <div className="mt-1 text-xs text-muted">
            {validation.responses} responses · {validation.judgmentRows} LLM judgment rows
          </div>
        </Card>
      </div>

      {!validation.ok && (
        <Card className="p-4">
          <SectionLabel className="mb-2">Validation problems</SectionLabel>
          <ul className="list-disc space-y-1 pl-5 font-mono text-xs text-danger">
            {validation.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
          <div>
            <h2 className="font-semibold">Reviewers and assignments</h2>
            <p className="mt-0.5 text-xs text-muted">Numbers match the frozen question order within each study.</p>
          </div>
          <QuestionLegend />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-subtle text-left text-xs uppercase tracking-wider text-muted">
              <tr>
                {["Code", "Reviewer", "Role", "Assigned question numbers", "Progress", "Last saved", ""].map((h) => (
                  <th key={h} className="px-4 py-2 font-semibold">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {reviewers.map((r) => (
                <tr key={r.userId} className={cx("border-t border-line", !r.active && "opacity-50")}>
                  <td className="px-4 py-2.5 font-mono font-semibold">{r.reviewerCode}</td>
                  <td className="px-4 py-2.5">
                    {r.username}
                    {r.displayName && <span className="block text-xs text-muted">{r.displayName}</span>}
                    {(r.specialty || r.yearsInPractice !== null) && (
                      <span className="block text-xs text-muted">
                        {[r.specialty, r.yearsInPractice !== null ? `${r.yearsInPractice} yrs` : null].filter(Boolean).join(" · ")}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">{r.role}</td>
                  <td className="min-w-72 px-4 py-2.5">
                    {r.studies.length === 0 ? (
                      <span className="text-muted">{r.role === "admin" ? "—" : "No questions assigned"}</span>
                    ) : (
                      <div className="space-y-2.5">
                        {r.studies.map((st) => (
                          <div key={st.study}>
                            <div className="mb-1 text-xs font-medium text-ink-2">{STUDIES[st.study].name}</div>
                            <div className="flex max-w-xl flex-wrap gap-1" aria-label={`${STUDIES[st.study].name} assigned questions`}>
                              {st.questions.map((q) => (
                                <QuestionNumber key={q.number} number={q.number} status={q.status} />
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="min-w-52 px-4 py-2.5">
                    {r.studies.length === 0 ? (
                      <span className="text-muted">—</span>
                    ) : (
                      <div className="space-y-2.5">
                        {r.studies.map((st) => (
                          <div key={st.study}>
                            <div className="flex items-center gap-2">
                              <div className="h-2 w-20 overflow-hidden rounded-full bg-line">
                                <div className="h-full bg-done" style={{ width: st.assigned ? `${(st.complete / st.assigned) * 100}%` : 0 }} />
                              </div>
                              <span className="tabular-nums text-ink-2">
                                {st.complete} of {st.assigned} done
                              </span>
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-1.5">
                            {st.submittedAt ? (
                              <>
                                <Pill tone="done">Submitted</Pill>
                                <Button
                                  size="sm"
                                  onClick={() =>
                                    run(async () => void (await post("/api/admin/reopen", { userId: r.userId, study: st.study })))
                                  }
                                >
                                  Reopen
                                </Button>
                              </>
                            ) : st.complete === st.assigned ? (
                              <Pill tone="progress">Ready to submit</Pill>
                            ) : st.inProgress > 0 ? (
                              <span className="text-xs text-progress">{st.inProgress} in progress</span>
                            ) : null}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    {!r.active && <Pill className="mt-1">Inactive</Pill>}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-muted">
                    {(() => {
                      const last = r.studies.map((st) => st.lastSavedAt).filter(Boolean).sort().at(-1);
                      return last ? new Date(last).toLocaleString() : "—";
                    })()}
                  </td>
                  <td className="space-x-1 whitespace-nowrap px-4 py-2.5 text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        run(async () => {
                          if (!window.confirm(`Reset the password for ${r.username}?`)) return "Cancelled";
                          const d = await post("/api/admin/reviewers", { action: "reset_password", userId: r.userId });
                          return `New temporary password for ${r.username}: ${d.password}\nShare it securely; it will not be shown again.`;
                        })
                      }
                    >
                      Reset password
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => run(async () => void (await post("/api/admin/reviewers", { action: "set_active", userId: r.userId, active: !r.active })))}
                    >
                      {r.active ? "Deactivate" : "Activate"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <section aria-labelledby="plans-heading" className="space-y-3">
        <div>
          <h2 id="plans-heading" className="text-lg font-semibold">
            Study plans
          </h2>
          <p className="text-sm text-muted">Assign every physician their cases at once: calibration cases for everyone, then rotating blocks.</p>
        </div>
        {STUDY_IDS.map((st) => (
          <StudyPlanCard
            key={st}
            study={st}
            itemCount={itemCounts[st]}
            status={plans[st]}
            eligible={eligible[st]}
            defaultSeed={defaultPlanSeeds[st]}
            run={run}
          />
        ))}
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <CreateReviewerForm run={run} />
        <Card className="p-5">
          <h2 className="mb-1 font-semibold">Importing questions</h2>
          <p className="text-sm text-ink-2">
            Questions are imported from the prepared study bundles with <code className="font-mono text-xs">npm run db:import</code>. The
            importer is insert-only and refuses to change any original response.
          </p>
          <dl className="mt-3 space-y-1 text-sm">
            {STUDY_IDS.map((st) => (
              <div key={st} className="flex gap-2">
                <dt className="w-24 text-ink-2">{STUDIES[st].name}</dt>
                <dd>
                  {itemCounts[st]} {STUDIES[st].unitNoun}s · seed <code className="font-mono text-xs">{studySeeds[st] ?? "not set"}</code>
                </dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>

      <Card>
        <div className="border-b border-line px-5 py-3">
          <h2 className="font-semibold">Exports</h2>
          <p className="text-xs text-muted">
            Reviewers appear only as pseudonymous codes; admin test evaluations are excluded. Column definitions are in docs/DATA_DICTIONARY.md.
          </p>
        </div>
        <ul>
          {DATASETS.map(([key, title, desc]) => (
            <li key={key} className="flex flex-wrap items-center gap-3 border-t border-line px-5 py-3 first:border-t-0">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{title}</div>
                <div className="text-xs text-muted">{desc}</div>
              </div>
              <a className="rounded-md border border-line px-3 py-1 text-sm hover:bg-subtle" href={`/api/admin/export?dataset=${key}&format=csv`}>
                CSV
              </a>
              <a className="rounded-md border border-line px-3 py-1 text-sm hover:bg-subtle" href={`/api/admin/export?dataset=${key}&format=json`}>
                JSON
              </a>
            </li>
          ))}
        </ul>
      </Card>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <Card className="p-4">
      <div className="text-sm text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
    </Card>
  );
}

type QuestionStatus = SerializedStudy["questions"][number]["status"];

const QUESTION_STYLES: Record<QuestionStatus, string> = {
  not_started: "border-line bg-surface text-muted",
  in_progress: "border-progress-line bg-progress-soft text-progress",
  complete: "border-done-line bg-done-soft text-done",
};

const QUESTION_LABELS: Record<QuestionStatus, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  complete: "Complete",
};

function QuestionNumber({ number, status }: { number: number; status: QuestionStatus }) {
  return (
    <span
      title={`Question ${number} · ${QUESTION_LABELS[status]}`}
      aria-label={`Question ${number}, ${QUESTION_LABELS[status]}`}
      className={cx(
        "inline-flex h-7 min-w-7 items-center justify-center rounded-md border px-1.5 text-xs font-semibold tabular-nums",
        QUESTION_STYLES[status],
      )}
    >
      {number}
    </span>
  );
}

function QuestionLegend() {
  return (
    <div className="flex flex-wrap items-center gap-3 text-xs text-muted" aria-label="Question status legend">
      {(Object.keys(QUESTION_LABELS) as QuestionStatus[]).map((status) => (
        <span key={status} className="inline-flex items-center gap-1.5">
          <span className={cx("h-3 w-3 rounded-sm border", QUESTION_STYLES[status])} aria-hidden />
          {QUESTION_LABELS[status]}
        </span>
      ))}
    </div>
  );
}

type Run = (fn: () => Promise<string | void>) => Promise<void>;
const inputCls = "mt-1 block h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm";

function CreateReviewerForm({ run }: { run: Run }) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [specialty, setSpecialty] = useState("");
  const [years, setYears] = useState("");
  const [created, setCreated] = useState<{ username: string; reviewerCode: string; password: string } | null>(null);
  const [copied, setCopied] = useState(false);
  return (
    <Card className="p-5">
      <h2 className="mb-1 font-semibold">Add reviewer</h2>
      <p className="mb-4 text-sm text-muted">
        A pseudonymous reviewer code is generated automatically and used in all exports. The temporary password is shown once.
      </p>
      <div className="mb-4 grid grid-cols-2 gap-3">
        <label className="text-sm font-medium">
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} className={inputCls} autoComplete="off" />
        </label>
        <label className="text-sm font-medium">
          Display name (optional)
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} className={inputCls} autoComplete="off" />
        </label>
        <label className="text-sm font-medium">
          Specialty (optional)
          <input value={specialty} onChange={(e) => setSpecialty(e.target.value)} className={inputCls} autoComplete="off" />
        </label>
        <label className="text-sm font-medium">
          Years in practice (optional)
          <input type="number" min={0} max={70} value={years} onChange={(e) => setYears(e.target.value)} className={inputCls} />
        </label>
      </div>
      <Button
        variant="primary"
        disabled={username.trim().length < 3}
        onClick={() =>
          run(async () => {
            const d = await post("/api/admin/reviewers", {
              action: "create",
              username,
              displayName: displayName || undefined,
              specialty: specialty || undefined,
              yearsInPractice: years === "" ? undefined : Number(years),
              role: "reviewer",
            });
            setCreated({ username: d.username, reviewerCode: d.reviewerCode, password: d.password });
            setCopied(false);
            setUsername("");
            setDisplayName("");
            setSpecialty("");
            setYears("");
            return `Created ${d.username} (${d.reviewerCode}). Their temporary password is shown in the Add reviewer card below.`;
          })
        }
      >
        Create reviewer
      </Button>
      {created && (
        <div role="status" className="mt-4 rounded-lg border border-done-line bg-done-soft p-4 text-sm">
          <p className="font-medium text-done">
            Created {created.username} ({created.reviewerCode}). Copy this temporary password now; it is shown only once.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="select-all rounded-md border border-done-line bg-surface px-3 py-1.5 font-mono text-base text-ink">{created.password}</code>
            <Button
              size="sm"
              onClick={async () => {
                await navigator.clipboard.writeText(created.password).catch(() => undefined);
                setCopied(true);
              }}
            >
              {copied ? "Copied" : "Copy password"}
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted">Lost it? Use Reset password next to their name in the reviewers table. Reload to see them in the plan cards.</p>
        </div>
      )}
    </Card>
  );
}

