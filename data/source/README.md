# Frozen study source

This directory is the canonical, repository-owned input for both physician-evaluation
studies. Running `npm run data:prepare` needs only these files; it does not clone or read
the original research repository.

| File | Rows | Contents |
|---|---:|---|
| `real-pocqi-questions.jsonl` | 620 | Complete Real-POCQi question population, specialties and original provenance |
| `real-pocqi-answers.jsonl` | 4,960 | Eight exact judged model answers per question, with stable IDs, hashes and generator provenance |
| `real-pocqi-llm-judgments.jsonl` | 39,680 | Eight judges' rank and five-axis scores for every answer |
| `real-pocqi-manifest.json` | — | Real-POCQi provenance, sampling description, row counts and checksums |
| `medsp1000-scenarios.jsonl` | 200 | Complete scenario population, including clinician and patient-simulator source context |
| `medsp1000-conversations.jsonl` | 1,600 | Eight exact judged eight-turn conversations per scenario |
| `medsp1000-llm-judgments.jsonl` | 12,800 | Eight judges' rank and five-axis scores for every conversation |
| `medsp1000-manifest.json` | — | MedSP1000 provenance, sampling description, row counts and checksums |

The answer and judgment files contain model identities for later analysis. They are
protected from reviewers by the application boundary: physician-facing server code never
reads the provenance or LLM-judgment tables.

The JSONL artifacts contain every Real-POCQi question and MedSP1000 scenario for which the
experiment has the complete eight candidates and eight production judgments. Preparation
validates the full populations before drawing each study's 100-item sample. Original commit
IDs are recorded separately in the two manifests.
