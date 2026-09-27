"""CPU-only tests for grav_jev_train.py. Import no torch; touch no model.

    python -m unittest discover -s scripts/jev-routing/train -p 'test_*.py'
"""
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import grav_jev_train as t  # noqa: E402
import audit_validation_snapshot as audit_snapshot  # noqa: E402

CONFIGS = Path(__file__).resolve().parent / "configs"


def write_view(directory: Path, extra=()):
    files = {}
    for split in ("train", "calibration", "validation"):
        p = directory / f"{split}.jsonl"
        p.write_text(json.dumps({"id": f"{split}-1", "split": split}) + "\n")
        files[p.name] = t.file_sha256(p)
    (directory / "manifest.json").write_text(json.dumps({"generator_version": "grav-acc-routing-v2", "files_sha256": files}))
    for name in extra:
        (directory / name).write_text("{}\n")
    return t.file_sha256(directory / "manifest.json")


class ConfigTests(unittest.TestCase):
    def test_shipped_smoke_config_loads(self):
        c = t.load_config(CONFIGS / "smoke.json")
        self.assertEqual(c["base_revision"], "15852e8c16360a2fea060d615a32b45270f8a8fc")
        self.assertEqual(c["init_manifest_sha256"], "58319da5c2a948a4645e46d9c982be44867d78779ea1c3bfb81b64867f58ef3a")
        self.assertEqual(c["lora_rank"], 8, "must match the released package to warm-start")

    def test_smoke_is_100_steps(self):
        self.assertEqual(t.load_config(CONFIGS / "smoke.json")["steps"], 100)

    def test_safety_balanced_config_uses_full_validation(self):
        c = t.load_config(CONFIGS / "route-safety-balanced.json")
        self.assertEqual(c["route_sampling"], "safety_balanced")
        self.assertEqual(c["route_rows_per_step"], 6)
        self.assertEqual(c["validation_rows"], 1152)

    def test_warm_reason_balanced_config_is_bound_to_rejected_candidate(self):
        c = t.load_config(CONFIGS / "qwen35-4b-warm-route-safety-reasons.json")
        self.assertEqual(c["initialization_mode"], "warm_start")
        self.assertEqual(c["route_sampling"], "safety_reason_balanced")
        self.assertEqual(c["validation_rows"], 1152)
        self.assertEqual(c["max_length"], 256)
        self.assertEqual(
            c["init_manifest_sha256"],
            "81e9a3dbf0fb9f1430b5f6dcd21ccf5fecf7181157ced9c7e2c7c93e3e6c71e8",
        )
        self.assertIn("rejected", c["init_package_repo"])

    def test_warm_start_provenance_does_not_claim_every_package_was_released(self):
        source = Path(t.__file__).read_text()
        self.assertIn('initialization_kind = "verified_inference_package"', source)
        self.assertNotIn('initialization_kind = "released_inference_package"', source)

    def test_fresh_4b_config_is_exact_and_unquantized(self):
        c = t.load_config(CONFIGS / "qwen35-4b-fresh-route-focus.json")
        self.assertEqual(c["initialization_mode"], "fresh")
        self.assertEqual(c["base_model"], "Qwen/Qwen3.5-4B")
        self.assertEqual(c["base_revision"], "851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a")
        self.assertEqual(c["quantization"], "none")
        self.assertIs(c["activation_checkpointing"], True)
        self.assertGreaterEqual(c["max_length"], 246)

    def test_fresh_9b_config_is_exact_unquantized_and_uses_full_prompt_length(self):
        c = t.load_config(CONFIGS / "qwen35-9b-fresh-route-focus.json")
        self.assertEqual(c["base_model"], "Qwen/Qwen3.5-9B")
        self.assertEqual(c["base_revision"], "e0330a142393d4516eca6ab0145ce66ac513e842")
        self.assertEqual(c["initialization_mode"], "fresh")
        self.assertEqual(c["precision"], "bf16")
        self.assertEqual(c["quantization"], "none")
        self.assertEqual(c["lora_rank"], 8)
        self.assertGreaterEqual(c["max_length"], 246)
        self.assertIs(c["activation_checkpointing"], True)

    def test_quantization_and_selection_are_refused(self):
        base = json.loads((CONFIGS / "smoke.json").read_text())
        for key, bad in (("quantization", "nf4"), ("selection_metric", "test_accuracy"), ("precision", "fp16")):
            with tempfile.TemporaryDirectory() as d:
                p = Path(d) / "c.json"
                p.write_text(json.dumps({**base, key: bad}))
                with self.assertRaises(ValueError):
                    t.load_config(p)

    def test_safety_adjusted_selection_is_validation_only_and_penalises_unsafe_routes(self):
        safe = t.selection_score(
            0.90, 0.95, metric="validation_safety_adjusted_accuracy",
            safety_accuracy=0.90, unsafe_routes=0, safety_rows=100,
        )
        unsafe = t.selection_score(
            0.92, 0.96, metric="validation_safety_adjusted_accuracy",
            safety_accuracy=0.90, unsafe_routes=8, safety_rows=100,
        )
        self.assertGreater(safe, unsafe)
        with self.assertRaisesRegex(ValueError, "safety metrics"):
            t.selection_score(0.9, 0.9, metric="validation_safety_adjusted_accuracy")

    def test_proxy_ood_selection_uses_weaker_view_and_requires_zero_unsafe(self):
        ordinary = {
            "route_accuracy": 0.94, "argument_accuracy": 0.98,
            "validation_safety_accuracy": 0.97, "validation_unsafe_argmax_routes": 0,
            "validation_safety_rows": 100, "n": 500,
        }
        proxy = {
            "route_accuracy": 0.91, "argument_accuracy": 0.965,
            "validation_safety_accuracy": 0.95, "validation_unsafe_argmax_routes": 0,
            "validation_safety_rows": 80, "n": 400,
        }
        passed = t.proxy_ood_selection_metrics(ordinary, proxy)
        self.assertTrue(passed["proxy_ood_success"])
        self.assertEqual(passed["min_route_accuracy"], 0.91)
        self.assertEqual(passed["min_argument_accuracy"], 0.965)

        unsafe = t.proxy_ood_selection_metrics(
            ordinary, {**proxy, "route_accuracy": 0.99, "validation_unsafe_argmax_routes": 1}
        )
        self.assertFalse(unsafe["proxy_ood_success"])
        self.assertLess(unsafe["score"], passed["score"])

    def test_proxy_ood_selection_refuses_incomplete_views(self):
        complete = {
            "route_accuracy": 0.9, "argument_accuracy": 0.96,
            "validation_safety_accuracy": 1.0, "validation_unsafe_argmax_routes": 0,
            "validation_safety_rows": 1, "n": 2,
        }
        with self.assertRaisesRegex(ValueError, "missing"):
            t.proxy_ood_selection_metrics(complete, {"n": 1})
        with self.assertRaisesRegex(ValueError, "must contain"):
            t.proxy_ood_selection_metrics(complete, {**complete, "validation_safety_rows": 0})

    def test_unknown_config_key_refused(self):
        base = json.loads((CONFIGS / "smoke.json").read_text())
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "c.json"
            p.write_text(json.dumps({**base, "eval_on_test": True}))
            with self.assertRaises(ValueError):
                t.load_config(p)

    def test_activation_checkpointing_must_be_boolean(self):
        base = json.loads((CONFIGS / "qwen35-4b-fresh-route-focus.json").read_text())
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "c.json"
            p.write_text(json.dumps({**base, "activation_checkpointing": "yes"}))
            with self.assertRaisesRegex(ValueError, "activation_checkpointing"):
                t.load_config(p)


