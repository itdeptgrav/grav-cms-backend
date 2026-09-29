import tempfile
import unittest
from pathlib import Path

import create_proxy_ood_experiment_config as creator


class CreateProxyOodExperimentConfigTest(unittest.TestCase):
    def test_creates_fresh_proportional_full_validation_config_once(self):
        base = Path(__file__).resolve().parent / "configs/qwen35-9b-fresh-route-focus.json"
        with tempfile.TemporaryDirectory() as d:
            output = Path(d) / "experiment.json"
            result = creator.create_config(base, "a" * 64, output)
            config = result["config"]
            self.assertEqual(config["selection_metric"], "validation_proxy_ood_robustness")
            self.assertEqual(config["route_sampling"], "proportional")
            self.assertEqual(config["validation_rows"], 0)
            self.assertEqual(config["train_view_manifest_sha256"], "a" * 64)
            with self.assertRaisesRegex(ValueError, "never overwritten"):
                creator.create_config(base, "a" * 64, output)

    def test_refuses_non_hash_manifest(self):
        base = Path(__file__).resolve().parent / "configs/qwen35-9b-fresh-route-focus.json"
        with tempfile.TemporaryDirectory() as d, self.assertRaisesRegex(ValueError, "SHA-256"):
            creator.create_config(base, "pending", Path(d) / "experiment.json")


if __name__ == "__main__":
    unittest.main()

