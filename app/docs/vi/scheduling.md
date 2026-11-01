---
title: Lên lịch tự động
description: Worker chạy nền, các kiểu lịch, timezone và chính sách chạy trùng
section: automation
order: 5
updated: 2026-11-01
tags: schedule, worker, cron, timezone
---

# Lên lịch tự động

Worker là tiến trình headless, chạy độc lập với GUI, chịu trách nhiệm kích hoạt các job theo lịch.

## Tạo lịch

```bash
udmt job add-export --name nightly-users --conn local-src --resource users \
  --format jsonl --compression gzip --schedule daily --hour 2 --timezone Asia/Ho_Chi_Minh

udmt worker run      # chạy nền liên tục
udmt worker once     # một lượt quét, phù hợp cron/Task Scheduler
udmt worker status
```

Trên giao diện, tab **Schedules** cho phép tạo, bật/tắt và xem lần chạy kế tiếp.

## Kiểu lịch

| Kiểu | Tham số | Ví dụ |
|---|---|---|
| `once` | `--at <ISO time>` | Chạy một lần |
| `interval` | `--every-minutes <n>` | Mỗi 30 phút |
| `daily` | `--hour`, `--minute` | 02:00 mỗi ngày |
| `weekly` | `--weekday` + giờ | Thứ 2 hằng tuần |
| `monthly` | `--day-of-month` + giờ | Ngày 1 hằng tháng |

## Timezone và DST

Mọi lịch dùng IANA timezone (ví dụ `Asia/Ho_Chi_Minh`). Khi chuyển giờ mùa hè, thời điểm chạy được
tính lại theo wall-clock địa phương, không bị lệch một giờ.

## Chính sách

- **Misfire**: lần chạy bị lỡ (máy tắt) xử lý theo `skip` (mặc định) hoặc `run_once_on_recovery`.
- **Overlap**: `forbid` là mặc định — lần chạy mới bị bỏ qua nếu lần trước còn đang chạy.
- **Khoá**: worker giữ lock trong DB, nên chạy hai worker không sinh ra hai lần thực thi.
- **Recovery**: run mồ côi do worker chết được đánh dấu `interrupted` ở lần khởi động kế tiếp.

> Worker không cần GUI mở. Chỉ cần một tiến trình `udmt worker run` (hoặc `worker once` theo lịch hệ
> điều hành) là lịch vẫn chạy.
