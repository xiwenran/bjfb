#!/usr/bin/env python3
"""
zhifa Skill 辅助脚本
用于 Claude Code Skill 调用知发（zhifa）的导入 API。

用法：
  python3 skill_upload.py scan <folder_path>
  python3 skill_upload.py scan-many <folder_path> [<folder_path> ...] [--output result.json]
  python3 skill_upload.py materialize-covers <scan_json_file>
  python3 skill_upload.py schedule <scan_json_file> <plan_json_file> [--output schedule.json]
  python3 skill_upload.py build-records <scan_json_file> <schedule_json_file> <content_json_file> <output_json_file>
  python3 skill_upload.py create <records_json_file> [--ai-fallback] [--batch-size N] [--timeout S] [--batch-delay S]
  python3 skill_upload.py postprocess <records_json_file> <results_json_file>
  python3 skill_upload.py archive <source_dir> <target_dir> <schedule_json_file>
"""

import argparse
import datetime
import json
import os
import random
import re
import shutil
import sys
import time
import urllib.error
import urllib.request

ZHIFA_BASE = "http://localhost:3210"
SCAN_RESULT_TMP = "/tmp/zhifa_scan_result.json"
SCAN_MANY_RESULT_TMP = "/tmp/zhifa_scan_many_result.json"
FAILED_UPLOAD_TMP = "/tmp/zhifa_upload_failed.json"
COVER_NAME_RE = re.compile(r"^0(?:(?:\(\d+\))|(?:（\d+）)|(?:\.\d+))?$", re.IGNORECASE)
COVER_BASENAMES = {"0", "cover", "封面"}
TIME_WINDOW_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$")


def zhifa_post(path: str, payload: dict, timeout: int = 60) -> dict:
    """POST JSON to zhifa API, return parsed response."""
    url = ZHIFA_BASE + path
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body)
    except urllib.error.URLError as e:
        if "Connection refused" in str(e) or "connection refused" in str(e):
            print("知发服务未运行，请打开知发 App（localhost:3210）", file=sys.stderr)
        else:
            print(f"请求失败：{e}", file=sys.stderr)
        sys.exit(1)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        print(f"HTTP {e.code} 错误：{body}", file=sys.stderr)
        sys.exit(1)


def read_json_file(file_path: str):
    with open(file_path, encoding="utf-8") as f:
        return json.load(f)


def write_json_file(file_path: str, payload) -> None:
    with open(file_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)


def note_has_primary_cover(images: list | None) -> bool:
    if not isinstance(images, list):
        return False
    for image in images:
        if not isinstance(image, dict):
            continue
        base = os.path.splitext(str(image.get("name") or ""))[0]
        if base.lower() in COVER_BASENAMES or COVER_NAME_RE.match(base):
            return True
    return False


def collect_cover_candidates(topic_path: str) -> list[dict]:
    if not topic_path or not os.path.isdir(topic_path):
        return []
    candidates = []
    for entry_name in sorted(os.listdir(topic_path)):
        if entry_name.startswith("."):
            continue
        file_path = os.path.join(topic_path, entry_name)
        if not os.path.isfile(file_path):
            continue
        stem, ext = os.path.splitext(entry_name)
        if ext.lower() not in {".jpg", ".jpeg", ".png", ".webp", ".gif"}:
            continue
        if stem.lower() not in COVER_BASENAMES and not COVER_NAME_RE.match(stem):
            continue
        candidates.append({
            "name": entry_name,
            "path": file_path,
            "size": os.path.getsize(file_path),
        })
    return candidates


def print_scan_summary(result: list) -> None:
    total_topics = len(result)
    print(f"扫描结果：共 {total_topics} 个主题组\n")

    for i, topic_entry in enumerate(result, 1):
        topic_name = topic_entry.get("topic", "（未知主题）")
        notes = topic_entry.get("notes", [])
        print(f"组{i}：{topic_name}（{len(notes)} 篇笔记）")
        for note in notes:
            note_key = note.get("noteKey", "")
            images = note.get("images", [])
            image_count = len(images)
            cover_status = "含主序号 0 封面 ✓" if note_has_primary_cover(images) else "⚠️  缺封面（0*）"
            print(f"  笔记 {note_key}：{image_count} 张图（{cover_status}）")
        print()


def load_scan_entries(scan_json_file: str) -> list:
    scan_json_file = os.path.expanduser(scan_json_file)
    if not os.path.isfile(scan_json_file):
        print(f"扫描结果文件不存在：{scan_json_file}", file=sys.stderr)
        sys.exit(1)
    payload = read_json_file(scan_json_file)
    if not isinstance(payload, list):
        print(f"扫描结果格式错误：{scan_json_file} 需要 JSON 数组", file=sys.stderr)
        sys.exit(1)
    return payload


def note_key_parts(note_key: str) -> tuple[str, str]:
    value = str(note_key or "").strip()
    if "/" not in value:
        raise ValueError(f"无效 noteKey：{value}")
    return value.rsplit("/", 1)


def parse_hhmm(value: str) -> tuple[int, int]:
    text = str(value or "").strip()
    try:
        hour_str, minute_str = text.split(":", 1)
        hour = int(hour_str)
        minute = int(minute_str)
    except ValueError as exc:
        raise ValueError(f"非法时间：{value}") from exc
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        raise ValueError(f"非法时间：{value}")
    return hour, minute


def normalize_window_entry(entry: dict) -> str:
    if not isinstance(entry, dict):
        raise ValueError("timeWindows 中每一项都必须是对象")
    date = str(entry.get("date") or "").strip()
    start = str(entry.get("start") or "").strip()
    end = str(entry.get("end") or "").strip()
    if not date or not start or not end:
        raise ValueError("timeWindows 项必须包含 date / start / end")
    parse_hhmm(start)
    parse_hhmm(end)
    return f"{date} {start}-{end}"


