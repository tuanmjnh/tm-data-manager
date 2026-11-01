---
title: Cấu hình và dữ liệu lưu
description: Thư mục dữ liệu, biến môi trường, storage root và bảo vệ credential
section: operations
order: 7
updated: 2026-11-01
tags: cấu hình, env, secret, storage
---

# Cấu hình và dữ liệu lưu

Mọi thứ UDMT cần đều nằm trong một thư mục dữ liệu duy nhất.

## Thư mục mặc định

| Hệ điều hành | Đường dẫn |
|---|---|
| Windows | `%APPDATA%\udmt` |
| macOS | `~/Library/Application Support/udmt` |
| Linux | `~/.local/share/udmt` |

Cấu trúc bên trong:

```
udmt.db            metadata (SQLite): connections, runs, artifacts, schedules
artifacts/         file export theo từng artifact id
logs/              log của core và (nếu có) shell desktop
tmp/               file tạm trong lúc chạy
secrets.key        khoá chủ mã hoá credential (0600)
```

## Biến môi trường

| Biến | Tác dụng |
|---|---|
| `UDMT_DATA_DIR` | Đổi thư mục dữ liệu (dùng cho bản portable hoặc nhiều môi trường) |
| `UDMT_UI_DIR` | Chỉ định thư mục GUI tĩnh cho server local |
| `UDMT_ACCESS_LOG=1` | Ghi log mọi request HTTP vào log của core |
| `UDMT_LOG_DIR` | Đổi thư mục log |
| `UDMT_WEBVIEW_DATA_DIR` | Profile WebView2 của app desktop |

CLI còn có `--data-dir <path>`. Tất cả tham số mặc định của CLI nằm trong `udmt --help`.

## Secrets

Credential được mã hoá AES-256-GCM bằng khoá chủ trong `secrets.key`. Khoá này **không** dùng OS
keyring ở phiên bản hiện tại — hãy bảo vệ file đó theo tài khoản hệ điều hành, và sao lưu cả
`secrets.key` nếu bạn muốn chuyển máy.

- Không có mật khẩu nào xuất hiện dạng plaintext trong DB, log hay API.
- Log được lọc URI/mật khẩu/token trước khi ghi.
- Muốn rotate mật khẩu: `udmt connection update <name> --password-stdin`.

## Storage backend

Export mặc định ghi vào storage root trong thư mục dữ liệu. Có thể xem backend và đường dẫn hiện tại
ở trang **System**. Xuất ra ngoài root vẫn được nhưng bị đánh dấu `external` và ghi cảnh báo.
