---
title: Ứng dụng desktop
description: Cấu trúc bản cài, chỗ chạy bản chưa đóng gói và cách tự build
section: operations
order: 9
updated: 2026-11-01
tags: desktop, tauri, installer, offline
---

# Ứng dụng desktop

Bản desktop là Tauri v2 shell bọc quanh đúng core TypeScript của CLI — không có logic nghiệp vụ thứ
hai, và không cần cài Node lên máy đích.

## Cấu trúc bản cài

```
udmt-desktop.exe        shell Rust (~3 MB)
runtime/node.exe        Node 22 (không cần Node hệ thống)
runtime/udmt-core.cjs   core + CLI + API, một file bundle (~3.5 MB)
runtime/ui/             GUI tĩnh (SPA)
```

App cài theo từng user vào `%LOCALAPPDATA%\UDMT`, nên không cần quyền administrator.

Khi mở app:

1. Chọn cổng trống đầu tiên trong `4004..4019` (CLI đang chạy ở 4004 không ảnh hưởng).
2. Spawn core (không hiện cửa sổ console).
3. Chờ `/api/health` trả `"app":"udmt"` — tối đa 45 giây.
4. Mở cửa sổ trỏ tới `http://127.0.0.1:<port>/`.
5. Đóng cửa sổ cuối cùng → core bị dừng theo.

Không dùng IPC: GUI desktop, GUI trình duyệt và CLI dùng chung một API loopback, nên hành vi giống hệt
nhau ở mọi nơi.

## Tên và icon của bộ cài

File setup không còn là tên chung chung: tên sản phẩm, icon ứng dụng và icon installer đều khai báo
trong `src-tauri/tauri.conf.json` và `src-tauri/tauri.windows.conf.json`.

| Thành phần | Khai báo ở đâu |
|---|---|
| Tên sản phẩm (mục Start Menu, thư mục cài, Add/Remove Programs) | `productName` trong `src-tauri/tauri.conf.json` |
| Tên file setup (`UDMT_<version>_<arch>-setup.exe`) | Sinh từ `productName` + `version` + kiến trúc |
| Tiêu đề cửa sổ | `.title(...)` trong `open_main_window` (`src-tauri/src/lib.rs`) |
| Icon app (file `.exe`, shortcut, Add/Remove Programs) | `bundle.icon` → `icons/icon.ico` (6 kích thước 16–256) |
| Icon cửa sổ installer và uninstaller | `bundle.windows.nsis.installerIcon` / `uninstallerIcon` → `icons/icon.ico` |
| Nhóm Start Menu | `bundle.windows.nsis.startMenuFolder` (`UDMT`) |
| Nhà phát hành | `bundle.publisher` (`TM Data`) |

Đổi `productName` (ví dụ thành `UDMT Data Studio`) là tên file setup đổi theo, vì tên installer được
sinh từ `productName` lúc đóng gói. Nhớ sửa cả `open_main_window`, nếu không thanh tiêu đề vẫn hiện tên cũ.

Sau khi sửa `icons/source.svg`, tạo lại toàn bộ icon bằng:

```bash
pnpm exec tauri icon src-tauri/icons/source.svg
```

## Bản chưa đóng gói chạy ở đâu

`pnpm run desktop` không chỉ tạo installer — nó còn để lại một bản build chạy được ngay, và đó là bản
bạn dùng trong lúc phát triển:

| Đường dẫn | Là gì |
|---|---|
| `src-tauri/target/release/udmt-desktop.exe` | Binary của shell. Nhấp đúp là nó tự spawn core và mở cửa sổ. |
| `src-tauri/target/release/runtime/` | Payload shell tìm cạnh binary; phải nằm cùng chỗ. |
| `src-tauri/target/release/bundle/nsis/UDMT_0.1.0_x64-setup.exe` | Bộ cài. |

Shell tìm `runtime/` theo thứ tự: resource dir của Tauri → thư mục chứa file thực thi → thư mục làm
việc hiện tại. Vì vậy `target/release/udmt-desktop.exe` chạy được tại chỗ — copy riêng file `.exe` mà
bỏ thư mục `runtime/` thì không chạy được. Biến `UDMT_RUNTIME_DIR` sẽ ghi đè toàn bộ thứ tự này, tiện
khi muốn thử một payload ở thư mục khác.

Nếu bạn muốn xem giao diện trên trình duyệt thay vì shell: chạy `pnpm run build && pnpm run build:gui`
rồi `pnpm run dev` để phục vụ cùng GUI đó ở `http://127.0.0.1:4004`, không cần Rust. Riêng
`pnpm run build` / `build:gui` chỉ ghi ra `dist/` và `app/.output/public`, chưa khởi động gì cả — phải có
`udmt gui` mới chạy.

## Vị trí log

- `desktop-shell.log` — quá trình khởi động của shell.
- `desktop-core.log` — stdout/stderr của core, gồm cả lỗi DB hoặc lỗi port.

Cả hai nằm trong thư mục `logs/` của data dir (`%APPDATA%\udmt\logs` trên Windows). Nếu thư mục đó
không ghi được, shell tự chuyển sang `%LOCALAPPDATA%` rồi `%TEMP%`.

## Tự build

```bash
pnpm install
pnpm run desktop          # tsc + Nuxt generate + runtime bundle + tauri build
```

| Hệ điều hành | Sản phẩm |
|---|---|
| Windows | `bundle/nsis/UDMT_<version>_x64-setup.exe` |
| Linux | `bundle/deb/*.deb`, `bundle/appimage/*.AppImage` |
| macOS | `bundle/macos/UDMT.app`, `bundle/dmg/*.dmg` |

Phải build trên chính hệ điều hành đích: runtime Node được copy từ máy build, script sẽ từ chối
cross-build để tránh tạo installer hỏng.

### Lỗi `os error 32` khi build lại

Mỗi lần build, Tauri copy `runtime/` vào `target/release/`. Nếu vẫn còn app đang chạy từ thư mục đó —
kể cả tiến trình `runtime/node.exe` mồ côi do cửa sổ bị kill — Windows sẽ từ chối ghi đè và build dừng:

```
error: failed to run custom build command for `udmt-desktop`
  The process cannot access the file because it is being used by another process. (os error 32)
```

Đóng cửa sổ desktop, dừng nốt tiến trình `node.exe` còn sót có command line trỏ tới
`runtime\udmt-core.cjs`, rồi chạy lại `pnpm run desktop`. Không cần đổi tên thư mục
`src-tauri/target/release`.

> Installer hiện chưa ký số, nên Windows SmartScreen sẽ cảnh báo ở lần chạy đầu. macOS có thể cần
> chuột phải → Open để bỏ qua Gatekeeper.