def normalize_schedule_plan_payload(payload: dict) -> dict:
    if "timeSlots" in payload:
        return payload

    accounts = payload.get("accounts")
    time_windows = payload.get("timeWindows")
    if not isinstance(accounts, dict):
        raise ValueError("调度参数缺少 accounts 对象")
    if not isinstance(time_windows, dict):
        raise ValueError("调度参数缺少 timeWindows 对象")

    return {
        "accounts": accounts,
        "timeSlots": {
            "regular": [normalize_window_entry(item) for item in (time_windows.get("regular") or [])],
            "special": [normalize_window_entry(item) for item in (time_windows.get("special") or [])],
        },
        "perAccountPerSlot": payload.get("perAccountPerSlot", 1),
    }


def resolve_window_publish_times(schedule: list[dict]) -> dict[str, str]:
    grouped: dict[str, list[str]] = {}
    for item in schedule:
        raw_publish_time = str(item.get("publishTime") or "").strip()
        note_key = str(item.get("noteKey") or "").strip()
        if TIME_WINDOW_RE.match(raw_publish_time):
            grouped.setdefault(raw_publish_time, []).append(note_key)

    resolved: dict[str, str] = {}
    for raw_window, note_keys in grouped.items():
        matched = TIME_WINDOW_RE.match(raw_window)
        if not matched:
            continue
        date_text, start_text, end_text = matched.groups()
        start_hour, start_minute = parse_hhmm(start_text)
        end_hour, end_minute = parse_hhmm(end_text)
        start_dt = datetime.datetime.strptime(f"{date_text} {start_hour:02d}:{start_minute:02d}", "%Y-%m-%d %H:%M")
        end_dt = datetime.datetime.strptime(f"{date_text} {end_hour:02d}:{end_minute:02d}", "%Y-%m-%d %H:%M")
        if end_dt <= start_dt:
            raise ValueError(f"非法时间窗：{raw_window}")

        total_minutes = int((end_dt - start_dt).total_seconds() // 60)
        if total_minutes < len(note_keys):
            raise ValueError(f"时间窗容量不足：{raw_window} 只有 {total_minutes} 分钟，无法分配 {len(note_keys)} 条记录")

        minute_offsets = sorted(random.sample(range(total_minutes), len(note_keys)))
        shuffled_keys = note_keys[:]
        random.shuffle(shuffled_keys)
        for note_key, minute_offset in zip(shuffled_keys, minute_offsets):
            resolved[note_key] = (start_dt + datetime.timedelta(minutes=minute_offset)).strftime("%Y-%m-%d %H:%M")

    return resolved


def zhifa_post_batch(path: str, payload: dict, timeout: int = 300) -> dict | None:
    """POST JSON to zhifa API with custom timeout, return None on error (non-fatal)."""
    url = ZHIFA_BASE + path
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body)
    except urllib.error.URLError as e:
        if "Connection refused" in str(e) or "connection refused" in str(e):
            print("知发服务未运行，请打开知发 App（localhost:3210）", file=sys.stderr)
            sys.exit(1)
        print(f"  ⚠️  请求失败：{e}", file=sys.stderr)
        return None
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        print(f"  ⚠️  HTTP {e.code} 错误：{body}", file=sys.stderr)
        return None


def decide_batch_params(total: int) -> tuple[int, float, int]:
    """
    根据记录总数自动决定分批参数。
    返回 (batch_size, batch_delay_seconds, per_batch_timeout_seconds)
    """
    if total <= 10:
        return total, 0.0, 300
    elif total <= 20:
        return 5, 3.0, 300
    elif total <= 50:
        return 3, 5.0, 300
    elif total <= 100:
        return 2, 8.0, 300
    elif total <= 300:
        return 2, 10.0, max(300, 5 * 60)
    else:
        return 2, 12.0, 600


def record_retry_key(record: dict) -> str:
    """Build a retry key that distinguishes the same note across platforms."""
    note_key = str(record.get("noteKey") or "")
    xhs_account = str(record.get("xiaohongshuAccount") or "").strip()
    dy_account = str(record.get("douyinAccount") or "").strip()
    if xhs_account:
        return f"xiaohongshuAccount|{xhs_account}|{note_key}"
    if dy_account:
        return f"douyinAccount|{dy_account}|{note_key}"
    return f"unknown||{note_key}"


def parse_batch_result(result: dict | None, batch_records: list | None = None) -> tuple[list, list, list]:
    """
    解析单批 API 响应，返回 (success_list, skipped_list, failed_list)。
    任意字段缺失时返回空列表。
    """
    if result is None:
        return [], [], []

    if isinstance(result, dict) and "results" in result:
        result_list = result["results"]
    elif isinstance(result, list):
        result_list = result
    else:
        return [], [], []

    enriched_results = []
    for i, item in enumerate(result_list):
        if not isinstance(item, dict):
            continue
        enriched = dict(item)
        if batch_records and i < len(batch_records) and isinstance(batch_records[i], dict):
            enriched["__retryKey"] = record_retry_key(batch_records[i])
        enriched_results.append(enriched)

    success = [r for r in enriched_results if r.get("status") == "success"]
    skipped = [r for r in enriched_results if r.get("status") == "skipped"]
    failed = [r for r in enriched_results if r.get("status") == "failed"]
    return success, skipped, failed


def normalize_batch_results(result: dict | None, batch_records: list, batch_idx: int) -> list[dict]:
    if result is None:
        return [
            {
                "noteKey": r.get("noteKey", f"batch{batch_idx}-{j}"),
                "status": "failed",
                "__retryKey": record_retry_key(r),
                "reason": "网络请求失败",
            }
            for j, r in enumerate(batch_records)
        ]

    if isinstance(result, dict) and "results" in result:
        result_list = result["results"]
    elif isinstance(result, list):
        result_list = result
    else:
        result_list = []

    normalized = []
    for i, record in enumerate(batch_records):
        item = result_list[i] if i < len(result_list) and isinstance(result_list[i], dict) else {}
        enriched = dict(item)
        enriched.setdefault("noteKey", record.get("noteKey", f"batch{batch_idx}-{i}"))
        enriched.setdefault("status", "failed")
        if enriched["status"] == "failed" and not (enriched.get("reason") or enriched.get("message")):
            enriched["reason"] = "上传接口未返回该记录结果"
        enriched["__retryKey"] = record_retry_key(record)
        normalized.append(enriched)
    return normalized


