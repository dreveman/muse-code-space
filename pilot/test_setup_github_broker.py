"""Tests for the interactive GitHub broker setup script (no network, no real key)."""
import importlib.util
import json
import pathlib
import stat
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location(
    "setup_github_broker_under_test", pathlib.Path(__file__).with_name("setup_github_broker.py")
)
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


class SetupScriptTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        key = f"{cls.tmp}/k.pem"
        subprocess.run(["openssl", "genrsa", "-out", key, "2048"], check=True, capture_output=True)
        cls.pem = pathlib.Path(key).read_text()

    def test_build_config_shape(self):
        cfg = setup.build_config("123", "456", pathlib.Path("/x/key.pem"))
        self.assertEqual(cfg, {"mode": "app", "app_id": "123", "installation_id": "456",
                               "private_key_path": "/x/key.pem"})

    def test_write_config_permissions_and_contents(self):
        d = pathlib.Path(tempfile.mkdtemp())
        key, cfgp = d / "github-app-key.pem", d / "github-broker.json"
        setup.write_config(setup.build_config("1", "2", key), self.pem, cfgp, key)
        self.assertEqual(stat.S_IMODE(key.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(cfgp.stat().st_mode), 0o600)
        data = json.loads(cfgp.read_text())
        self.assertEqual(data["mode"], "app")
        self.assertNotIn("PRIVATE KEY", cfgp.read_text(), "key stays out of the JSON")

    def test_prompt_numeric_retries_until_digits(self):
        answers = iter(["abc", "12x", "789"])
        self.assertEqual(setup.prompt_numeric("App ID", input_fn=lambda _: next(answers)), "789")

    def test_validate_uses_provider_exchange(self):
        seen = {}

        class FakeProvider:
            def __init__(self, app_id, installation_id, pem):
                seen.update(app=app_id, inst=installation_id, pem_has_header="BEGIN" in pem)

            def __call__(self):
                return "fixture-installation-token"

        token = setup.validate("111", "222", self.pem, provider_factory=FakeProvider)
        self.assertEqual(token, "fixture-installation-token")
        self.assertEqual(seen, {"app": "111", "inst": "222", "pem_has_header": True})

    def test_validate_failure_propagates_without_writing(self):
        def boom(app_id, installation_id, pem):
            raise RuntimeError("exchange failed")
        with self.assertRaises(RuntimeError):
            setup.validate("1", "2", self.pem, provider_factory=lambda *a: boom(*a))

    def test_main_aborts_cleanly_on_bad_validation(self):
        # Drive main with stubbed prompts/validation: nothing should be written.
        import unittest.mock as mock
        with tempfile.TemporaryDirectory() as td:
            cfgp, keyp = pathlib.Path(td) / "c.json", pathlib.Path(td) / "k.pem"
            with mock.patch.object(setup, "CONFIG_PATH", cfgp), \
                 mock.patch.object(setup, "KEY_PATH", keyp), \
                 mock.patch.object(setup, "prompt_numeric", side_effect=["1", "2"]), \
                 mock.patch.object(setup, "read_pem_hidden", return_value=self.pem), \
                 mock.patch.object(setup, "validate", side_effect=RuntimeError("nope")):
                self.assertEqual(setup.main(["--no-restart"]), 1)
            self.assertFalse(cfgp.exists())
            self.assertFalse(keyp.exists())


if __name__ == "__main__":
    unittest.main()
