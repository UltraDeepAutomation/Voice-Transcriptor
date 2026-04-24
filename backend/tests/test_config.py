"""Tests for backend.config — the SSOT config system.

Covers the full lifecycle:

    * Fresh load returns DEFAULT_CONFIG with current schema_version
    * Save → load roundtrip preserves values and decrypts keys
    * Second save rotates previous to .bak
    * Corrupt primary → automatic recovery from .bak
    * Legacy v1 (no schema_version) → migrated to current
    * Plain-text provider keys → transparently encrypted on disk
    * Invalid shape → repaired with warning (not crash)
    * Forward-compat: newer schema_version preserved, unknown fields kept

Each test runs in an isolated TRANSCRIPTOR_DATA_DIR. Because
backend.config resolves DATA_DIR / CONFIG_PATH at module import time
from the env var, we re-import fresh in each test via ``importlib``
to get clean state.

Run with:   python -m pytest backend/tests/test_config.py -v
"""

import importlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path


def _reload_config_module(data_dir: str):
    """Reimport backend.config with TRANSCRIPTOR_DATA_DIR pointing at
    *data_dir*. Returns the fresh module."""
    os.environ["TRANSCRIPTOR_DATA_DIR"] = data_dir
    # Drop the cached module so module-top-level DATA_DIR is recomputed.
    if "backend.config" in sys.modules:
        del sys.modules["backend.config"]
    return importlib.import_module("backend.config")


