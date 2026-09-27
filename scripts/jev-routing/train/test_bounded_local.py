"""Local tests for the RTX PRO 4500 Blackwell bounded experiment: attestation, budget, trainer guards.

    python -m unittest scripts/jev-routing/train/test_bounded_local.py      (no torch, no GPU)
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import budget as B  # noqa: E402
import grav_jev_train as t  # noqa: E402
import runtime_attest as R  # noqa: E402

PROFILE = json.loads((HERE / "HARDWARE_PROFILE.json").read_text())
ADA_PROFILE = json.loads((HERE / "HARDWARE_PROFILE_RTX6000_ADA.json").read_text())


def good_runtime(**over):
    att = {"gpu_count": 1, "torch_device_count": 1, "gpu_name": "NVIDIA RTX PRO 4500 Blackwell", "torch_device_name": "NVIDIA RTX PRO 4500 Blackwell",
           "gpu_uuid": "GPU-00000000-1111-2222-3333-444444444444", "driver_version": "575.57.08", "compute_capability": "12.0",
           "vram_total_mib": 32623, "torch": "2.8.0+cu128", "torch_cuda": "12.8", "cudnn": 91002,
           "arch_list": ["sm_75", "sm_80", "sm_86", "sm_90", "sm_100", "sm_120", "compute_120"],
           "transformers": "5.10.2", "peft": "0.19.1", "python": "3.12.3",
           "cuda_self_test": {"ok": True, "bit_identical": True}}
    att.update(over)
    return att


class Identity(unittest.TestCase):
    def test_rtx_6000_ada_profile_matches_the_pinned_pytorch_wheel(self):
        runtime = good_runtime(
            gpu_name="NVIDIA RTX 6000 Ada Generation",
            torch_device_name="NVIDIA RTX 6000 Ada Generation",
            compute_capability="8.9",
            vram_total_mib=49140,
            arch_list=["sm_70", "sm_75", "sm_80", "sm_86", "sm_90", "sm_100", "sm_120"],
            driver_version="580.126.20",
            triton="3.4.0",
            fla_core="0.4.2",
            flash_linear_attention="0.4.2",
            causal_conv1d="1.6.1",
        )
        self.assertEqual(R.profile_problems(runtime, ADA_PROFILE), [])
        self.assertTrue(R.profile_problems({**runtime, "fla_core": "0.5.2"}, ADA_PROFILE))

    def test_accepts_the_documented_names(self):
        for n in ("NVIDIA RTX PRO 4500 Blackwell", "RTX PRO 4500", "NVIDIA RTX PRO 4500 Blackwell Generation", "NVIDIA RTX PRO 4500 SE", "nvidia rtx-pro-4500 blackwell"):
            self.assertEqual(R.name_problems(n, PROFILE), [], n)

    def test_rejects_other_products(self):
        for n in ("NVIDIA RTX 4500 Ada Generation", "NVIDIA RTX A4500", "NVIDIA RTX PRO 4500 Blackwell Generation Laptop GPU",
                  "NVIDIA RTX PRO 4500 Blackwell SFF Edition", "NVIDIA RTX PRO 4500 Blackwell Max-Q", "NVIDIA RTX PRO 4000 Blackwell",
                  "NVIDIA RTX PRO 6000 Blackwell Server Edition", "NVIDIA GeForce RTX 5080", "NVIDIA RTX 4000 SFF Ada Generation", ""):
            self.assertTrue(R.name_problems(n, PROFILE), n)

    def test_good_runtime_accepted(self):
        self.assertEqual(R.profile_problems(good_runtime(), PROFILE), [])

    def check(self, **over):
        return R.profile_problems(good_runtime(**over), PROFILE)

    def test_hardware_failures_are_classified_hardware(self):
        for over in ({"gpu_count": 2, "torch_device_count": 2}, {"gpu_count": 0}, {"vram_total_mib": 16303},
                     {"gpu_name": "NVIDIA RTX 4000 Ada Generation", "torch_device_name": "NVIDIA RTX 4000 Ada Generation", "compute_capability": "8.9"},
                     {"compute_capability": "8.9"}, {"torch_device_name": "NVIDIA RTX A4000"}):
            p = self.check(**over)
            self.assertTrue(p and any(x.startswith("hardware:") for x in p), (over, p))

    def test_runtime_failures_are_classified_runtime(self):
        for over in ({"driver_version": "560.35.03"}, {"arch_list": ["sm_80", "sm_90", "compute_90"]}, {"arch_list": ["sm_90", "compute_120"]},
                     {"torch": "2.9.0+cu130"}, {"torch_cuda": "12.6"}, {"transformers": "5.11.0"}, {"peft": "0.20.0"},
                     {"cuda_self_test": {"ok": False, "error": "RuntimeError: CUDA error: no kernel image is available"}},
                     {"cuda_self_test": {"ok": True, "bit_identical": False}}):
            p = self.check(**over)
            self.assertTrue(p and all(x.startswith("runtime:") for x in p), (over, p))

    def test_exactly_31_gib_boundary(self):
        self.assertEqual(self.check(vram_total_mib=31744), [])
        self.assertTrue(self.check(vram_total_mib=31743))

    def test_bound_fields_detect_any_change(self):
        a = good_runtime()
        self.assertEqual(R.bound_changes(a, dict(a)), {})
        for k, v in (("gpu_uuid", "GPU-other"), ("driver_version", "575.64"), ("vram_total_mib", 24000), ("torch", "2.8.1+cu128"), ("peft", "0.19.2")):
            self.assertIn(k, R.bound_changes(a, {**a, k: v}))
        self.assertEqual(R.attestation_sha256(a), R.attestation_sha256(dict(a)))
        self.assertNotEqual(R.attestation_sha256(a), R.attestation_sha256({**a, "gpu_uuid": "GPU-x"}))
        self.assertEqual(R.attestation_sha256(a), R.attestation_sha256({**a, "python": "3.12.9"}), "unbound fields do not change the binding")


class Budget(unittest.TestCase):
    def test_price_must_be_established(self):
        for env in ({}, {"JEV_POD_HOURLY_USD": ""}, {"JEV_POD_HOURLY_USD": "abc"}, {"JEV_POD_HOURLY_USD": "0"},
                    {"JEV_POD_HOURLY_USD": "-1"}, {"JEV_POD_HOURLY_USD": "9"}, {"JEV_POD_HOURLY_USD": "nan"}):
            with self.assertRaises(B.BudgetError, msg=env):
                B.hourly_rate(env)
        self.assertEqual(B.hourly_rate({"JEV_POD_HOURLY_USD": "0.39"}), 0.39)

    def test_pod_age_must_be_established(self):
        with self.assertRaises(B.BudgetError):
            B.pod_age_seconds({"JEV_TEST_POD_AGE_FILE": "/nonexistent/age"})
        with tempfile.NamedTemporaryFile("w", suffix=".age", delete=False) as fh:
            fh.write("123")
        self.assertEqual(B.pod_age_seconds({"JEV_TEST_POD_AGE_FILE": fh.name}), 123)

    def test_projection_is_conservative_and_refuses_over_ceiling(self):
        est = B.estimates(None)
        all_phases = ["setup", "preflight", "stage1", "smoke_main", "smoke_resume", "adapter_eval"]
        ok = B.projection(0, 0.72, all_phases, est)
        self.assertTrue(ok["within_ceiling"], ok)
        self.assertFalse(B.projection(0, 0.80, all_phases, est)["within_ceiling"])
        self.assertGreaterEqual(ok["projected_total_seconds"], sum(est[p] for p in all_phases) + B.PROVISIONING_MARGIN + B.COLLECT_RESERVE)
        self.assertFalse(B.projection(15000, 0.40, ["smoke_resume", "adapter_eval"], est)["within_ceiling"])

    def test_measurements_only_ever_raise_later_estimates_to_realistic_values(self):
        with tempfile.TemporaryDirectory() as d:
            st = Path(d) / "m.json"
            st.write_text(json.dumps({"stage1": 3000, "smoke_main": 4000}))
            est = B.estimates(st)
            self.assertEqual(est["adapter_eval"], 3750)
            self.assertEqual(est["smoke_resume"], 3300)

    def test_timeout_never_exceeds_the_ceiling(self):
        self.assertEqual(B.phase_timeout(0, 0.25), int(2.00 / 0.25 * 3600) - B.PROVISIONING_MARGIN - B.COLLECT_RESERVE)
        self.assertLessEqual(B.phase_timeout(30000, 0.25), 0)


class TrainerGuards(unittest.TestCase):
    def test_full_training_cannot_start_without_explicit_approval(self):
        full = {"name": "grav-acc-routing-v2-full", "steps": 2190}
        with self.assertRaises(PermissionError):
            t.full_training_guard(full, {})
        with self.assertRaises(PermissionError):
            t.full_training_guard(full, {"JEV_FULL_TRAINING_APPROVED": "1"})
        t.full_training_guard({"name": "smoke", "steps": 100}, {})

    def test_stage1_must_be_bound_to_this_runtime(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "report.json"
            p.write_text(json.dumps({"schema": "grav.jev.routing-eval/1", "label": "b", "device": "gpu",
                                     "locked": {"generator_version": "grav-acc-routing-v2", "manifest_sha256": "a" * 64},
                                     "completeness": {"complete": True}}))
            cfg = {"data_generator_version": "grav-acc-routing-v2"}
            with self.assertRaisesRegex(ValueError, "not bound"):
                t.check_baseline_report(p, cfg, attestation_sha256="f" * 64)
            (Path(d) / "runtime-attestation.sha256").write_text("e" * 64 + "\n")
            with self.assertRaisesRegex(ValueError, "not bound"):
                t.check_baseline_report(p, cfg, attestation_sha256="f" * 64)
            (Path(d) / "runtime-attestation.sha256").write_text("f" * 64 + "\n")
            self.assertEqual(t.check_baseline_report(p, cfg, attestation_sha256="f" * 64)["runtime_attestation_sha256"], "f" * 64)

    def test_smoke_config_is_the_only_shipped_training_config(self):
        self.assertEqual(t.load_config(HERE / "configs" / "smoke.json")["steps"], 100)


if __name__ == "__main__":
    unittest.main()
