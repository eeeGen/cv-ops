# Upstream provenance

This manifest fixes every imported upstream file to a reproducible source object.
CV-ops must never resolve these files from a floating branch at runtime.

## Approved sources

| Source | Immutable revision | Approved location | License | Attribution chain |
| --- | --- | --- | --- | --- |
| `career-ops` | `da8c6f9193ac3d7a48a583f815b7d0feab742b81` | `https://github.com/career-ops-hq/career-ops` (official remote `main` snapshot) | MIT; `Copyright (c) 2026 Santiago Fernández de Valderrama` | `career-ops-hq/career-ops` -> `CV-ops` |
| `ai-job-search-codex` | `1a116b3c6492347e040d0546135c9b4c70540fbb` | committed object from `E:\Project\ai-job-search-codex` only | MIT; `Copyright (c) 2026 Mads Lorentzen` | `MadsLorentzen/ai-job-search` (recorded `origin` fetch/push) -> local `ai-job-search-codex` Codex port -> `CV-ops` |

The local `ai-job-search-codex` working tree is not a source. Only files read
from the registered Git object above are represented here; its modified and
untracked files are excluded. `career-ops` was obtained only from the official
remote above. CV-ops does not clone or consume the original `ai-job-search`
remote directly.

## Imported files

Every row was copied byte-for-byte without a patch. The SHA-256 value applies
to both the stated source Git object and destination Git blob. Hashes are
computed from `git show <revision>:<path>` bytes, never from a line-ending-
converting working tree.

