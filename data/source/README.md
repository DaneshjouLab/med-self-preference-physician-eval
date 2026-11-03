# Frozen study source

This directory is the canonical, repository-owned input for the Real-POCQi physician
evaluation. Running `npx tsx scripts/prepare-data.ts` needs only these files; it does not
clone or read the original research repository. MedSP1000 is prepared separately from the
pinned research checkout.

| File | Rows | Contents |
|---|---:|---|
| `real-pocqi-questions.jsonl` | 100 | Frozen Real-POCQi questions, specialties, sample order and original provenance |
| `real-pocqi-answers.jsonl` | 800 | Eight exact model answers per question, with stable IDs, hashes and generator provenance |
| `real-pocqi-llm-judgments.jsonl` | 6,400 | Eight judges' rank and five-axis scores for every answer |
| `manifest.json` | — | Original repository/commit, sampling description, row counts and SHA-256 checksums |

The answer and judgment files contain model identities for later analysis. They are
protected from reviewers by the application boundary: physician-facing server code never
reads the provenance or LLM-judgment tables.

The JSONL artifacts were extracted from the already prepared 100-question bundle without
changing question text, answer text, IDs, scores, ranks or provenance. The original source
is `DaneshjouLab/Medical-LLM-Self-Preference` at commit
`a40d3617a2e55cb6fe4255198a4b05ba774c3f4c`.
