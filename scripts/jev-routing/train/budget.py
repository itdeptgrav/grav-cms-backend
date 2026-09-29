"""Hard spending ceiling for the bounded RTX PRO 4500 Blackwell experiment.

    python budget.py status
    python budget.py check --phase stage1 --remaining preflight,stage1,smoke_main,smoke_resume,adapter_eval
    python budget.py timeout --phase stage1          # seconds the phase may run before the ceiling
    python budget.py measured --phase stage1 --seconds 912    (records a real duration; later projections use it)

Conservative by construction:
  * price  — JEV_POD_HOURLY_USD, typed in by the operator from the RunPod console.
             Missing, non-numeric, zero, negative or implausible (> $5/h) → stop.
  * age    — age of PID 1 (the container's first process) from /proc, plus a fixed
             PROVISIONING_MARGIN for time billed before the container started
             (image pull). Unreadable → stop.
  * reserve — COLLECT_RESERVE seconds are always kept for collecting evidence.
  * projection before a phase = age + margin + every remaining phase's estimate +
             reserve. Estimates start at 2x the RTX 4000 Ada measurements and are
             replaced by conservative multiples of what this pod actually measured.
A phase whose projection exceeds CEILING_USD is refused; a phase that runs long is
killed by `timeout` at the ceiling.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
from pathlib import Path

CEILING_USD = 2.00
PROVISIONING_MARGIN = 600
COLLECT_RESERVE = 300
MAX_PLAUSIBLE_RATE = 5.0

# RTX 4000 Ada measured 25 Sep 2026 (results.tgz cb619591…), doubled: Blackwell
# throughput under strict determinism and math-only attention is unknown.
ADA_SECONDS = {"preflight": 240, "stage1": 877, "smoke_main": 1260, "smoke_resume": 700, "adapter_eval": 877}
DEFAULT_ESTIMATES = {k: 2 * v for k, v in ADA_SECONDS.items()}
# Measured on the first Blackwell pod: cached/pinned downloads plus 44 tests completed in 81 s.
# Use over 3x that measurement for a fresh RTX PRO 4500 pod.
DEFAULT_ESTIMATES["setup"] = 300


class BudgetError(RuntimeError):
    pass


def hourly_rate(environ=os.environ) -> float:
    raw = environ.get("JEV_POD_HOURLY_USD", "").strip()
    try:
        rate = float(raw)
    except ValueError:
        raise BudgetError(f"JEV_POD_HOURLY_USD is not set to a number ({raw!r}); the price cannot be established")
    if not (0 < rate <= MAX_PLAUSIBLE_RATE) or math.isnan(rate):
        raise BudgetError(f"JEV_POD_HOURLY_USD={rate} is not a plausible hourly price")
    return rate


def pod_age_seconds(environ=os.environ) -> int:
    test = environ.get("JEV_TEST_POD_AGE_FILE")  # test seam for the local stop-condition suite
    try:
        if test:
            return int(Path(test).read_text().strip())
        uptime = float(Path("/proc/uptime").read_text().split()[0])
        start_ticks = int(Path("/proc/1/stat").read_text().rsplit(")", 1)[1].split()[19])
        age = int(uptime - start_ticks / os.sysconf("SC_CLK_TCK"))
    except Exception as err:  # noqa: BLE001
        raise BudgetError(f"pod age cannot be established: {err}")
    if age < 0:
        raise BudgetError("pod age is negative")
    return age


def spend(age: int, rate: float) -> float:
    return (age + PROVISIONING_MARGIN) / 3600 * rate


def ceiling_seconds(rate: float) -> int:
    return int(CEILING_USD / rate * 3600)


def estimates(state_file: Path | None) -> dict:
    est = dict(DEFAULT_ESTIMATES)
    if state_file and state_file.exists():
        measured = json.loads(state_file.read_text())
        if "preflight" in measured:
            est["preflight"] = max(est["preflight"], int(measured["preflight"] * 1.5))
        if "stage1" in measured:  # the adapter evaluation is the same work as Stage 1
            est["adapter_eval"] = max(int(measured["stage1"] * 1.25), 300)
        if "smoke_main" in measured:  # 50 of 100 steps + load + one validation + export
            est["smoke_resume"] = max(int(measured["smoke_main"] * 0.75) + 300, 600)
    return est


def projection(age: int, rate: float, remaining: list[str], est: dict) -> dict:
    seconds = age + PROVISIONING_MARGIN + sum(est[p] for p in remaining) + COLLECT_RESERVE
    return {"age_seconds": age, "rate_usd_per_hour": rate, "spent_usd": round(spend(age, rate), 4),
            "remaining_phases": remaining, "remaining_estimate_seconds": sum(est[p] for p in remaining),
            "projected_total_seconds": seconds, "projected_usd": round(seconds / 3600 * rate, 4),
            "ceiling_usd": CEILING_USD, "within_ceiling": seconds / 3600 * rate <= CEILING_USD}


def phase_timeout(age: int, rate: float) -> int:
    return ceiling_seconds(rate) - age - PROVISIONING_MARGIN - COLLECT_RESERVE


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["status", "check", "timeout", "measured"])
    ap.add_argument("--phase")
    ap.add_argument("--remaining", default="")
    ap.add_argument("--seconds", type=int)
    ap.add_argument("--state", default=os.environ.get("JEV_BUDGET_STATE", ""))
    a = ap.parse_args(argv)
    state = Path(a.state) if a.state else None
    try:
        rate = hourly_rate()
        age = pod_age_seconds()
    except BudgetError as err:
        print(json.dumps({"budget": "unavailable", "error": str(err)}))
        return 5
    if a.cmd == "measured":
        data = json.loads(state.read_text()) if state and state.exists() else {}
        data[a.phase] = a.seconds
        state.write_text(json.dumps(data, indent=2) + "\n")
        return 0
    if a.cmd == "status":
        print(json.dumps({"age_seconds": age, "rate_usd_per_hour": rate, "spent_usd": round(spend(age, rate), 4),
                          "ceiling_usd": CEILING_USD, "over_ceiling": spend(age, rate) > CEILING_USD}))
        return 0 if spend(age, rate) <= CEILING_USD else 5
    if a.cmd == "timeout":
        t = phase_timeout(age, rate)
        print(t)
        return 0 if t > 0 else 5
    remaining = [p for p in a.remaining.split(",") if p]
    proj = projection(age, rate, remaining, estimates(state))
    print(json.dumps({"phase": a.phase, **proj}))
    return 0 if proj["within_ceiling"] else 5


if __name__ == "__main__":
    sys.exit(main())