| Source | Source path | Destination path | SHA-256 |
| --- | --- | --- | --- |
| career-ops | `LICENSE` | `upstream/career-ops/LICENSE` | `51989d2589b2aa87ca6cbb253391bcb476a21cbafdc71eea4410548538510870` |
| career-ops | `verify-ats.mjs` | `upstream/career-ops/verify-ats.mjs` | `11c12ee06f50b78831402079fe0d2a33bdbeede32c294a8653a3a1e4549be674` |
| career-ops | `verify-cv-facts.mjs` | `upstream/career-ops/verify-cv-facts.mjs` | `d88f6fecef65a327061e21267bc5bbd9d00743bffb0556920fc2f7da97380a2c` |
| career-ops | `jd-skill-gap.mjs` | `upstream/career-ops/jd-skill-gap.mjs` | `4e6e1617d81dc8ca4d2848716e753e4a9b28390836ab5bdf051ebd410ee15e8b` |
| career-ops | `skill-extract.mjs` | `upstream/career-ops/skill-extract.mjs` | `886886590ef8638de84941f045bfbc8d5ba2b1d1dbeaa36b94817bc6d89eb219` |
| career-ops | `lib/is-main-module.mjs` | `upstream/career-ops/lib/is-main-module.mjs` | `4e61a2a34a4b5cecd5f7ff21fe46c935a1e99650a48c3555b1b1359ec0c30ed7` |
| ai-job-search-codex | `LICENSE` | `upstream/ai-job-search-codex/LICENSE` | `accbf0accb87b7b905dd7ee0c7013075f0453637acf354ddae6fc0e4d8282e8e` |
| ai-job-search-codex | `.claude/commands/setup.md` | `upstream/ai-job-search-codex/.claude/commands/setup.md` | `ee6ddee2adbc28e3eb9b7b95fca5438c37efc0c58f33a0baa5d35146cfd400a2` |
| ai-job-search-codex | `.claude/commands/rank.md` | `upstream/ai-job-search-codex/.claude/commands/rank.md` | `2588cacdf7ae356aa63066d93370bdac295e8d0548d355d53bbffcf95f06bffb` |
| ai-job-search-codex | `.claude/commands/apply.md` | `upstream/ai-job-search-codex/.claude/commands/apply.md` | `d8b31b3e670987c1dcbafd34317f7121904b15c870ab15e612f8086a15f335d8` |
| ai-job-search-codex | `.claude/skills/job-application-assistant/03-writing-style.md` | `upstream/ai-job-search-codex/.claude/skills/job-application-assistant/03-writing-style.md` | `d76148b7bc803ff2954a0bcd839c0fca2999af1349ece3f020e70d2048a30f9f` |
| ai-job-search-codex | `.claude/skills/job-application-assistant/04-job-evaluation.md` | `upstream/ai-job-search-codex/.claude/skills/job-application-assistant/04-job-evaluation.md` | `0c48d15890c9c24d7cdfcad048f4c35a75efe42f23b42a9a44128e5d672c0b9f` |
| ai-job-search-codex | `.claude/skills/job-application-assistant/05-cv-templates.md` | `upstream/ai-job-search-codex/.claude/skills/job-application-assistant/05-cv-templates.md` | `93ffc9a9ec813d4b8499f1ea7c364abe1cb7fe8526ed2329e142b9eaa483c158` |
| ai-job-search-codex | `.claude/skills/job-application-assistant/06-cover-letter-templates.md` | `upstream/ai-job-search-codex/.claude/skills/job-application-assistant/06-cover-letter-templates.md` | `48500354d76490ea9cd48a0fd5be54d02496d8df297a2e4086c6e4e6bcacda78` |
| ai-job-search-codex | `tools/rank_state.py` | `upstream/ai-job-search-codex/tools/rank_state.py` | `5703f22d6015f9502f570acb943b33c40baaa159e68810b4d5e79887f77e120d` |
| ai-job-search-codex | `tools/verify_pdf.py` | `upstream/ai-job-search-codex/tools/verify_pdf.py` | `43d8ea932431ddf28ee7443f41738b94c63583d2ac670946a679a8d9e754a3b1` |
| ai-job-search-codex | `tests/test_rank_command.py` | `upstream/ai-job-search-codex/tests/test_rank_command.py` | `0328ca05cbe8112826d8b24f31e22b85412bd58e7a633a857ab6c6d802965f91` |
| ai-job-search-codex | `tests/test_rank_state.py` | `upstream/ai-job-search-codex/tests/test_rank_state.py` | `aba91da3653cdcad1a9917a8d619a4c83a475e3894a9459ca5679219fa5f84fd` |
| ai-job-search-codex | `tests/test_security_guards.py` | `upstream/ai-job-search-codex/tests/test_security_guards.py` | `df0e299bddd5078c8eaa38441fb1f81e7bd3b92a619d6842448fcbbf72cf3bf5` |
| ai-job-search-codex | `tests/test_verify_pdf.py` | `upstream/ai-job-search-codex/tests/test_verify_pdf.py` | `3482fbb890737e7dba65e77c57c4ff420ae7571c4eac7cefa887f865e8bf97a0` |

## Scope and patch status

The career-ops import is the narrow, direct rule set needed for later keyword,
fact, and ATS adapters, including its direct `is-main-module` helper. The
ai-job-search-codex import contains only general setup, ranking, application,
writing/template, PDF-verification rules and their focused original tests.
Candidate-profile files (`01-candidate-profile.md`, `02-behavioral-profile.md`),
working-tree-only Codex adaptations, private materials, generated output, and
all unrelated workflow files are deliberately absent.

No `patches/` entry exists for Task 1: every imported file is unmodified.
Any later adaptation must be placed outside `upstream/`, must not change the
hashes above, and must explain its rationale in a separately audited patch.

## License and privacy checks

`LICENSE` is CV-ops's MIT license. Each upstream's complete, original MIT text
is retained in its own `upstream/*/LICENSE`; `NOTICE` records the relevant
copyright and source chain.

Before import, the selected source files were scanned with redacted checks for
email addresses, phone-shaped strings, private-key blocks, and credential
assignments. No private-key block or credential assignment was found. The nine
email-shaped literals all use `example.com`; numeric findings are source/test
fixtures, parser patterns, or date/version-shaped literals and require no
candidate material. The scan is repeated against the destination during Task 1
verification and again before release.