def run_ai_fallback(records: list) -> list:
    """
    对 title 为空或 tags 为空列表的记录，调 AI 写作接口生成文案。
    成功则内存中更新，失败则加 __ai_failed_warning 标记。
    返回更新后的 records 列表。
    """
    needs_ai = []
    for i, rec in enumerate(records):
        title_empty = not rec.get("title", "").strip()
        tags_empty = not rec.get("tags", [])
        if title_empty or tags_empty:
            needs_ai.append((i, rec))

    if not needs_ai:
        print("AI fallback：所有记录均有标题和标签，跳过 AI 生成。")
        return records

    print(f"AI fallback：发现 {len(needs_ai)} 条记录缺少标题或标签，正在调用 AI 生成…")

    ai_failed_notes = []
    for i, rec in needs_ai:
        note_key = rec.get("noteKey", f"index-{i}")
        topic = rec.get("topic") or rec.get("noteKey", "")
        # 尝试判断平台（优先用记录字段，否则默认 xiaohongshu）
        platform = rec.get("platform", "xiaohongshu")
        if not platform:
            platform = "xiaohongshu"

        try:
            resp = zhifa_post_batch(
                "/api/ai-writing/generate",
                {"topic": topic, "platform": platform},
                timeout=60,
            )
            if resp and resp.get("title"):
                records[i] = {**rec, **{
                    k: v for k, v in resp.items()
                    if k in ("title", "description", "tags")
                }}
                print(f"  ✅ [{note_key}] AI 生成成功：{resp.get('title', '')[:30]}…")
            else:
                records[i]["__ai_failed_warning"] = True
                ai_failed_notes.append(note_key)
                print(f"  ⚠️  [{note_key}] AI 返回为空，跳过（需手动补文案）")
        except Exception as e:
            records[i]["__ai_failed_warning"] = True
            ai_failed_notes.append(note_key)
            print(f"  ⚠️  [{note_key}] AI 生成异常：{e}（需手动补文案）")

    if ai_failed_notes:
        print(f"\nAI fallback 失败，需手动补文案的笔记（共 {len(ai_failed_notes)} 条）：")
        for nk in ai_failed_notes:
            print(f"  - {nk}")
        print()

    return records


def parse_publish_time(value: str) -> datetime.datetime:
    """Parse supported publishTime formats with stdlib datetime only."""
    for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M:%S%z"):
        try:
            return datetime.datetime.strptime(value, fmt)
        except (TypeError, ValueError):
            pass
    raise ValueError(f"不支持的时间格式：{value}")


def strip_template_suffix(note_key: str) -> str:
    parts = str(note_key).rsplit("/", 1)
    if len(parts) == 2 and parts[1].isdigit():
        return parts[0]
    return str(note_key)


def extract_template_number(note_key: str) -> int | None:
    parts = str(note_key).rsplit("/", 1)
    if len(parts) == 2 and parts[1].isdigit():
        return int(parts[1])
    return None


def platform_account_values(record: dict) -> list[tuple[str, str, str]]:
    accounts = []
    for key, platform in (("xiaohongshuAccount", "小红书"), ("douyinAccount", "抖音")):
        value = str(record.get(key) or "").strip()
        if value:
            accounts.append((key, platform, value))
    return accounts


