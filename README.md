# Claude Code Usage Board: bộ cài

Bảng tiến độ luôn hiện phía trên ô nhập lệnh của Claude Code (cả tab Code của desktop app lẫn `claude` ở terminal):

- Repo · nhánh · `+/−` · nút **Create PR**
- Nhóm việc theo phase (`✓ Done x/y`, phase đang chạy màu tím) và dòng con cho từng subagent (công cụ đang dùng, thời gian chạy)
- Context window (nút **Compact** khi ≥ 85%), giới hạn 5 giờ và tuần, kèm tốc độ tiêu hao 🔥⚡🍃 và dự báo hết hạn mức
- Màu theo phần còn lại: xanh → vàng → đỏ
- Hàng chip: cache, công cụ vừa chạy, agents, skills, tok/s, lỗi

Kèm thêm một **status line** (dòng trạng thái của `claude` trong terminal).

## Cài trên máy mới

1. Lấy bộ cài về máy mới, chọn một trong hai cách:
   - **Từ GitHub** (repo riêng tư; cần GitHub CLI và `gh auth login` trước):
     ```powershell
     winget install --id GitHub.cli -e
     gh auth login --web --git-protocol https
     gh repo clone Pika-vn/claude-board-kit
     cd claude-board-kit
     ```
   - **Từ file zip:** chép `claude-board-kit.zip` sang máy mới rồi giải nén.
2. Chạy lệnh tương ứng:

**Windows** (PowerShell):
```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

**macOS / Linux:**
```bash
bash install.sh
```

3. Đăng nhập GitHub một lần (cho nút Create PR): `gh auth login`
4. Mở một phiên Claude Code mới.

Bộ cài sẽ:
- Cài Git và GitHub CLI nếu thiếu (winget trên Windows, Homebrew trên macOS). Bỏ qua bước này bằng `-SkipTools` / `--skip-tools`.
- Chép mod vào `~/.claude/mods/usage-board` và script status line vào `~/.claude/`.
- Thêm `env.CLAUDE_CODE_PLUGIN_DIRS`, `env.CLAUDE_CODE_PLUGIN_DIR_WATCH` và `statusLine` vào `~/.claude/settings.json`. Các cài đặt khác giữ nguyên, file cũ được sao lưu thành `settings.json.bak-<thời gian>`.

Chạy lại bộ cài bất cứ lúc nào để cập nhật lên bản mới. Nếu cài từ GitHub thì chạy `git pull` trước, rồi chạy lại bộ cài.

## Cấu trúc

| Đường dẫn | Nội dung |
|---|---|
| `usage-board/` | Mod (hooks module của Claude Code) |
| `statusline/statusline.ps1` | Status line cho Windows |
| `statusline/statusline.py` | Status line cho macOS / Linux (cần `python3`) |
| `install.ps1`, `install.sh` | Bộ cài |

## Lệnh trong Claude Code

- `/board`: làm mới bảng (git, hạn mức).
