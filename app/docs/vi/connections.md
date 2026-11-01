---
title: Kết nối dữ liệu
description: Thêm, kiểm tra và quản lý connection cho SQLite, PostgreSQL, MySQL và MongoDB
section: data
order: 2
updated: 2026-11-01
tags: connection, sqlite, postgresql, mysql, mongodb
---

# Kết nối dữ liệu

Mỗi nguồn dữ liệu là một **connection** gồm provider, cấu hình và (nếu cần) credential được mã hoá.

## Provider được hỗ trợ

| Provider | Đọc | Ghi | Schema | Ghi chú |
|---|---|---|---|---|
| `sqlite` | ✓ | ✓ | ✓ | File `.db`, dùng `node:sqlite` |
| `postgresql` | ✓ | ✓ | ✓ | Streaming qua `pg-cursor`; profile `supabase`, `neon` |
| `mysql` | ✓ | ✓ | ✓ | MySQL & MariaDB; profile `planetscale` |
| `mongodb` | ✓ | ✓ | mẫu | Atlas hoặc self-hosted; schema suy ra từ document mẫu |

Khả năng thực tế do provider khai báo và engine kiểm tra — giao diện chỉ hiện hành động mà provider
làm được, nên không có nút bấm rồi báo lỗi.

## Thêm connection

**Trên giao diện:** **Connections → Add connection**, chọn provider rồi điền form sinh ra từ
`config_fields` của provider.

**Bằng CLI:**

```bash
udmt connection add --name local-src --provider sqlite --path ./data/fixtures/source.db
udmt connection add --name staging-pg --provider postgresql \
  --host db.example.com --database app --user app --password-stdin
```

Mật khẩu có thể nhập qua `--password-stdin` hoặc nằm sẵn trong URI; UDMT tách mật khẩu ra khỏi
config và mã hoá bằng AES-256-GCM trong vault trước khi lưu.

### Giá trị mặc định cho môi trường local

Form đã điền sẵn cấu hình chạy trên máy này, nên chỉ cần bấm **Create connection**:

| Provider | Giá trị mặc định |
|---|---|
| `sqlite` | Không có — trỏ tới file `.db` của bạn |
| `postgresql` | `localhost:5432`, database `postgres`, user `postgres`, TLS `disable` |
| `mysql` | `localhost:3306`, user `root`, TLS `disable` |
| `mongodb` | `mongodb://localhost:27017` |

Chọn **Environment** khác `local` sẽ bật lại TLS `require` nếu bạn chưa đổi tay, và bạn cần sửa
host/user sang server thật. Mật khẩu không được điền sẵn — nhập ở ô Password để lưu vào vault.

## Kiểm tra và khám phá

```bash
udmt connection test local-src        # kết nối + quick_check
udmt connection discover local-src    # liệt kê bảng/view
udmt connection schema local-src users
```

Trên giao diện, các nút **Test**, **Discover**, **Schema** nằm ngay trong bảng connection.

## Sửa và các lỗi thường gặp

- Đổi tên, môi trường, config, mật khẩu hoặc bật/tắt: nút bút chì trong danh sách, hoặc
  `udmt connection update <name> --path ...`.
- Đường dẫn SQLite được resolve **một lần** lúc lưu. Nếu file bị di chuyển, chạy
  `udmt connection update <name> --path <đường-dẫn-mới>`.
- Đặt connection production: thao tác ghi phá huỷ sẽ yêu cầu gõ lại tên connection để xác nhận.

> Credential không bao giờ hiện lại trong log hay giao diện; ô mật khẩu để trống khi sửa nghĩa là
> “giữ nguyên mật khẩu cũ”.
