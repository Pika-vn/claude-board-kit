# Claude Code Progress Board: bộ cài

Bảng tiến độ luôn hiện phía trên ô nhập lệnh của Claude Code (cả tab Code của desktop app lẫn `claude` ở terminal). Đây là **plan-progress-plus** (fork MIT của [plan-progress](https://github.com/zycck/claude-mods) của Kirill Serditov) đã được gộp thêm các phần của usage board:

- **Thanh task** theo giai đoạn và bước, dòng con cho từng subagent, âm thanh khi cần quyết định, khi lỗi và khi xong
- **Thanh Tasks tự động** từ danh sách việc của Claude (TaskCreate/TodoWrite)
- **Dòng git:** repo · nhánh · `+/−`
- **Context window** (nút **Compact** khi ≥ 85%), **giới hạn 5 giờ và tuần**, kèm tốc độ tiêu hao 🔥⚡🍃 và dự báo hết hạn mức
- **Hàng "This chat":** token vào/ra/cache, chi phí, thời gian, cache còn bao lâu, tok/s, công cụ vừa chạy, số skill
- **Nút báo lỗi** khi có công cụ lỗi trong lượt; bấm để xem lý do, hoặc gõ `/progress-errors`

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
   - **Từ file zip:** tải `claude-board-kit.zip` ở trang Release rồi giải nén.
2. Chạy lệnh tương ứng:

**Windows** (PowerShell):
```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

**macOS / Linux:**
```bash
bash install.sh
```

3. Thoát hẳn Claude desktop app (Windows: chuột phải biểu tượng ở khay hệ thống → Quit) rồi mở lại. Trong terminal thì mở một phiên `claude` mới.
4. Kiểm tra: gõ `/progress-demo`, một thanh mẫu sẽ hiện phía trên ô nhập lệnh.

Bộ cài sẽ:
- Cài Git và GitHub CLI nếu thiếu (winget trên Windows, Homebrew trên macOS; trên Mac sẽ nhắc cài Xcode Command Line Tools nếu chưa có). Bỏ qua bước này bằng `-SkipTools` / `--skip-tools`.
- Chép plugin vào `~/.claude/mods/plan-progress-plus` và script status line vào `~/.claude/`.
- Thêm `env.CLAUDE_CODE_PLUGIN_DIRS`, `env.CLAUDE_CODE_PLUGIN_DIR_WATCH` và `statusLine` vào `~/.claude/settings.json`; bỏ đường dẫn của usage board cũ và tắt plugin `plan-progress` gốc nếu có, để không bị hai bộ thanh. Các cài đặt khác giữ nguyên, file cũ được sao lưu thành `settings.json.bak-<thời gian>`.

Chạy lại bộ cài bất cứ lúc nào để cập nhật lên bản mới. Nếu cài từ GitHub thì chạy `git pull` trước, rồi chạy lại bộ cài.

## Lệnh trong Claude Code

| Lệnh | Tác dụng |
|---|---|
| `/progress` | Ẩn/hiện toàn bộ bảng (giống nút **Progress** ở chân ô nhập lệnh) |
| `/progress-usage` | Ẩn/hiện các dòng context, giới hạn và "This chat" |
| `/progress-demo` | Hiện một thanh task mẫu |
| `/progress-clear` | Xoá mọi thanh task |
| `/progress-errors` | Liệt kê các công cụ lỗi trong lượt và lý do |
| `/progress-sounds` | Phát thử ba âm thanh |

## Cấu trúc

| Đường dẫn | Nội dung |
|---|---|
| `plan-progress-plus/` | Plugin (hooks module của Claude Code), kèm `usage.test.tsx` chạy bằng `claude plugin test` |
| `statusline/statusline.ps1` | Status line cho Windows |
| `statusline/statusline.py` | Status line cho macOS / Linux (cần `python3`) |
| `install.ps1`, `install.sh` | Bộ cài |
