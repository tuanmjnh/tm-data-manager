---
title: Bắt đầu nhanh
description: Cài đặt, chạy GUI và thực hiện lần export đầu tiên
section: gettingStarted
order: 1
updated: 2026-11-01
tags: cài đặt, pnpm, bắt đầu
---

# Bắt đầu nhanh

UDMT là công cụ quản trị dữ liệu chạy hoàn toàn trên máy bạn: xuất, nhập và lên lịch dữ liệu giữa
SQLite, PostgreSQL, MySQL/MariaDB và MongoDB, không cần `mongodump`/`pg_dump`.

## Yêu cầu

- **Node.js ≥ 22.5** — dùng `node:sqlite` có sẵn, không cần biên dịch native module.
- **pnpm ≥ 12** — dự án là pnpm workspace (`.`, và gói GUI `app`). `corepack enable` sẽ tự dùng đúng
  phiên bản `packageManager` đã ghim; không có bước `npm install`.
- Tuỳ chọn: Rust toolchain nếu bạn muốn tự build app desktop.

## Cài đặt và chạy

```bash
pnpm install
pnpm run dev          # mở GUI tại http://127.0.0.1:4004
```

`pnpm run dev` đúng là lệnh mở web: nó gọi `udmt gui`, khởi động API loopback và phục vụ bản SPA đã
build trên cùng origin, rồi in ra URL. Lệnh này **không tự mở tab trình duyệt** — bạn mở URL ở dòng
`GUI:` mà nó in ra, và giữ terminal chạy (đóng terminal hoặc `Ctrl+C` là server dừng).
**Nó chỉ phục vụ bản build có sẵn** — không biên dịch lại TypeScript hay GUI, nên sau khi sửa code hãy dùng:

```bash
pnpm run gui          # build (core + CLI) → build:gui (SPA tĩnh) → phục vụ ở :4004
```

| Lệnh | Việc nó làm | Dùng khi nào |
|---|---|---|
| `pnpm run dev` | `udmt gui` — phục vụ bản build hiện tại ở `http://127.0.0.1:4004` | Dùng hàng ngày, không sửa code |
| `pnpm run gui` | Build cả hai phần rồi phục vụ ở `:4004` | Sau khi sửa file `.ts` hoặc `.vue` |
| `pnpm run dev:gui` | Nuxt dev server có hot reload ở `:4320`, `/api` proxy sang `:4004` | Làm giao diện cần thấy thay đổi ngay |
| `pnpm run desktop` | Build bản desktop đầy đủ: hai phần code, runtime payload và bộ cài | Khi cần tạo installer |

Muốn hot reload thì giữ `pnpm run dev` (hoặc `pnpm run udmt -- serve`) ở một terminal và chạy
`pnpm run dev:gui` ở terminal khác: Nuxt dev server cổng 4320 sẽ proxy `/api` sang 4004.

Nếu trình duyệt báo `GUI build not found` nghĩa là SPA chưa từng được generate — chạy `pnpm run build:gui`
một lần (hoặc dùng luôn `pnpm run gui`). `pnpm run dev` ngay sau `git clone` cũng báo lỗi này cho tới khi
có bản build.

`pnpm run build` và `pnpm run build:gui` chỉ ghi file, không hề khởi động server. Muốn có app cài được
thì dùng `pnpm run desktop` — xem [Ứng dụng desktop](/docs/desktop-app).

`pnpm run fixtures` tạo `data/fixtures/source.db` với 2.500 dòng mẫu để thử nghiệm.

## Lần export đầu tiên

1. Mở **Connections** → **Add connection** → chọn `SQLite`, trỏ tới file `.db` có thật.
2. Bấm **Test** để kiểm tra, rồi **Discover** để xem danh sách bảng.
3. Sang **Export**, chọn connection và bảng, chọn định dạng `jsonl`, bật gzip.
4. Bấm **Run** — tiến trình chạy nền, xem log ở trang **Operations**.
5. File kết quả nằm trong **Artifacts** kèm SHA-256 để kiểm tra toàn vẹn.

> GUI và CLI dùng chung một loopback API, nên mọi thao tác trên giao diện đều có lệnh CLI tương ứng.

## Cổng và dữ liệu

- GUI mặc định ở `http://127.0.0.1:4004`; đổi bằng `--port 4005`.
- Metadata, artifact và log nằm trong `%APPDATA%\udmt` (Windows), `~/Library/Application Support/udmt`
  (macOS), `~/.local/share/udmt` (Linux). Ghi đè bằng `UDMT_DATA_DIR` hoặc `--data-dir`.