class DataGuardTests(unittest.TestCase):
    def test_clean_view_passes(self):
        with tempfile.TemporaryDirectory() as d:
            sha = write_view(Path(d))
            self.assertEqual(t.guard_training_view(d, sha)["generator_version"], "grav-acc-routing-v2")

    def test_locked_files_refused(self):
        for locked in ("test.jsonl", "ood.jsonl"):
            with tempfile.TemporaryDirectory() as d:
                sha = write_view(Path(d), extra=[locked])
                with self.assertRaisesRegex(ValueError, "locked evaluation"):
                    t.guard_training_view(d, sha)

    def test_unlisted_file_refused(self):
        with tempfile.TemporaryDirectory() as d:
            sha = write_view(Path(d), extra=["notes.jsonl"])
            with self.assertRaises(ValueError):
                    t.guard_training_view(d, sha)


class SnapshotAuditBindingTests(unittest.TestCase):
    def test_relocated_preserved_snapshot_uses_explicit_run_directory(self):
        config = t.load_config(CONFIGS / "qwen35-4b-warm-route-safety-reasons.json")
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            run_dir = root / "original-run"
            snapshot = root / "preserved" / "step-00000300"
            run_dir.mkdir()
            snapshot.mkdir(parents=True)
            state = snapshot / "training_state.pt"
            state.write_bytes(b"bound-state")
            identity = "run-identity"
            (run_dir / "run.json").write_text(json.dumps({
                "identity_sha256": identity,
                "identity": {"config_sha256": t.json_sha256(config), "config": config},
            }))
            (snapshot / "resume.json").write_text(json.dumps({
                "identity_sha256": identity,
                "training_state_sha256": t.file_sha256(state),
            }))

            run, resume = audit_snapshot.verify_snapshot_binding(snapshot, run_dir, config)
            self.assertEqual(run["identity_sha256"], identity)
            self.assertEqual(resume["training_state_sha256"], t.file_sha256(state))

    def test_snapshot_audit_refuses_wrong_run_directory(self):
        config = t.load_config(CONFIGS / "qwen35-4b-warm-route-safety-reasons.json")
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            run_dir = root / "wrong-run"
            snapshot = root / "preserved" / "step-00000300"
            run_dir.mkdir()
            snapshot.mkdir(parents=True)
            state = snapshot / "training_state.pt"
            state.write_bytes(b"bound-state")
            (run_dir / "run.json").write_text(json.dumps({
                "identity_sha256": "other",
                "identity": {"config_sha256": t.json_sha256(config), "config": config},
            }))
            (snapshot / "resume.json").write_text(json.dumps({
                "identity_sha256": "expected",
                "training_state_sha256": t.file_sha256(state),
            }))

            with self.assertRaisesRegex(ValueError, "identity"):
                audit_snapshot.verify_snapshot_binding(snapshot, run_dir, config)

    def test_tampered_split_refused(self):
        with tempfile.TemporaryDirectory() as d:
            sha = write_view(Path(d))
            (Path(d) / "train.jsonl").write_text('{"id":"x","split":"train"}\n')
            with self.assertRaisesRegex(ValueError, "does not match"):
                t.guard_training_view(d, sha)

    def test_wrong_manifest_refused(self):
        with tempfile.TemporaryDirectory() as d:
            write_view(Path(d))
            with self.assertRaisesRegex(ValueError, "differs from the pinned"):
                t.guard_training_view(d, "0" * 64)


