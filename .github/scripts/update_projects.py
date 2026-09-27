#!/usr/bin/env python3
"""扫描 GitHub 用户的新公开仓库，并把未收录的项目追加到 README.md 的「开源项目」章节。

输出（写入 $GITHUB_OUTPUT）：
    changed  是否修改了 README（true / false）
    count    本次新增的项目数量
"""

import json
import os
import re
import sys
import urllib.error
import urllib.request

OWNER = os.environ.get("OWNER", "sdise")
README_PATH = os.environ.get("README_PATH", "README.md")
SECTION_TITLE = os.environ.get("SECTION_TITLE", "## 开源项目")
# 不希望出现在 README 里的仓库（逗号分隔）
EXTRA_EXCLUDE = os.environ.get("EXCLUDE_REPOS", "")
# 是否忽略 fork 出来的仓库
INCLUDE_FORKS = os.environ.get("INCLUDE_FORKS", "false").lower() == "true"

SELF_REPO = f"{OWNER.lower()}.github.io"
MAX_DESC = 160


def api_get(path: str):
    url = f"https://api.github.com{path}"
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": f"{OWNER}-readme-updater",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def fetch_repos():
    """按创建时间升序返回全部公开仓库。"""
    repos = []
    page = 1
    while True:
        try:
            batch = api_get(
                f"/users/{OWNER}/repos?per_page=100&page={page}&sort=created&direction=asc"
            )
        except urllib.error.HTTPError as exc:  # noqa: PERF203
            print(f"::error::请求 GitHub API 失败: {exc}")
            sys.exit(1)
        if not batch:
            break
        repos.extend(batch)
        if len(batch) < 100:
            break
        page += 1
    return repos


def clean_text(text: str) -> str:
    text = " ".join((text or "").split())
    text = text.replace("[", "(").replace("]", ")")
    if len(text) > MAX_DESC:
        text = text[: MAX_DESC - 1].rstrip() + "…"
    return text


def build_entry(repo: dict) -> str:
    name = repo["name"]
    desc = clean_text(repo.get("description")) or "暂无描述"
    return f"- **{name}** — {desc}\n  <{repo['html_url']}>"


def is_listed(readme: str, repo: dict) -> bool:
    """README 里是否已经收录了这个仓库（按仓库名或仓库链接匹配）。"""
    name = re.escape(repo["name"])
    url = re.escape(repo["html_url"])
    patterns = [
        rf"\*\*{name}\*\*",
        rf"github\.com/{re.escape(OWNER)}/{name}\b",
        rf"{url}",
    ]
    return any(re.search(p, readme, flags=re.IGNORECASE) for p in patterns)


def insert_entries(readme: str, entries: list) -> str:
    """把新条目插入到「开源项目」章节末尾，保持原有格式与空行。"""
    lines = readme.splitlines()
    try:
        start = next(i for i, line in enumerate(lines) if line.strip() == SECTION_TITLE)
    except StopIteration:
        print(f"::error::README.md 中找不到章节：{SECTION_TITLE}")
        sys.exit(1)

    end = len(lines)
    for i in range(start + 1, len(lines)):
        if lines[i].startswith("## "):
            end = i
            break

    # 去掉章节末尾多余的空行，再统一补一个空行分隔
    while end > start + 1 and lines[end - 1].strip() == "":
        end -= 1

    block = "\n".join(entries)
    # lines[end:] 开头保留着章节之间的分隔空行，因此这里只需补前导空行
    new_lines = lines[:end] + ["", block] + lines[end:]
    return "\n".join(new_lines) + ("\n" if readme.endswith("\n") else "")


def set_output(key: str, value: str) -> None:
    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        with open(output, "a", encoding="utf-8") as fh:
            fh.write(f"{key}={value}\n")
    print(f"{key}={value}")


def main() -> None:
    excluded = {SELF_REPO}
    excluded.update(r.strip().lower() for r in EXTRA_EXCLUDE.split(",") if r.strip())

    repos = fetch_repos()
    print(f"共获取到 {len(repos)} 个公开仓库")

    with open(README_PATH, encoding="utf-8") as fh:
        readme = fh.read()

    candidates = []
    for repo in repos:
        if repo["name"].lower() in excluded:
            continue
        if repo.get("fork") and not INCLUDE_FORKS:
            continue
        if is_listed(readme, repo):
            continue
        candidates.append(repo)

    if not candidates:
        print("没有发现新仓库，README 保持不变")
        set_output("changed", "false")
        set_output("count", "0")
        return

    entries = [build_entry(repo) for repo in candidates]
    updated = insert_entries(readme, entries)

    with open(README_PATH, "w", encoding="utf-8") as fh:
        fh.write(updated)

    print("新增项目：")
    for entry in entries:
        print(entry)
    set_output("changed", "true")
    set_output("count", str(len(entries)))


if __name__ == "__main__":
    main()
