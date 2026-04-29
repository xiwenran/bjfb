#!/usr/bin/env python3
"""
zhifa Skill 辅助脚本
用于 Claude Code Skill 调用知发（zhifa）的导入 API。

用法：
  python3 skill_upload.py scan <folder_path>
  python3 skill_upload.py create <records_json_file>
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

ZHIFA_BASE = "http://localhost:3210"
SCAN_RESULT_TMP = "/tmp/zhifa_scan_result.json"


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


def cmd_create(records_json_file: str) -> None:
    """读取 records JSON 文件，POST 到 create-records API，打印结果摘要。"""
    records_json_file = os.path.expanduser(records_json_file)
    if not os.path.isfile(records_json_file):
        print(f"文件不存在：{records_json_file}", file=sys.stderr)
        sys.exit(1)

    with open(records_json_file, encoding="utf-8") as f:
        payload = json.load(f)

    # 支持两种格式：直接的 records 数组，或 {"records": [...]} 对象
    if isinstance(payload, list):
        payload = {"records": payload}
    elif "records" not in payload:
        print("JSON 格式错误：需要 {\"records\": [...]} 或直接的数组", file=sys.stderr)
        sys.exit(1)

    total = len(payload["records"])
    print(f"准备上传 {total} 篇笔记到知发…\n")

    result = zhifa_post("/api/import/create-records", payload, timeout=300)

    # 统计结果
    if not isinstance(result, list):
        # 可能是 {"results": [...]} 结构
        result_list = result.get("results", []) if isinstance(result, dict) else []
    else:
        result_list = result

    success = [r for r in result_list if r.get("status") == "success"]
    skipped = [r for r in result_list if r.get("status") == "skipped"]
    failed = [r for r in result_list if r.get("status") == "failed"]

    print(f"上传结果：共 {len(result_list)} 篇笔记")
    print(f"  ✓ 成功 {len(success)} 篇")
    print(f"  - 跳过 {len(skipped)} 篇（已存在）")
    print(f"  ✗ 失败 {len(failed)} 篇")

    if failed:
        print("\n失败详情：")
        for r in failed:
            note_key = r.get("noteKey", "（未知）")
            reason = r.get("reason", "") or r.get("message", "未知原因")
            print(f"  {note_key}：{reason}")

    if skipped:
        print("\n跳过（指纹查重命中，已存在）：")
        for r in skipped:
            print(f"  {r.get('noteKey', '（未知）')}")


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

    args = parser.parse_args()

    if args.command == "scan":
        cmd_scan(args.folder)
    elif args.command == "create":
        cmd_create(args.records_json)


if __name__ == "__main__":
    main()
