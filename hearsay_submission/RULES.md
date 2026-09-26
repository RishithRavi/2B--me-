# Hearsay rules — awaiting official sources

Person A owns confirmation from the official PDF / HackGT Hearsay channel.
The implementation plan is provisional, not an organizer source. Nothing has
been submitted. All unknowns below remain configurable or unset.

| Question | Status / source |
|---|---|
| Score direction and allowed range | Unconfirmed |
| Metric code, attack prior and costs | Unconfirmed; local config holds plan's two candidate costs |
| Template, exact header, filename and test download | Unconfirmed |
| Registry, amd64 requirement, GPU/network/time/memory limits | Unconfirmed |
| Draft review / leaderboard path and deadline | Unconfirmed |
| Final submission deadline | Unconfirmed |
| DiffSSD split and external-data policy | Unconfirmed; no training or test fitting performed |
| Fingerprinting policy | Unconfirmed; no fingerprint matching implemented |
| Techniques and agentic-orchestration judging | Unconfirmed |
| Team filename | Unconfirmed |

Resolved internal formula: Claude confirmed `(rankdata(llr, 'average') - 0.5)/N`
in `contracts/REQUESTS.md`. The default now uses `-0.5`; official score direction,
range and other organizer rules still require confirmation.