class TestConfigLifecycle(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.data_dir = self._tmp.name
        self.config_mod = _reload_config_module(self.data_dir)

    def tearDown(self):
        self._tmp.cleanup()
        os.environ.pop("TRANSCRIPTOR_DATA_DIR", None)

    def test_fresh_load_returns_defaults(self):
        cfg = self.config_mod.load_config()
        self.assertEqual(cfg.get("schema_version"), self.config_mod.SCHEMA_VERSION)
        self.assertIn("providers", cfg)
        self.assertIn("preferences", cfg)
        # No side-effect file created.
        self.assertFalse(self.config_mod.CONFIG_PATH.exists())

    def test_save_load_roundtrip(self):
        self.config_mod.save_config({
            "providers": {"openrouter": {"key": "sk-or-v1-roundtrip-test-12345678"}},
            "preferences": {"remote_provider": "deepgram"},
        })
        cfg = self.config_mod.load_config()
        self.assertEqual(
            cfg["providers"]["openrouter"]["key"],
            "sk-or-v1-roundtrip-test-12345678",
        )
        self.assertEqual(cfg["preferences"]["remote_provider"], "deepgram")

    def test_first_save_writes_no_backup(self):
        """Nothing to rotate if the file is new — .bak should only
        appear starting from the second save onward."""
        self.config_mod.save_config({"providers": {"openrouter": {"key": "sk-first-12345678"}}})
        self.assertTrue(self.config_mod.CONFIG_PATH.exists())
        self.assertFalse(self.config_mod._CONFIG_BACKUP_PATH.exists())

    def test_second_save_rotates_backup(self):
        self.config_mod.save_config({"providers": {"openrouter": {"key": "sk-first-12345678"}}})
        self.config_mod.save_config({"providers": {"openrouter": {"key": "sk-second-87654321"}}})
        self.assertTrue(self.config_mod._CONFIG_BACKUP_PATH.exists())
        # Backup holds the FIRST (encrypted) value.
        raw = json.loads(self.config_mod._CONFIG_BACKUP_PATH.read_text(encoding="utf-8"))
        self.assertTrue(raw["providers"]["openrouter"]["key"].startswith("enc:"))

    def test_corrupt_primary_falls_back_to_backup(self):
        self.config_mod.save_config({"providers": {"openrouter": {"key": "sk-survivor-key-123"}}})
        # Trigger a backup rotation.
        self.config_mod.save_config({"providers": {"openrouter": {"key": "sk-overwritten-456"}}})
        # Corrupt the primary.
        self.config_mod.CONFIG_PATH.write_text("{ corrupt json", encoding="utf-8")
        cfg = self.config_mod.load_config()
        # We recover whatever the .bak held — the FIRST save's key.
        self.assertEqual(
            cfg["providers"]["openrouter"]["key"],
            "sk-survivor-key-123",
        )

    def test_legacy_v1_migration(self):
        """1.0.x configs had no schema_version and plain-text keys.
        load_config should (a) migrate to SCHEMA_VERSION and
        (b) re-encrypt the keys on disk."""
        legacy = {
            "providers": {"openrouter": {"key": "plain-legacy-key-1234567890"}},
            "preferences": {"remote_provider": "openrouter"},
        }
        self.config_mod.CONFIG_PATH.write_text(json.dumps(legacy), encoding="utf-8")
        cfg = self.config_mod.load_config()
        # In-memory view: decrypted key + current schema.
        self.assertEqual(cfg["schema_version"], self.config_mod.SCHEMA_VERSION)
        self.assertEqual(
            cfg["providers"]["openrouter"]["key"],
            "plain-legacy-key-1234567890",
        )
        # On-disk: encrypted.
        raw = json.loads(self.config_mod.CONFIG_PATH.read_text(encoding="utf-8"))
        self.assertTrue(raw["providers"]["openrouter"]["key"].startswith("enc:"))

    def test_invalid_shape_repaired(self):
        """A provider sub-tree that is not a dict should be reset to
        defaults — not crash load_config."""
        bad = {
            "schema_version": 2,
            "providers": "oops-a-string",
            "preferences": {"remote_provider": "openrouter"},
        }
        self.config_mod.CONFIG_PATH.write_text(json.dumps(bad), encoding="utf-8")
        cfg = self.config_mod.load_config()
        self.assertIsInstance(cfg["providers"], dict)
        # providers reset to defaults
        self.assertIn("openrouter", cfg["providers"])

    def test_forward_compat_preserves_newer_version(self):
        """A config written by a newer Transcriptor should NOT be
        downgraded. Unknown fields are preserved so no data is lost
        when the user alternates between 1.1.1 and a hypothetical
        1.2.0."""
        future = {
            "schema_version": 99,
            "providers": {"openrouter": {"key": ""}},
            "preferences": {"remote_provider": "openrouter"},
            "mystery_future_field": {"nested": 42},
        }
        self.config_mod.CONFIG_PATH.write_text(json.dumps(future), encoding="utf-8")
        cfg = self.config_mod.load_config()
        self.assertEqual(cfg["schema_version"], 99)
        self.assertEqual(cfg["mystery_future_field"], {"nested": 42})

    def test_legacy_no_schema_with_encrypted_keys_gets_stamped(self):
        """Regression for pass-23 M.

        1.1.0-beta shipped without `schema_version` in its config.
        If a user of that build had ALREADY encrypted their keys
        (or manually wrote an encrypted value), the key-migration
        branch in `load_config` did not trigger, so the stamp path
        was the only route to add `schema_version=2` to disk. But
        that branch compared `raw["schema_version"]` AFTER
        _migrate_schema mutated it to the current value — so the
        comparison was always False and the stamp never fired.
        Self-heals on the first save_config, but leaves load_config's
        idempotency contract broken: a fresh boot re-runs the
        v1→v2 migration pass (cheap but wasteful).

        After pass-23 M: the pre-migration version is captured and
        used for the comparison, so the stamp fires correctly.
        """
        # Seed a 1.1.0-beta-shaped config: encrypted keys, no
        # schema_version. Use the encrypt_value helper so the key
        # shape is legit (otherwise it'd fall into the re-encryption
        # branch, not the stamp branch, and we wouldn't exercise M).
        self.config_mod.load_config()  # initialize encryption_key
        encrypted = self.config_mod.encrypt_value("sk-pretend-encrypted-key-12345")
        legacy = {
            "providers": {"openrouter": {"key": encrypted}},
            "preferences": {"remote_provider": "openrouter"},
            # schema_version deliberately absent
        }
        self.config_mod.CONFIG_PATH.write_text(
            json.dumps(legacy),
            encoding="utf-8",
        )
        # Pre-load: on-disk has NO schema_version
        raw = json.loads(self.config_mod.CONFIG_PATH.read_text(encoding="utf-8"))
        self.assertNotIn("schema_version", raw)
        # Trigger load — should stamp the version to disk
        self.config_mod.load_config()
        # Post-load: on-disk MUST now have schema_version = SCHEMA_VERSION
        raw_after = json.loads(self.config_mod.CONFIG_PATH.read_text(encoding="utf-8"))
        self.assertEqual(
            raw_after.get("schema_version"),
            self.config_mod.SCHEMA_VERSION,
            "M regression — schema_version not stamped to disk",
        )

    def test_encryption_keyfile_created_atomically(self):
        """First `load_config` on a fresh data dir must persist a
        non-empty .encryption_key. A zero-length keyfile would
        silently invalidate every previously-encrypted value on next
        load — so atomicity here is shipping-critical."""
        self.config_mod.load_config()
        kf = self.config_mod._KEYFILE
        self.assertTrue(kf.exists())
        self.assertGreater(len(kf.read_bytes()), 0)


if __name__ == "__main__":
    unittest.main()
