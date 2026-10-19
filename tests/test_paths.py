import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest


# Run from inside ComfyUI/custom_nodes/comfyQ, or set COMFYUI_PATH to the ComfyUI folder.
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, os.environ.get("COMFYUI_PATH", str(ROOT.parents[1])))
import folder_paths

sys.modules["server"] = types.SimpleNamespace(PromptServer=type("PromptServer", (), {}))
source = ROOT / "server.py"
spec = importlib.util.spec_from_file_location("comfyq_test_server", source)
server = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = server
spec.loader.exec_module(server)


class ModelPathTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=ROOT)
        self.root = Path(self.temp.name)
        self.primary = self.root / "primary"
        self.secondary = self.root / "secondary"
        self.primary.mkdir()
        self.secondary.mkdir()
        folder_paths.folder_names_and_paths["comfyq_test"] = (
            [str(self.primary), str(self.secondary)], {".safetensors"}
        )

    def tearDown(self):
        del folder_paths.folder_names_and_paths["comfyq_test"]
        self.temp.cleanup()

    def test_existing_model_in_second_root(self):
        nested = self.secondary / "nested"
        nested.mkdir()
        (nested / "encoder.safetensors").write_bytes(b"test fixture, not a model")
        self.assertEqual(server._resolve_model_path("comfyq_test", filename="nested/encoder.safetensors"), str(nested))

    def test_virtual_model_opens_root(self):
        self.assertEqual(server._resolve_model_path("comfyq_test", filename="taesd3"), str(self.primary))
        self.assertFalse((self.primary / "taesd3").exists())

    def test_missing_filename_opens_containing_folder(self):
        self.assertEqual(server._resolve_model_path("comfyq_test", filename="nested/missing.safetensors"), str(self.primary / "nested"))

    def test_download_retains_new_subfolder(self):
        self.assertEqual(server._resolve_target_dir("comfyq_test", subfolder="new/nested"), str(self.primary / "new/nested"))

    def test_traversal_is_rejected(self):
        with self.assertRaises(ValueError):
            server._resolve_model_path("comfyq_test", filename="../outside.safetensors")


if __name__ == "__main__":
    unittest.main(verbosity=2)
