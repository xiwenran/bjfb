#!/usr/bin/env python3
"""
zhifa Skill 辅助脚本
用于 Claude Code Skill 调用知发（zhifa）的导入 API。

用法：
  python3 skill_upload.py scan <folder_path>
  python3 skill_upload.py create <records_json_file> [--ai-fallback] [--batch-size N] [--timeout S] [--batch-delay S]
"""

import argparse
import datetime
import json
import os
import sys
import time
import urllib.error
import urllib.request

ZHIFA_BASE = "http://localhost:3210"
SCAN_RESULT_TMP = "/tmp/zhifa_scan_result.json"
FAILED_UPLOAD_TMP = "/tmp/zhifa_upload_failed.json"


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


def parse_batch_result(result: dict | None) -> tuple[list, list, list]:
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

    success = [r for r in result_list if r.get("status") == "success"]
    skipped = [r for r in result_list if r.get("status") == "skipped"]
    failed = [r for r in result_list if r.get("status") == "failed"]
    return success, skipped, failed


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


def account_values(record: dict) -> list[str]:
    accounts = []
    for key in ("xiaohongshuAccount", "douyinAccount"):
        value = record.get(key)
        if value:
            accounts.append(str(value))
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
            if not record.get("xiaohongshuAccount") and not record.get("douyinAccount"):
                violations.append(
                    f"records[{i}] 至少需要 xiaohongshuAccount 或 douyinAccount 之一"
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
            for account in account_values(record):
                account_groups.setdefault(account, []).append(record)
        for account, account_records in account_groups.items():
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
        timed_groups: dict[str, list[tuple[datetime.datetime, str]]] = {}
        for i, record in enumerate(records):
            if not isinstance(record, dict):
                continue
            try:
                publish_time = parse_publish_time(record.get("publishTime"))
            except ValueError as e:
                violations.append(f"records[{i}].publishTime {e}")
                continue
            for account in account_values(record):
                timed_groups.setdefault(account, []).append((publish_time, str(record.get("noteKey", ""))))
        for account, items in timed_groups.items():
            items.sort(key=lambda item: item[0])
            for (prev_time, prev_key), (next_time, next_key) in zip(items, items[1:]):
                if (next_time - prev_time).total_seconds() < 600:
                    violations.append(
                        f"{account} 时间间隔不足 10 分钟：{prev_key} 与 {next_key}"
                    )
    check_results.append(("Time interval", violations))

    violations = []
    note_keys_seen: set[str] = set()
    xhs_time_seen: set[tuple[str, str]] = set()
    if isinstance(records, list):
        for i, record in enumerate(records):
            if not isinstance(record, dict):
                continue
            note_key = record.get("noteKey")
            if note_key in note_keys_seen:
                violations.append(f"noteKey 重复：{note_key}")
            else:
                note_keys_seen.add(note_key)
            xhs_account = record.get("xiaohongshuAccount")
            publish_time = record.get("publishTime")
            if xhs_account and publish_time:
                pair = (str(xhs_account), str(publish_time))
                if pair in xhs_time_seen:
                    violations.append(f"(xiaohongshuAccount, publishTime) 重复：{pair[0]} @ {pair[1]}")
                else:
                    xhs_time_seen.add(pair)
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


def load_failed_note_keys() -> set[str]:
    if not os.path.isfile(FAILED_UPLOAD_TMP):
        print(f"失败列表不存在：{FAILED_UPLOAD_TMP}", file=sys.stderr)
        sys.exit(1)
    with open(FAILED_UPLOAD_TMP, encoding="utf-8") as f:
        failed_note_keys = json.load(f)
    if not isinstance(failed_note_keys, list):
        print(f"失败列表格式错误：{FAILED_UPLOAD_TMP} 需要 JSON 数组", file=sys.stderr)
        sys.exit(1)
    return {str(note_key) for note_key in failed_note_keys}


def save_failed_note_keys(failed_records: list) -> None:
    failed_note_keys = [
        r.get("noteKey")
        for r in failed_records
        if isinstance(r, dict) and r.get("noteKey")
    ]
    if failed_note_keys:
        with open(FAILED_UPLOAD_TMP, "w", encoding="utf-8") as f:
            json.dump(failed_note_keys, f, ensure_ascii=False, indent=2)
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

    # 写入临时文件供后续步骤读取
    with open(SCAN_RESULT_TMP, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    # 打印人类可读摘要
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
            image_names = {img.get("name", "") for img in images}
            has_cover = "0.jpg" in image_names
            cover_status = "含 0.jpg ✓" if has_cover else "⚠️  缺封面（0.jpg）"
            print(f"  笔记 {note_key}：{image_count} 张图（{cover_status}）")
        print()

    print(f"（原始 JSON 已写入 {SCAN_RESULT_TMP}）")


def cmd_create(
    records_json_file: str,
    ai_fallback: bool = False,
    override_batch_size: int | None = None,
    override_timeout: int | None = None,
    override_batch_delay: float | None = None,
    dry_run: bool = False,
    retry_failed: bool = False,
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
        failed_note_keys = load_failed_note_keys()
        before_retry_filter = len(records)
        records = [r for r in records if isinstance(r, dict) and str(r.get("noteKey")) in failed_note_keys]
        print(f"retry-failed：从 {before_retry_filter} 条中过滤出 {len(records)} 条失败记录。")

    if dry_run:
        if validate_records_for_dry_run(records):
            sys.exit(0)
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

        ok, skip, fail = parse_batch_result(result)

        # 如果 result 是 None（网络失败），把整批算入失败
        if result is None:
            fail_keys = [r.get("noteKey", f"batch{batch_idx}-{j}") for j, r in enumerate(batch)]
            fail_items = [{"noteKey": k, "reason": "网络请求失败"} for k in fail_keys]
            fail = fail_items

        total_success.extend(ok)
        total_skipped.extend(skip)
        total_failed.extend(fail)

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
                    total_failed.append({
                        "noteKey": r.get("noteKey", "unknown"),
                        "reason": "连续失败后放弃",
                    })
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

    save_failed_note_keys(total_failed)

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


def main() -> None:
    parser = argparse.ArgumentParser(
        description="zhifa Skill 辅助脚本——扫描合成图文件夹 / 上传记录到知发"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    # scan 子命令
    scan_parser = subparsers.add_parser("scan", help="扫描合成图文件夹")
    scan_parser.add_argument("folder", help="合成图文件夹路径")

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

    args = parser.parse_args()

    if args.command == "scan":
        cmd_scan(args.folder)
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
        )


if __name__ == "__main__":
    main()
