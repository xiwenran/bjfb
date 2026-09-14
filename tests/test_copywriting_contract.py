import contextlib
import io
import json
import pathlib
import sys
import unittest
from unittest import mock

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from scripts import skill_upload


EVIDENCE_DIR = REPO_ROOT / ".tmp" / "fix-20260909-copywriting" / "python-test-fixtures"


def complete_record(**overrides):
    record = {
        "noteKey": "synthetic/topic/note-001",
        "topic": "北师大四上数学乘法课件",
        "xiaohongshuAccount": "合成测试普通号",
        "douyinAccount": "",
        "title": "北师大四上数学乘法课件笔记",
        "description": (
            "🧭北师大四上数学乘法课件\n"
            "卫星运行时间和计算工具是两个内容点\n\n"
            "📚先看算理，再顺着题目练乘法计算\n"
            "两块内容前后接起来，备课时容易对照"
        ),
        "tags": ["#北师大数学", "#四上数学", "#数学课件", "#乘法", "#教师备课"],
    }
    record.update(overrides)
    return record


class CopywritingContractTest(unittest.TestCase):
    def test_schedule_plan_normalizes_explicit_assignments(self):
        payload = {
            "seed": "fixed-seed",
            "accounts": {
                "xiaohongshu_regular": ["账号A"],
                "xiaohongshu_special": [],
                "douyin": [],
            },
            "accountGroups": {"账号A": "店铺A"},
            "timeSlots": {"regular": ["2026-09-15 06:30-13:00"], "special": []},
            "assignments": [{
                "noteKey": " 专题/001 ",
                "platform": " xiaohongshu ",
                "account": " 账号A ",
                "date": " 2026-09-15 ",
            }],
        }
        normalized = skill_upload.normalize_schedule_plan_payload(payload)
        self.assertEqual(normalized["assignments"], [{
            "noteKey": "专题/001",
            "platform": "xiaohongshu",
            "account": "账号A",
            "date": "2026-09-15",
        }])

        bad_payload = {**payload, "assignments": [{**payload["assignments"][0], "date": "09-15"}]}
        with self.assertRaises(ValueError):
            skill_upload.normalize_schedule_plan_payload(bad_payload)

    def test_lead_gen_empty_copy_is_rejected(self):
        lead_record = complete_record(
            xiaohongshuAccount="合成测试引流号",
            title="",
            description="",
            tags=[],
        )
        results = skill_upload.validate_ai_writing_output_for_dry_run([lead_record])

        violations = [message for _, messages in results for message in messages]
        self.assertTrue(any("description 为空" in message for message in violations), violations)
        self.assertTrue(any("tags 为空" in message for message in violations), violations)

    def test_normal_complete_copy_passes_skill_validator(self):
        results = skill_upload.validate_ai_writing_output_for_dry_run([complete_record()])
        violations = [message for _, messages in results for message in messages]
        self.assertEqual(violations, [])

    def test_book_title_internal_punctuation_is_not_counted_as_extra_title_punctuation(self):
        titles = [
            "《认识立体图形（1）》这样讲思路很清晰",
            "《除法的初步认识——平均分》这样讲",
            "《口算乘法（1）》这样讲思路很清晰",
        ]
        for title in titles:
            with self.subTest(title=title):
                results = skill_upload.validate_ai_writing_output_for_dry_run([
                    complete_record(title=title)
                ])
                violations = [message for _, messages in results for message in messages]
                self.assertFalse(any("title 标点符号" in message for message in violations), violations)

    def test_book_title_exception_keeps_outside_and_unclosed_punctuation_checks(self):
        outside = complete_record(title="《认识立体图形（1）》这样讲，思路清晰！")
        results = skill_upload.validate_ai_writing_output_for_dry_run([outside])
        violations = [message for _, messages in results for message in messages]
        self.assertTrue(any("title 标点符号 2 个" in message for message in violations), violations)

        unclosed = complete_record(title="《认识立体图形（1）这样讲思路很清晰")
        results = skill_upload.validate_ai_writing_output_for_dry_run([unclosed])
        violations = [message for _, messages in results for message in messages]
        self.assertTrue(any("title 标点符号 2 个" in message for message in violations), violations)

    def test_explicit_boolean_allows_only_an_actually_empty_description(self):
        allowed = complete_record(description="", allowEmptyDescription=True)
        results = skill_upload.validate_ai_writing_output_for_dry_run([allowed])
        violations = [message for _, messages in results for message in messages]
        self.assertEqual(violations, [])

        for value in (False, "true", 1):
            with self.subTest(value=value):
                rejected = complete_record(description="", allowEmptyDescription=value)
                results = skill_upload.validate_ai_writing_output_for_dry_run([rejected])
                violations = [message for _, messages in results for message in messages]
                self.assertTrue(any("description 为空" in message for message in violations), violations)

        bad_nonempty = complete_record(description="太短", allowEmptyDescription=True)
        results = skill_upload.validate_ai_writing_output_for_dry_run([bad_nonempty])
        violations = [message for _, messages in results for message in messages]
        self.assertTrue(any("description 字数" in message for message in violations), violations)

    def test_empty_description_flag_does_not_relax_title_or_tags(self):
        record = complete_record(
            title="",
            description="",
            tags=[],
            allowEmptyDescription=True,
        )
        results = skill_upload.validate_ai_writing_output_for_dry_run([record])
        violations = [message for _, messages in results for message in messages]
        self.assertTrue(any("tags 为空" in message for message in violations), violations)
        self.assertFalse(any("description 为空" in message for message in violations), violations)

    def test_ai_fallback_fills_description_when_title_and_tags_already_exist(self):
        incomplete = complete_record(description="")
        generated = complete_record()
        with mock.patch.object(skill_upload, "zhifa_post_batch", return_value=generated) as post:
            with contextlib.redirect_stdout(io.StringIO()):
                result = skill_upload.run_ai_fallback([incomplete])

        post.assert_called_once()
        self.assertEqual(result[0]["description"], generated["description"])
        self.assertEqual(result[0]["tags"], generated["tags"])

    def test_ai_fallback_skips_explicit_empty_description(self):
        record = complete_record(description="", allowEmptyDescription=True)
        with mock.patch.object(skill_upload, "zhifa_post_batch") as post:
            with contextlib.redirect_stdout(io.StringIO()):
                result = skill_upload.run_ai_fallback([record])

        post.assert_not_called()
        self.assertEqual(result[0]["description"], "")

    def test_build_records_rejects_missing_copy_instead_of_storing_empty_fields(self):
        EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
        scan_path = EVIDENCE_DIR / "scan.json"
        schedule_path = EVIDENCE_DIR / "schedule.json"
        content_path = EVIDENCE_DIR / "content-missing.json"
        output_path = EVIDENCE_DIR / "records-missing.json"
        scan_path.write_text(json.dumps([{
            "topic": "北师大四上数学乘法课件",
            "notes": [{
                "noteKey": "synthetic/topic/note-001",
                "folderPath": "/synthetic/not-used",
                "images": [{"name": "01.png", "path": "/synthetic/01.png"}],
            }],
        }], ensure_ascii=False), encoding="utf-8")
        schedule_path.write_text(json.dumps({"schedule": [{
            "noteKey": "synthetic/topic/note-001",
            "platform": "xiaohongshu",
            "account": "合成测试普通号",
            "publishTime": "2026-09-10 09:00",
        }]}, ensure_ascii=False), encoding="utf-8")
        content_path.write_text("{}", encoding="utf-8")

        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                skill_upload.cmd_build_records(
                    str(scan_path), str(schedule_path), str(content_path), str(output_path)
                )

    def test_build_records_and_create_preserve_empty_description_flag(self):
        EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
        scan_path = EVIDENCE_DIR / "scan-empty-description.json"
        schedule_path = EVIDENCE_DIR / "schedule-empty-description.json"
        content_path = EVIDENCE_DIR / "content-empty-description.json"
        records_path = EVIDENCE_DIR / "records-empty-description.json"
        results_path = EVIDENCE_DIR / "results-empty-description.json"
        scan_path.write_text(json.dumps([{
            "topic": "北师大四上数学乘法课件",
            "notes": [{
                "noteKey": "synthetic/topic/note-001",
                "folderPath": "/synthetic/not-used",
                "images": [],
            }],
        }], ensure_ascii=False), encoding="utf-8")
        schedule_path.write_text(json.dumps({"schedule": [{
            "noteKey": "synthetic/topic/note-001",
            "platform": "xiaohongshu",
            "account": "合成测试普通号",
            "publishTime": "2026-09-15 09:00",
        }]}, ensure_ascii=False), encoding="utf-8")
        content_path.write_text(json.dumps({
            "synthetic/topic/note-001": {
                "title": "北师大四上数学乘法课件笔记",
                "description": "",
                "tags": ["#北师大数学", "#四上数学", "#数学课件", "#乘法", "#教师备课"],
                "allowEmptyDescription": True,
            },
        }, ensure_ascii=False), encoding="utf-8")

        with contextlib.redirect_stdout(io.StringIO()):
            skill_upload.cmd_build_records(
                str(scan_path), str(schedule_path), str(content_path), str(records_path)
            )
        payload = json.loads(records_path.read_text(encoding="utf-8"))
        self.assertIs(payload["records"][0]["allowEmptyDescription"], True)
        self.assertEqual(payload["records"][0]["description"], "")

        response = {"results": [{"noteKey": "synthetic/topic/note-001", "status": "success"}]}
        with mock.patch.object(skill_upload, "zhifa_post_batch", return_value=response) as post:
            with contextlib.redirect_stdout(io.StringIO()):
                skill_upload.cmd_create(str(records_path), output_file=str(results_path))

        sent_record = post.call_args.args[1]["records"][0]
        self.assertIs(sent_record["allowEmptyDescription"], True)
        self.assertEqual(sent_record["description"], "")

    def test_manual_copy_display_ends_with_blank_line_and_keeps_fields_separate(self):
        content = complete_record()
        rendered = skill_upload.format_manual_copy_text(
            content["title"], content["description"], content["tags"]
        )
        self.assertTrue(rendered.endswith("\n\n"), repr(rendered[-20:]))
        self.assertIn("【正文】\n" + content["description"] + "\n\n【标签】\n", rendered)
        self.assertNotIn("#北师大数学", content["description"])


if __name__ == "__main__":
    unittest.main()