class BaselineGateTests(unittest.TestCase):
    def report(self, **over):
        r = {"schema": "grav.jev.routing-eval/1", "label": "b", "device": "gpu",
             "locked": {"generator_version": "grav-acc-routing-v2", "manifest_sha256": "a" * 64},
             "completeness": {"complete": True}}
        r.update(over)
        return r

    def test_complete_baseline_accepted(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "report.json"
            p.write_text(json.dumps(self.report()))
            self.assertEqual(t.check_baseline_report(p, {"data_generator_version": "grav-acc-routing-v2"})["label"], "b")

    def test_subset_baseline_refused(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "report.json"
            p.write_text(json.dumps(self.report(completeness={"complete": False})))
            with self.assertRaisesRegex(ValueError, "FULL locked set"):
                t.check_baseline_report(p, {"data_generator_version": "grav-acc-routing-v2"})

    def test_fresh_baseline_requires_exact_initialization_binding_and_model(self):
        config = {"data_generator_version": "grav-acc-routing-v2", "initialization_mode": "fresh",
                  "init_manifest_sha256": "f" * 64, "base_model": "Qwen/Qwen3.5-4B"}
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "report.json"
            p.write_text(json.dumps({**self.report(), "model_reported": {"model": "Qwen/Qwen3.5-4B"}}))
            with self.assertRaisesRegex(ValueError, "fresh initialization"):
                t.check_baseline_report(p, config)
            (Path(d) / "initialization-manifest.sha256").write_text("e" * 64 + "\n")
            with self.assertRaisesRegex(ValueError, "fresh initialization"):
                t.check_baseline_report(p, config)
            (Path(d) / "initialization-manifest.sha256").write_text("f" * 64 + "\n")
            self.assertEqual(t.check_baseline_report(p, config)["label"], "b")
            p.write_text(json.dumps({**self.report(), "model_reported": {"model": "other"}}))
            with self.assertRaisesRegex(ValueError, "model differs"):
                t.check_baseline_report(p, config)


class OrderAndExportTests(unittest.TestCase):
    def test_epoch_order_is_deterministic_and_a_permutation(self):
        a, b = t.epoch_order(50, 7, 0), t.epoch_order(50, 7, 0)
        self.assertEqual(a, b)
        self.assertEqual(sorted(a), list(range(50)))
        self.assertNotEqual(a, t.epoch_order(50, 7, 1))

    def test_row_for_step_crosses_epochs(self):
        cache = {}
        seen = [t.row_for_step(cache, 5, 1, i) for i in range(10)]
        self.assertEqual(sorted(seen[:5]), list(range(5)))
        self.assertEqual(sorted(seen[5:]), list(range(5)))

    def test_stratified_step_has_requested_route_mix_and_is_deterministic(self):
        rows = [
            {"id": f"route-{i}", "metadata": {"question_id": "route"}} for i in range(9)
        ] + [
            {"id": f"arg-{i}", "metadata": {"question_id": "ledger"}} for i in range(7)
        ]
        a = t.rows_for_training_step(rows, step=3, accumulation=8, seed=17,
                                     route_rows_per_step=6, order_cache={})
        b = t.rows_for_training_step(rows, step=3, accumulation=8, seed=17,
                                     route_rows_per_step=6, order_cache={})
        self.assertEqual([row["id"] for row in a], [row["id"] for row in b])
        self.assertEqual(sum(row["metadata"]["question_id"] == "route" for row in a), 6)
        self.assertEqual(len(a), 8)

    def test_stratified_steps_advance_each_stream(self):
        rows = [
            {"id": f"route-{i}", "metadata": {"question_id": "route"}} for i in range(20)
        ] + [
            {"id": f"arg-{i}", "metadata": {"question_id": "ledger"}} for i in range(20)
        ]
        cache = {}
        first = t.rows_for_training_step(rows, step=0, accumulation=8, seed=17,
                                         route_rows_per_step=6, order_cache=cache)
        second = t.rows_for_training_step(rows, step=1, accumulation=8, seed=17,
                                          route_rows_per_step=6, order_cache=cache)
        self.assertTrue(set(row["id"] for row in first).isdisjoint(row["id"] for row in second))

    def test_stratified_step_refuses_invalid_mix_or_missing_stratum(self):
        route_only = [{"id": "route", "metadata": {"question_id": "route"}}]
        with self.assertRaisesRegex(ValueError, "both route and argument"):
            t.rows_for_training_step(route_only, step=0, accumulation=8, seed=1,
                                     route_rows_per_step=6, order_cache={})
        with self.assertRaisesRegex(ValueError, r"\[0, accumulation\)"):
            t.rows_for_training_step(route_only, step=0, accumulation=8, seed=1,
                                     route_rows_per_step=8, order_cache={})

    def test_label_balanced_route_sampling_gives_every_label_equal_turns(self):
        rows = []
        for label, count in (("common", 20), ("rare-a", 2), ("rare-b", 1)):
            rows.extend({"id": f"{label}-{i}", "metadata": {"question_id": "route", "grav": {"gold": label}}}
                        for i in range(count))
        rows.extend({"id": f"arg-{i}", "metadata": {"question_id": "ledger"}} for i in range(10))
        selected = []
        cache = {}
        for step in range(2):
            selected.extend(t.rows_for_training_step(rows, step=step, accumulation=7, seed=29,
                                                      route_rows_per_step=6, order_cache=cache,
                                                      route_sampling="label_balanced")[:6])
        counts = {}
        for row in selected:
            label = row["metadata"]["grav"]["gold"]
            counts[label] = counts.get(label, 0) + 1
        self.assertEqual(counts, {"common": 4, "rare-a": 4, "rare-b": 4})

    def test_label_balanced_route_sampling_is_deterministic(self):
        rows = [
            {"id": f"{label}-{i}", "metadata": {"question_id": "route", "grav": {"gold": label}}}
            for label in ("a", "b", "c") for i in range(3)
        ] + [{"id": "arg", "metadata": {"question_id": "ledger"}}]
        kwargs = dict(step=4, accumulation=7, seed=29, route_rows_per_step=6,
                      route_sampling="label_balanced")
        a = t.rows_for_training_step(rows, order_cache={}, **kwargs)
        b = t.rows_for_training_step(rows, order_cache={}, **kwargs)
        self.assertEqual([row["id"] for row in a], [row["id"] for row in b])

    def test_safety_balanced_sampling_preserves_refusals_and_balances_tools(self):
        rows = []
        for label, count in (("unsupported", 20), ("clarify", 10), ("tool-a", 9), ("tool-b", 3), ("tool-c", 1)):
            rows.extend({"id": f"{label}-{i}", "metadata": {"question_id": "route", "grav": {"gold": label}}}
                        for i in range(count))
        rows.extend({"id": f"arg-{i}", "metadata": {"question_id": "ledger"}} for i in range(20))
        selected = []
        cache = {}
        for step in range(12):
            selected.extend(t.rows_for_training_step(rows, step=step, accumulation=8, seed=31,
                                                      route_rows_per_step=6, order_cache=cache,
                                                      route_sampling="safety_balanced")[:6])
        counts = {}
        ids = []
        for row in selected:
            label = row["metadata"]["grav"]["gold"]
            counts[label] = counts.get(label, 0) + 1
            ids.append(row["id"])
        self.assertEqual(counts, {"unsupported": 24, "clarify": 12, "tool-a": 12, "tool-b": 12, "tool-c": 12})
        self.assertEqual(len(ids[:3]), len(set(ids[:3])), "a safety step must not repeat the same row")

    def test_safety_balanced_sampling_is_deterministic_and_validates_shape(self):
        rows = [
            {"id": f"{label}-{i}", "metadata": {"question_id": "route", "grav": {"gold": label}}}
            for label in ("unsupported", "clarify", "tool") for i in range(5)
        ] + [{"id": f"arg-{i}", "metadata": {"question_id": "ledger"}} for i in range(5)]
        kwargs = dict(step=4, accumulation=8, seed=31, route_rows_per_step=6,
                      route_sampling="safety_balanced")
        a = t.rows_for_training_step(rows, order_cache={}, **kwargs)
        b = t.rows_for_training_step(rows, order_cache={}, **kwargs)
        self.assertEqual([row["id"] for row in a], [row["id"] for row in b])
        with self.assertRaisesRegex(ValueError, "even route_rows_per_step"):
            t.rows_for_training_step(rows, step=0, accumulation=8, seed=31,
                                     route_rows_per_step=5, order_cache={}, route_sampling="safety_balanced")

    def test_safety_reason_balanced_sampling_balances_reasons_and_preserves_executable_mix(self):
        rows = []
        for label, reason, count in (
            ("unsupported", "cross_company", 20),
            ("unsupported", "prompt_injection", 2),
            ("clarify", "missing_account", 1),
        ):
            rows.extend({
                "id": f"{reason}-{i}",
                "metadata": {"question_id": "route", "grav": {"gold": label, "reason": reason}},
            } for i in range(count))
        for label, count in (("tool-common", 9), ("tool-rare", 3)):
            rows.extend({
                "id": f"{label}-{i}",
                "metadata": {"question_id": "route", "grav": {"gold": label}},
            } for i in range(count))
        rows.extend({"id": f"arg-{i}", "metadata": {"question_id": "ledger"}} for i in range(20))

        selected = []
        cache = {}
        for step in range(6):
            selected.extend(t.rows_for_training_step(
                rows, step=step, accumulation=8, seed=37, route_rows_per_step=6,
                order_cache=cache, route_sampling="safety_reason_balanced",
            )[:6])

        reasons = {}
        labels = {}
        for row in selected:
            grav = row["metadata"]["grav"]
            labels[grav["gold"]] = labels.get(grav["gold"], 0) + 1
            if grav["gold"] in {"unsupported", "clarify"}:
                reasons[grav["reason"]] = reasons.get(grav["reason"], 0) + 1
        self.assertEqual(reasons, {"cross_company": 6, "prompt_injection": 6, "missing_account": 6})
        self.assertGreater(labels["tool-common"], labels["tool-rare"], "executable routes must stay proportional")

    def test_safety_reason_balanced_sampling_is_deterministic_and_requires_reasons(self):
        rows = [
            {"id": f"safe-{i}", "metadata": {"question_id": "route", "grav": {
                "gold": "unsupported", "reason": reason,
            }}}
            for i, reason in enumerate(("cross_company", "prompt_injection", "write_request"))
        ] + [
            {"id": f"tool-{i}", "metadata": {"question_id": "route", "grav": {"gold": "tool"}}}
            for i in range(5)
        ] + [{"id": f"arg-{i}", "metadata": {"question_id": "ledger"}} for i in range(5)]
        kwargs = dict(step=4, accumulation=8, seed=37, route_rows_per_step=6,
                      route_sampling="safety_reason_balanced")
        a = t.rows_for_training_step(rows, order_cache={}, **kwargs)
        b = t.rows_for_training_step(rows, order_cache={}, **kwargs)
        self.assertEqual([row["id"] for row in a], [row["id"] for row in b])

        rows[0]["metadata"]["grav"].pop("reason")
        with self.assertRaisesRegex(ValueError, "metadata.grav.reason"):
            t.rows_for_training_step(rows, order_cache={}, **kwargs)

    def test_safety_reason_and_label_balanced_sampling_balances_both_halves(self):
        rows = []
        for label, reason, count in (
            ("unsupported", "tool_not_offered", 20),
            ("unsupported", "prompt_injection", 2),
            ("clarify", "missing_account", 1),
        ):
            rows.extend({
                "id": f"{reason}-{i}",
                "metadata": {"question_id": "route", "grav": {"gold": label, "reason": reason}},
            } for i in range(count))
        for label, count in (("tool-common", 20), ("tool-mid", 4), ("tool-rare", 1)):
            rows.extend({
                "id": f"{label}-{i}",
                "metadata": {"question_id": "route", "grav": {"gold": label}},
            } for i in range(count))
        rows.extend({"id": f"arg-{i}", "metadata": {"question_id": "ledger"}} for i in range(20))

        selected = []
        cache = {}
        for step in range(6):
            selected.extend(t.rows_for_training_step(
                rows, step=step, accumulation=8, seed=41, route_rows_per_step=6,
                order_cache=cache, route_sampling="safety_reason_and_label_balanced",
            )[:6])
        reasons, labels = {}, {}
        for row in selected:
            grav = row["metadata"]["grav"]
            labels[grav["gold"]] = labels.get(grav["gold"], 0) + 1
            if "reason" in grav:
                reasons[grav["reason"]] = reasons.get(grav["reason"], 0) + 1
        self.assertEqual(reasons, {"tool_not_offered": 6, "prompt_injection": 6, "missing_account": 6})
        self.assertEqual(labels["tool-common"], labels["tool-mid"])
        self.assertEqual(labels["tool-mid"], labels["tool-rare"])

    def test_validation_safety_metrics_count_only_executable_argmax_as_unsafe(self):
        def route(gold, reason, options):
            return {"metadata": {"question_id": "route", "grav": {"gold": gold, "reason": reason}},
                    "options": [f"{name}: description" for name in options]}

        rows = [
            route("unsupported", "prompt_injection", ["unsupported", "acc_ledger_balance", "clarify"]),
            route("clarify", "missing_account", ["unsupported", "acc_vouchers", "clarify"]),
            route("unsupported", "write_request", ["unsupported", "acc_vouchers", "clarify"]),
            {"metadata": {"question_id": "ledger", "grav": {"gold": "x"}}, "options": ["x", "y"]},
        ]
        metrics = t.routing_safety_metrics(rows, [[3, 1, 0], [0, 1, 3], [0, 4, 1], [0, 1]])
        self.assertEqual(metrics["validation_safety_rows"], 3)
        self.assertEqual(metrics["validation_unsafe_argmax_routes"], 1)
        self.assertAlmostEqual(metrics["validation_safety_accuracy"], 2 / 3)
        self.assertEqual(metrics["validation_safety_reason_accuracy"], {
            "missing_account": 1.0,
            "prompt_injection": 1.0,
            "write_request": 0.0,
        })

    def test_export_manifest_lists_every_file_with_hash(self):
        with tempfile.TemporaryDirectory() as d:
            pkg = Path(d)
            (pkg / "checkpoint" / "adapter").mkdir(parents=True)
            (pkg / "checkpoint" / "model.json").write_text("{}")
            (pkg / "checkpoint" / "adapter" / "adapter_model.safetensors").write_bytes(b"abc")
            m = t.export_manifest(pkg, "Qwen/Qwen3.5-2B", "rev")
            self.assertEqual(m["kind"], "local_inference_weight_package")
            self.assertEqual(m["files"]["checkpoint/adapter/adapter_model.safetensors"]["sha256"], hashlib.sha256(b"abc").hexdigest())
            self.assertNotIn("manifest.json", m["files"])


if __name__ == "__main__":
    unittest.main()
