#!/usr/bin/env python3
"""
cmd_verify（scripts/skill_upload.py）改造后的单元测试。

背景：verify 子命令原来调 GET /api/records?status=all 拉全表按 recordId 比对，表大了会
超时甚至拖崩知发。改成按 __platform 分桶调用 POST /api/records/by-ids，只查本次 recordId。
本文件覆盖三种场景：
  ① 全部找到 → status=ok
  ② 缺一条 → status=mismatch 且 missing 正确
  ③ 接口失败 → sys.exit(1)，且不回退调用 /api/records（zhifa_get 全程不应被调用）

运行方式（与 tests/test_copywriting_contract.py 一致）：
    python3 -m unittest tests.test_verify_by_ids -v
    python3 tests/test_verify_by_ids.py
"""
import contextlib
import io
import json
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from scripts import skill_upload  # noqa: E402


def write_create_results(tmp_dir: pathlib.Path, results: list) -> str:
    path = tmp_dir / "create_results.json"
    path.write_text(json.dumps({"results": results}, ensure_ascii=False), encoding="utf-8")
    return str(path)


class VerifyByIdsTests(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self.tmp_dir = pathlib.Path(self._tmpdir.name)

    def tearDown(self):
        self._tmpdir.cleanup()

    def _run_cmd_verify(self, create_results_json: str):
        output_file = str(self.tmp_dir / "verify_result.json")
        with contextlib.redirect_stdout(io.StringIO()) as out:
            skill_upload.cmd_verify(create_results_json, output_file=output_file)
        return output_file, out.getvalue()

    def test_all_found_status_ok(self):
        create_results_json = write_create_results(self.tmp_dir, [
            {"status": "success", "recordId": "r1"},
            {"status": "success", "recordId": "r2"},
            {"status": "success", "recordId": "r3"},
        ])

        def fake_zhifa_post(path, payload, timeout=60):
            self.assertEqual(path, "/api/records/by-ids")
            self.assertNotIn("platform", payload)  # 无 __platform 的旧结果不应传 platform
            return {
                "success": True,
                "data": [{"recordId": rid} for rid in payload["recordIds"]],
                "absent": [],
            }

        with mock.patch.object(skill_upload, "zhifa_post", side_effect=fake_zhifa_post) as post, \
             mock.patch.object(skill_upload, "zhifa_get") as get:
            output_file, _ = self._run_cmd_verify(create_results_json)
            self.assertTrue(post.called)
            get.assert_not_called()

        verify_data = json.loads(pathlib.Path(output_file).read_text(encoding="utf-8"))
        self.assertEqual(verify_data["status"], "ok")
        self.assertEqual(verify_data["expected_count"], 3)
        self.assertEqual(verify_data["actual_count"], 3)
        self.assertEqual(verify_data["missing"], [])

    def test_one_missing_status_mismatch(self):
        create_results_json = write_create_results(self.tmp_dir, [
            {"status": "success", "recordId": "r1", "__platform": "xiaohongshu"},
            {"status": "success", "recordId": "r2", "__platform": "xiaohongshu"},
        ])

        def fake_zhifa_post(path, payload, timeout=60):
            self.assertEqual(payload.get("platform"), "xiaohongshu")
            # r2 缺失：只返回 r1
            found = [rid for rid in payload["recordIds"] if rid == "r1"]
            return {"success": True, "data": [{"recordId": rid} for rid in found], "absent": ["r2"]}

        with mock.patch.object(skill_upload, "zhifa_post", side_effect=fake_zhifa_post), \
             mock.patch.object(skill_upload, "zhifa_get") as get:
            output_file, _ = self._run_cmd_verify(create_results_json)
            get.assert_not_called()

        verify_data = json.loads(pathlib.Path(output_file).read_text(encoding="utf-8"))
        self.assertEqual(verify_data["status"], "mismatch")
        self.assertEqual(verify_data["expected_count"], 2)
        self.assertEqual(verify_data["actual_count"], 1)
        self.assertEqual(verify_data["missing"], ["r2"])
        self.assertEqual(verify_data["byPlatform"]["xiaohongshu"]["missing"], ["r2"])

    def test_api_failure_exits_1_and_never_falls_back_to_full_table(self):
        create_results_json = write_create_results(self.tmp_dir, [
            {"status": "success", "recordId": "r1"},
        ])

        def fake_zhifa_post(path, payload, timeout=60):
            return {"success": False, "error": "mock 接口失败"}

        with mock.patch.object(skill_upload, "zhifa_post", side_effect=fake_zhifa_post), \
             mock.patch.object(skill_upload, "zhifa_get") as get, \
             contextlib.redirect_stdout(io.StringIO()), \
             contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as cm:
                skill_upload.cmd_verify(create_results_json, output_file=str(self.tmp_dir / "unused.json"))
            self.assertEqual(cm.exception.code, 1)
            get.assert_not_called()  # 关键：接口失败不得回退拉全表


if __name__ == "__main__":
    unittest.main()