def validate_records_for_dry_run(records: list) -> bool:
    """Run local validation checks for create --dry-run."""
    check_results = []
    all_violations = []

    violations = []
    required_keys = ("noteKey", "folderPath", "images", "publishTime")
    if not isinstance(records, list) or not records:
        violations.append("records 必须是非空数组")
    else:
        for i, record in enumerate(records):
            if not isinstance(record, dict):
                violations.append(f"records[{i}] 必须是对象")
                continue
            for key in required_keys:
                if key not in record:
                    violations.append(f"records[{i}] 缺少必填字段 {key}")
            xhs_account = str(record.get("xiaohongshuAccount") or "").strip()
            dy_account = str(record.get("douyinAccount") or "").strip()
            if not xhs_account and not dy_account:
                violations.append(
                    f"records[{i}] 至少需要 xiaohongshuAccount 或 douyinAccount 之一"
                )
            if xhs_account and dy_account:
                violations.append(
                    f"records[{i}] 不能同时填写 xiaohongshuAccount 和 douyinAccount；同一笔记发两个平台时必须拆成两条记录"
                )
    check_results.append(("JSON format", violations))

    violations = []
    if isinstance(records, list):
        for i, record in enumerate(records):
            if not isinstance(record, dict):
                continue
            images = record.get("images")
            if not isinstance(images, list):
                violations.append(f"records[{i}].images 必须是数组")
                continue
            for j, image in enumerate(images):
                if not isinstance(image, dict) or "path" not in image:
                    violations.append(f"records[{i}].images[{j}] 缺少 path")
                    continue
                image_path = os.path.expanduser(str(image.get("path")))
                if not os.path.isfile(image_path):
                    violations.append(f"records[{i}].images[{j}].path 文件不存在：{image.get('path')}")
    check_results.append(("Image paths", violations))

    violations = []
    account_groups: dict[str, list[dict]] = {}
    if isinstance(records, list):
        for record in records:
            if not isinstance(record, dict):
                continue
            for account_key, platform, account in platform_account_values(record):
                group_key = f"{account_key}:{account}"
                account_groups.setdefault(group_key, []).append({
                    "record": record,
                    "label": f"{platform}:{account}",
                })
        for account_group in account_groups.values():
            account = account_group[0]["label"]
            account_records = [item["record"] for item in account_group]
            note_keys = [str(r.get("noteKey", "")) for r in account_records if r.get("noteKey")]
            template_numbers = [
                extract_template_number(note_key)
                for note_key in note_keys
            ]
            template_numbers = [n for n in template_numbers if n is not None]
            if not template_numbers:
                violations.append(f"{account} 没有可解析的 noteKey 模板编号")
                continue
            num_topics = len({strip_template_suffix(note_key) for note_key in note_keys})
            num_templates = max(template_numbers)
            max_variety = min(num_topics, num_templates)
            min_required = max(max_variety - 1, max_variety // 2)
            used_variety = len(set(template_numbers))
            if used_variety < min_required:
                violations.append(
                    f"{account} 模板多样性严重不足：使用 {used_variety} 种，至少需要 {min_required} 种（满分 {max_variety}）"
                )
    check_results.append(("Template diversity", violations))

    violations = []
    if isinstance(records, list):
        timed_groups: dict[str, list[tuple[datetime.datetime, str, str]]] = {}
        for i, record in enumerate(records):
            if not isinstance(record, dict):
                continue
            try:
                publish_time = parse_publish_time(record.get("publishTime"))
            except ValueError as e:
                violations.append(f"records[{i}].publishTime {e}")
                continue
            for account_key, platform, account in platform_account_values(record):
                group_key = f"{account_key}:{account}"
                account_label = f"{platform}:{account}"
                timed_groups.setdefault(group_key, []).append((publish_time, str(record.get("noteKey", "")), account_label))
        for items in timed_groups.values():
            items.sort(key=lambda item: item[0])
            for (prev_time, prev_key, account_label), (next_time, next_key, _) in zip(items, items[1:]):
                if (next_time - prev_time).total_seconds() < 600:
                    violations.append(
                        f"{account_label} 时间间隔不足 10 分钟：{prev_key} 与 {next_key}"
                    )
    check_results.append(("Time interval", violations))

    violations = []
    note_platform_seen: set[tuple[str, str]] = set()
    account_time_seen: set[tuple[str, str, str]] = set()
    if isinstance(records, list):
        for i, record in enumerate(records):
            if not isinstance(record, dict):
                continue
            note_key = str(record.get("noteKey") or "")
            publish_time = str(record.get("publishTime") or "")
            platform_accounts = (
                ("xiaohongshuAccount", str(record.get("xiaohongshuAccount") or "").strip()),
                ("douyinAccount", str(record.get("douyinAccount") or "").strip()),
            )
            for account_key, account in platform_accounts:
                if not account:
                    continue
                note_pair = (account_key, note_key)
                if note_pair in note_platform_seen:
                    violations.append(f"({account_key}, noteKey) 重复：{note_key}")
                else:
                    note_platform_seen.add(note_pair)
                if publish_time:
                    time_pair = (account_key, account, publish_time)
                    if time_pair in account_time_seen:
                        violations.append(f"({account_key}, publishTime) 重复：{account} @ {publish_time}")
                    else:
                        account_time_seen.add(time_pair)
    check_results.append(("No duplicates", violations))

    for label, violations in check_results:
        if violations:
            print(f"❌ {label}：{len(violations)} 个问题")
            for violation in violations:
                print(f"  - {violation}")
            all_violations.extend(violations)
        else:
            print(f"✅ {label}：通过")

    if all_violations:
        print(f"\nDry run 失败：共 {len(all_violations)} 个问题。")
        return False

    print(f"\nDry run 通过：{len(records)} 条记录已完成 5 项本地结构校验。")
    print("提示：dry-run 不检查标题公式、标题吸引力或文案质量；标题仍需按 ai-writer SYSTEM_PROMPT 单独审查。")
    return True


def validate_records_for_create(records: list) -> bool:
    """Run upload-blocking checks that are safe for all supported scan shapes."""
    violations = []
    note_platform_seen: set[tuple[str, str]] = set()
    account_time_seen: set[tuple[str, str, str]] = set()

    if not isinstance(records, list) or not records:
        violations.append("records 必须是非空数组")
    else:
        for i, record in enumerate(records):
            if not isinstance(record, dict):
                violations.append(f"records[{i}] 必须是对象")
                continue

            note_key = str(record.get("noteKey") or "")
            if not note_key:
                violations.append(f"records[{i}] 缺少必填字段 noteKey")

            xhs_account = str(record.get("xiaohongshuAccount") or "").strip()
            dy_account = str(record.get("douyinAccount") or "").strip()
            if not xhs_account and not dy_account:
                violations.append(
                    f"records[{i}] 至少需要 xiaohongshuAccount 或 douyinAccount 之一"
                )
            if xhs_account and dy_account:
                violations.append(
                    f"records[{i}] 不能同时填写 xiaohongshuAccount 和 douyinAccount；同一笔记发两个平台时必须拆成两条记录"
                )

            publish_time = str(record.get("publishTime") or "")
            for account_key, account in (
                ("xiaohongshuAccount", xhs_account),
                ("douyinAccount", dy_account),
            ):
                if not account:
                    continue
                note_pair = (account_key, note_key)
                if note_pair in note_platform_seen:
                    violations.append(f"({account_key}, noteKey) 重复：{note_key}")
                else:
                    note_platform_seen.add(note_pair)
                if publish_time:
                    time_pair = (account_key, account, publish_time)
                    if time_pair in account_time_seen:
                        violations.append(f"({account_key}, publishTime) 重复：{account} @ {publish_time}")
                    else:
                        account_time_seen.add(time_pair)

    if violations:
        print(f"❌ 上传前硬校验失败：{len(violations)} 个问题")
        for violation in violations:
            print(f"  - {violation}")
        return False

    print("✅ 上传前硬校验通过")
    return True


def load_failed_retry_keys() -> set[str]:
    if not os.path.isfile(FAILED_UPLOAD_TMP):
        print(f"失败列表不存在：{FAILED_UPLOAD_TMP}", file=sys.stderr)
        sys.exit(1)
    with open(FAILED_UPLOAD_TMP, encoding="utf-8") as f:
        failed_retry_keys = json.load(f)
    if not isinstance(failed_retry_keys, list):
        print(f"失败列表格式错误：{FAILED_UPLOAD_TMP} 需要 JSON 数组", file=sys.stderr)
        sys.exit(1)
    return {str(key) for key in failed_retry_keys}


def save_failed_retry_keys(failed_records: list) -> None:
    failed_retry_keys = [
        r.get("__retryKey") or r.get("noteKey")
        for r in failed_records
        if isinstance(r, dict) and (r.get("__retryKey") or r.get("noteKey"))
    ]
    if failed_retry_keys:
        with open(FAILED_UPLOAD_TMP, "w", encoding="utf-8") as f:
            json.dump(failed_retry_keys, f, ensure_ascii=False, indent=2)
    elif os.path.exists(FAILED_UPLOAD_TMP):
        os.remove(FAILED_UPLOAD_TMP)


def cmd_scan(folder_path: str) -> None:
    """扫描合成图文件夹，打印人类可读摘要，并把原始 JSON 写入临时文件。"""
    folder_path = os.path.expanduser(folder_path)
    if not os.path.isdir(folder_path):
        print(f"目录不存在：{folder_path}", file=sys.stderr)
        sys.exit(1)

    result = zhifa_post("/api/import/scan-folder", {"folderPath": folder_path})

    # result 是一个 topic 数组
    if not isinstance(result, list):
        print(f"扫描返回格式异常：{result}", file=sys.stderr)
        sys.exit(1)

    write_json_file(SCAN_RESULT_TMP, result)
    print_scan_summary(result)
    print(f"（原始 JSON 已写入 {SCAN_RESULT_TMP}）")


def cmd_scan_many(folder_paths: list[str], output_file: str | None = None) -> None:
    if not folder_paths:
        print("scan-many 至少需要 1 个目录路径", file=sys.stderr)
        sys.exit(1)

    merged = []
    for folder_path in folder_paths:
        folder_path = os.path.expanduser(folder_path)
        if not os.path.isdir(folder_path):
            print(f"目录不存在：{folder_path}", file=sys.stderr)
            sys.exit(1)
        result = zhifa_post("/api/import/scan-folder", {"folderPath": folder_path})
        if not isinstance(result, list):
            print(f"扫描返回格式异常：{result}", file=sys.stderr)
            sys.exit(1)
        merged.extend(result)

    output_path = os.path.expanduser(output_file) if output_file else SCAN_MANY_RESULT_TMP
    write_json_file(output_path, merged)
    print_scan_summary(merged)
    print(f"（合并 JSON 已写入 {output_path}）")


def cmd_materialize_covers(scan_json_file: str) -> None:
    scan_entries = load_scan_entries(scan_json_file)
    updated_topics = []
    total_copied = 0
    total_skipped = 0

    for topic_entry in scan_entries:
        topic_name = str(topic_entry.get("topic") or "")
        topic_path = str(topic_entry.get("path") or "")
        notes = topic_entry.get("notes") or []
        cover_candidates = collect_cover_candidates(topic_path)
        if not cover_candidates:
            updated_topics.append({
                "topic": topic_name,
                "copied": 0,
                "skipped": len(notes),
                "reason": "主题根目录未发现可复制的封面",
            })
            total_skipped += len(notes)
            continue

        copied_for_topic = 0
        skipped_for_topic = 0
        for note in notes:
            folder_path = str(note.get("folderPath") or "")
            if not folder_path or not os.path.isdir(folder_path):
                skipped_for_topic += 1
                continue
            if note_has_primary_cover(note.get("images")):
                skipped_for_topic += 1
                continue
            for cover in cover_candidates:
                destination = os.path.join(folder_path, cover["name"])
                shutil.copy2(cover["path"], destination)
                copied_for_topic += 1
                total_copied += 1
            skipped_for_topic += 0

        total_skipped += skipped_for_topic
        updated_topics.append({
            "topic": topic_name,
            "copied": copied_for_topic,
            "skipped": skipped_for_topic,
            "coverCount": len(cover_candidates),
        })

    print(json.dumps({
        "updatedTopics": updated_topics,
        "totalCopied": total_copied,
        "totalSkipped": total_skipped,
    }, ensure_ascii=False, indent=2))


def cmd_schedule(scan_json_file: str, plan_json_file: str, output_file: str | None = None) -> None:
    scan_entries = load_scan_entries(scan_json_file)
    plan_json_file = os.path.expanduser(plan_json_file)
    if not os.path.isfile(plan_json_file):
        print(f"调度参数文件不存在：{plan_json_file}", file=sys.stderr)
        sys.exit(1)
    payload = read_json_file(plan_json_file)
    if not isinstance(payload, dict):
        print(f"调度参数格式错误：{plan_json_file} 需要 JSON 对象", file=sys.stderr)
        sys.exit(1)
    try:
        payload = normalize_schedule_plan_payload(payload)
    except ValueError as exc:
        print(f"调度参数格式错误：{exc}", file=sys.stderr)
        sys.exit(1)

    note_folders = []
    for topic_entry in scan_entries:
        notes = topic_entry.get("notes") or []
        topic_to_templates: dict[str, list[str]] = {}
        for note in notes:
            try:
                topic_key, template = note_key_parts(str(note.get("noteKey") or ""))
            except ValueError as exc:
                print(str(exc), file=sys.stderr)
                sys.exit(1)
            topic_to_templates.setdefault(topic_key, []).append(template)
        for topic_key, templates in topic_to_templates.items():
            note_folders.append({
                "topic": topic_key,
                "templates": templates,
            })

    request_payload = {
        **payload,
        "noteFolders": note_folders,
    }
    result = zhifa_post("/api/import/schedule", request_payload)
    output_path = os.path.expanduser(output_file) if output_file else "/tmp/zhifa_schedule_result.json"
    write_json_file(output_path, result)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    print(f"（调度 JSON 已写入 {output_path}）")


def cmd_build_records(
    scan_json_file: str,
    schedule_json_file: str,
    content_json_file: str,
    output_file: str,
) -> None:
    scan_entries = load_scan_entries(scan_json_file)
    schedule_json_file = os.path.expanduser(schedule_json_file)
    content_json_file = os.path.expanduser(content_json_file)
    if not os.path.isfile(schedule_json_file):
        print(f"调度结果文件不存在：{schedule_json_file}", file=sys.stderr)
        sys.exit(1)
    if not os.path.isfile(content_json_file):
        print(f"文案映射文件不存在：{content_json_file}", file=sys.stderr)
        sys.exit(1)

    schedule_payload = read_json_file(schedule_json_file)
    content_payload = read_json_file(content_json_file)
    schedule = schedule_payload.get("schedule") if isinstance(schedule_payload, dict) else None
    if not isinstance(schedule, list):
        print(f"调度结果格式错误：{schedule_json_file} 缺少 schedule 数组", file=sys.stderr)
        sys.exit(1)

    note_map = {}
    for topic_entry in scan_entries:
        for note in topic_entry.get("notes") or []:
            note_map[str(note.get("noteKey") or "")] = {
                "topic": topic_entry.get("topic", ""),
                "note": note,
            }

    if isinstance(content_payload, list):
        content_map = {
            str(item.get("noteKey") or ""): item
            for item in content_payload
            if isinstance(item, dict) and item.get("noteKey")
        }
    elif isinstance(content_payload, dict):
        content_map = content_payload
    else:
        print(f"文案映射格式错误：{content_json_file} 需要 JSON 对象或数组", file=sys.stderr)
        sys.exit(1)

    try:
        resolved_publish_times = resolve_window_publish_times(schedule)
    except ValueError as exc:
        print(f"调度结果格式错误：{exc}", file=sys.stderr)
        sys.exit(1)

    records = []
    for item in schedule:
        note_key = str(item.get("noteKey") or "")
        note_hit = note_map.get(note_key)
        if not note_hit:
            print(f"调度结果中的 noteKey 未在扫描结果中找到：{note_key}", file=sys.stderr)
            sys.exit(1)
        content = content_map.get(note_key) or content_map.get(note_hit["topic"]) or {}
        note = note_hit["note"]
        platform = str(item.get("platform") or "").strip()
        account = str(item.get("account") or "").strip()
        records.append({
            "topic": note_hit["topic"],
            "topicOverride": str(content.get("topicOverride") or ""),
            "contentGroup": note.get("contentGroup") or note_hit["topic"],
            "accountGroup": note.get("accountGroup") or note.get("contentGroup") or note_hit["topic"],
            "pptTopic": note.get("pptTopic") or "",
            "noteTitle": note.get("noteTitle") or note.get("folderName") or "",
            "noteKey": note_key,
            "folderPath": note.get("folderPath"),
            "images": note.get("images") or [],
            "videos": note.get("videos") or [],
            "xiaohongshuAccount": account if platform == "xiaohongshu" else "",
            "douyinAccount": account if platform == "douyin" else "",
            "publishTime": resolved_publish_times.get(note_key, str(item.get("publishTime") or "")),
            "xiaohongshuChannel": str(content.get("xiaohongshuChannel") or "蚁小二") if platform == "xiaohongshu" else "",
            "title": str(content.get("title") or ""),
            "description": str(content.get("description") or ""),
            "tags": content.get("tags") if isinstance(content.get("tags"), list) else [],
        })

    output_path = os.path.expanduser(output_file)
    write_json_file(output_path, {"records": records})
    print(f"已生成 {len(records)} 条 records")
    print(f"（records JSON 已写入 {output_path}）")


def cmd_archive(source_dir: str, target_dir: str, schedule_json_file: str) -> None:
    schedule_json_file = os.path.expanduser(schedule_json_file)
    if not os.path.isfile(schedule_json_file):
        print(f"调度结果文件不存在：{schedule_json_file}", file=sys.stderr)
        sys.exit(1)
    schedule_payload = read_json_file(schedule_json_file)
    payload = {
        "sourceDir": os.path.expanduser(source_dir),
        "targetDir": os.path.expanduser(target_dir),
        "schedule": schedule_payload.get("schedule") if isinstance(schedule_payload, dict) else [],
        "unscheduled": schedule_payload.get("unscheduled") if isinstance(schedule_payload, dict) else [],
    }
    result = zhifa_post("/api/import/archive", payload, timeout=300)
    print(json.dumps(result, ensure_ascii=False, indent=2))


def cmd_create(
    records_json_file: str,
    ai_fallback: bool = False,
    override_batch_size: int | None = None,
    override_timeout: int | None = None,
    override_batch_delay: float | None = None,
    dry_run: bool = False,
    retry_failed: bool = False,
    output_file: str | None = None,
) -> None:
    """读取 records JSON 文件，分批 POST 到 create-records API，打印进度和结果摘要。"""
    records_json_file = os.path.expanduser(records_json_file)
    if not os.path.isfile(records_json_file):
        print(f"文件不存在：{records_json_file}", file=sys.stderr)
        sys.exit(1)

    with open(records_json_file, encoding="utf-8") as f:
        payload = json.load(f)

    # 支持两种格式：直接的 records 数组，或 {"records": [...]} 对象
    if isinstance(payload, list):
        records = payload
    elif isinstance(payload, dict) and "records" in payload:
        records = payload["records"]
    else:
        print("JSON 格式错误：需要 {\"records\": [...]} 或直接的数组", file=sys.stderr)
        sys.exit(1)

    if retry_failed:
        failed_retry_keys = load_failed_retry_keys()
        before_retry_filter = len(records)
        records = [
            r for r in records
            if isinstance(r, dict)
            and (record_retry_key(r) in failed_retry_keys or str(r.get("noteKey")) in failed_retry_keys)
        ]
        print(f"retry-failed：从 {before_retry_filter} 条中过滤出 {len(records)} 条失败记录。")

    if dry_run:
        if validate_records_for_dry_run(records):
            sys.exit(0)
        sys.exit(1)

    if not validate_records_for_create(records):
        sys.exit(1)

    total = len(records)
    print(f"准备上传 {total} 篇笔记到知发…\n")

    # AI fallback（上传前扫描+生成）
    if ai_fallback:
        records = run_ai_fallback(records)

    # 决定分批参数（手动覆盖优先）
    auto_batch_size, auto_delay, auto_timeout = decide_batch_params(total)
    batch_size = override_batch_size if override_batch_size is not None else auto_batch_size
    batch_delay = override_batch_delay if override_batch_delay is not None else auto_delay
    per_batch_timeout = override_timeout if override_timeout is not None else auto_timeout

    # 切分批次
    batches = [records[i: i + batch_size] for i in range(0, total, batch_size)]
    n_batches = len(batches)

    if n_batches == 1:
        print(f"记录数 ≤ {batch_size}，整批上传（超时 {per_batch_timeout}s）\n")
    else:
        print(
            f"自动分批：{n_batches} 批，每批 {batch_size} 条，"
            f"批间间隔 {batch_delay}s，单批超时 {per_batch_timeout}s\n"
        )

    # 分批上传
    total_success: list = []
    total_skipped: list = []
    total_failed: list = []
    total_results: list = []
    batch_summaries: list = []
    consecutive_full_failures = 0  # 连续全批失败计数

    for batch_idx, batch in enumerate(batches, 1):
        t0 = time.time()
        batch_n = len(batch)
        result = zhifa_post_batch(
            "/api/import/create-records",
            {"records": batch},
            timeout=per_batch_timeout,
        )
        elapsed = time.time() - t0

        batch_results = normalize_batch_results(result, batch, batch_idx)
        ok = [r for r in batch_results if r.get("status") == "success"]
        skip = [r for r in batch_results if r.get("status") == "skipped"]
        fail = [r for r in batch_results if r.get("status") == "failed"]

        total_results.extend(batch_results)
        total_success.extend(ok)
        total_skipped.extend(skip)
        total_failed.extend(fail)
        batch_summaries.append({
            "batch": batch_idx,
            "total": batch_n,
            "success": len(ok),
            "skipped": len(skip),
            "failed": len(fail),
            "elapsedSeconds": round(elapsed, 3),
        })

        status_line = (
            f"[批次 {batch_idx}/{n_batches}] {batch_n} 条 → "
            f"✅{len(ok)} 成功 ⏭{len(skip)} 跳过 ❌{len(fail)} 失败 "
            f"({elapsed:.1f}s)"
        )
        print(status_line)

        # 连续全批失败检测（超 3 次放弃后续）
        if len(ok) == 0 and len(skip) == 0 and len(fail) > 0:
            consecutive_full_failures += 1
        else:
            consecutive_full_failures = 0

        if consecutive_full_failures >= 3 and batch_idx < n_batches:
            print(
                f"\n⚠️  已连续 {consecutive_full_failures} 批全部失败，放弃后续 {n_batches - batch_idx} 批。"
            )
            # 把剩余记录也计入失败
            for remaining_batch in batches[batch_idx:]:
                for r in remaining_batch:
                    failed_result = {
                        "noteKey": r.get("noteKey", "unknown"),
                        "status": "failed",
                        "__retryKey": record_retry_key(r),
                        "reason": "连续失败后放弃",
                    }
                    total_results.append(failed_result)
                    total_failed.append(failed_result)
            break

        # 批间间隔（最后一批不等待）
        if batch_delay > 0 and batch_idx < n_batches:
            time.sleep(batch_delay)

    # 总结
    print(
        f"\n上传完成：✅{len(total_success)} 成功 / "
        f"⏭{len(total_skipped)} 跳过 / "
        f"❌{len(total_failed)} 失败 / "
        f"总 {total}"
    )

    if total_failed:
        print("\n失败详情：")
        for r in total_failed:
            note_key = r.get("noteKey", "（未知）")
            reason = r.get("reason", "") or r.get("message", "未知原因")
            print(f"  {note_key}：{reason}")

    save_failed_retry_keys(total_failed)

    if output_file:
      output_path = os.path.expanduser(output_file)
      write_json_file(output_path, {
          "recordsFile": records_json_file,
          "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
          "summary": {
              "total": total,
              "success": len(total_success),
              "skipped": len(total_skipped),
              "failed": len(total_failed),
          },
          "batches": batch_summaries,
          "results": total_results,
      })
      print(f"\n（上传结果 JSON 已写入 {output_path}）")

    if total_skipped:
        print("\n跳过（指纹查重命中，已存在）：")
        for r in total_skipped:
            print(f"  {r.get('noteKey', '（未知）')}")

    # 提示 AI fallback 失败的条目
    ai_warned = [r.get("noteKey", "unknown") for r in records if r.get("__ai_failed_warning")]
    if ai_warned:
        print(f"\n⚠️  以下 {len(ai_warned)} 条 AI 文案生成失败，需手动补充标题/标签后重新上传：")
        for nk in ai_warned:
            print(f"  - {nk}")


def cmd_postprocess(records_json_file: str, results_json_file: str, output_file: str | None = None) -> None:
    records_json_file = os.path.expanduser(records_json_file)
    results_json_file = os.path.expanduser(results_json_file)
    if not os.path.isfile(records_json_file):
        print(f"records 文件不存在：{records_json_file}", file=sys.stderr)
        sys.exit(1)
    if not os.path.isfile(results_json_file):
        print(f"上传结果文件不存在：{results_json_file}", file=sys.stderr)
        sys.exit(1)

    payload = read_json_file(records_json_file)
    if isinstance(payload, list):
        records = payload
    elif isinstance(payload, dict) and "records" in payload:
        records = payload["records"]
    else:
        print("records JSON 格式错误：需要 {\"records\": [...]} 或直接的数组", file=sys.stderr)
        sys.exit(1)

    result_payload = read_json_file(results_json_file)
    result_list = result_payload.get("results") if isinstance(result_payload, dict) else result_payload
    if not isinstance(result_list, list):
        print(f"上传结果格式错误：{results_json_file} 需要 results 数组", file=sys.stderr)
        sys.exit(1)

    updates = []
    for i, item in enumerate(result_list):
        if not isinstance(item, dict):
            continue
        if item.get("status") != "success" or not item.get("recordId"):
            continue
        if i >= len(records) or not isinstance(records[i], dict):
            print(f"上传结果第 {i + 1} 条缺少对应 record", file=sys.stderr)
            sys.exit(1)
        record = records[i]
        updates.append({
            "recordId": item["recordId"],
            "noteKey": record.get("noteKey", ""),
            "xiaohongshuAccount": record.get("xiaohongshuAccount", ""),
            "douyinAccount": record.get("douyinAccount", ""),
        })

    result = zhifa_post("/api/import/postprocess", {"updates": updates}, timeout=300)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if output_file:
        output_path = os.path.expanduser(output_file)
        write_json_file(output_path, result)
        print(f"（后处理结果 JSON 已写入 {output_path}）")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="zhifa Skill 辅助脚本——扫描合成图文件夹 / 上传记录到知发"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    # scan 子命令
    scan_parser = subparsers.add_parser("scan", help="扫描合成图文件夹")
    scan_parser.add_argument("folder", help="合成图文件夹路径")

    scan_many_parser = subparsers.add_parser("scan-many", help="扫描多个主题文件夹并合并 JSON")
    scan_many_parser.add_argument("folders", nargs="+", help="主题文件夹路径列表")
    scan_many_parser.add_argument("--output", default=None, help="输出 JSON 路径（默认写入 /tmp）")

    covers_parser = subparsers.add_parser("materialize-covers", help="把主题根目录封面复制到模板目录")
    covers_parser.add_argument("scan_json", help="scan 或 scan-many 生成的 JSON 文件路径")

    schedule_parser = subparsers.add_parser("schedule", help="基于扫描结果和调度参数生成 schedule")
    schedule_parser.add_argument("scan_json", help="scan 或 scan-many 生成的 JSON 文件路径")
    schedule_parser.add_argument("plan_json", help="调度参数 JSON 文件路径")
    schedule_parser.add_argument("--output", default=None, help="输出 schedule JSON 路径（默认写入 /tmp）")

    build_records_parser = subparsers.add_parser("build-records", help="基于扫描结果、调度结果和文案映射生成 records JSON")
    build_records_parser.add_argument("scan_json", help="scan 或 scan-many 生成的 JSON 文件路径")
    build_records_parser.add_argument("schedule_json", help="schedule 生成的 JSON 文件路径")
    build_records_parser.add_argument("content_json", help="标题/标签映射 JSON 文件路径")
    build_records_parser.add_argument("output_json", help="输出 records JSON 路径")

    # create 子命令
    create_parser = subparsers.add_parser("create", help="上传 records JSON 到知发")
    create_parser.add_argument("records_json", help="records JSON 文件路径")
    create_parser.add_argument(
        "--ai-fallback",
        action="store_true",
        default=False,
        help="上传前对缺少标题或标签的记录调 AI 写作接口自动生成文案（默认关闭）",
    )
    create_parser.add_argument(
        "--batch-size",
        type=int,
        default=None,
        metavar="N",
        help="强制指定每批条数（覆盖自动分批决策）",
    )
    create_parser.add_argument(
        "--timeout",
        type=int,
        default=None,
        metavar="S",
        help="强制指定单批超时秒数（覆盖自动决策）",
    )
    create_parser.add_argument(
        "--batch-delay",
        type=float,
        default=None,
        metavar="S",
        help="强制指定批间等待秒数（覆盖自动决策）",
    )
    create_parser.add_argument(
        "--dry-run",
        action="store_true",
        default=False,
        help="仅运行本地校验，不上传、不发起网络请求",
    )
    create_parser.add_argument(
        "--retry-failed",
        action="store_true",
        default=False,
        help=f"仅重试 {FAILED_UPLOAD_TMP} 中记录的 noteKey",
    )
    create_parser.add_argument("--output", default=None, help="输出上传结果 JSON 路径")

    postprocess_parser = subparsers.add_parser("postprocess", help="上传成功后清空笔记主题并设置发布状态")
    postprocess_parser.add_argument("records_json", help="records JSON 文件路径")
    postprocess_parser.add_argument("results_json", help="create-records 返回结果 JSON 文件路径")
    postprocess_parser.add_argument("--output", default=None, help="输出后处理结果 JSON 路径")

    archive_parser = subparsers.add_parser("archive", help="根据 schedule 结果调用归档接口")
    archive_parser.add_argument("source_dir", help="原始合成图根目录")
    archive_parser.add_argument("target_dir", help="归档目标根目录")
    archive_parser.add_argument("schedule_json", help="schedule 结果 JSON 文件路径")

    args = parser.parse_args()

    if args.command == "scan":
        cmd_scan(args.folder)
    elif args.command == "scan-many":
        cmd_scan_many(args.folders, output_file=args.output)
    elif args.command == "materialize-covers":
        cmd_materialize_covers(args.scan_json)
    elif args.command == "schedule":
        cmd_schedule(args.scan_json, args.plan_json, output_file=args.output)
    elif args.command == "build-records":
        cmd_build_records(args.scan_json, args.schedule_json, args.content_json, args.output_json)
    elif args.command == "create":
        if args.dry_run and args.retry_failed:
            print("错误：--dry-run 和 --retry-failed 不能同时使用", file=sys.stderr)
            sys.exit(1)
        cmd_create(
            args.records_json,
            ai_fallback=args.ai_fallback,
            override_batch_size=args.batch_size,
            override_timeout=args.timeout,
            override_batch_delay=args.batch_delay,
            dry_run=args.dry_run,
            retry_failed=args.retry_failed,
            output_file=args.output,
        )
    elif args.command == "postprocess":
        cmd_postprocess(args.records_json, args.results_json, output_file=args.output)
    elif args.command == "archive":
        cmd_archive(args.source_dir, args.target_dir, args.schedule_json)


if __name__ == "__main__":
    main()
