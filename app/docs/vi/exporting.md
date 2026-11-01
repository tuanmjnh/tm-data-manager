---
title: Xuất dữ liệu
description: Định dạng file, nén, giới hạn dòng và manifest đi kèm
section: data
order: 3
updated: 2026-11-01
tags: export, csv, jsonl, gzip
---

# Xuất dữ liệu

Export đọc dữ liệu theo luồng (streaming) nên kích thước bảng không bị nạp hết vào RAM, và mỗi lượt
chạy được ghi lại thành một **run** bền vững.

## Định dạng

| Định dạng | Mô tả | Phù hợp |
|---|---|---|
| `jsonl` | Mỗi dòng một JSON object | Chuyển đổi giữa các hệ, an toàn với dữ liệu lồng nhau |
| `json` | Một mảng JSON được ghi dần | Chia sẻ cho công cụ khác |
| `csv` | Header + dòng, có escape chuẩn | Mở bằng Excel/Sheets |

Thêm `gzip` để nén: `--compression gzip`.

## Trên giao diện

1. **Export** → chọn connection nguồn.
2. Chọn bảng (hoặc bấm **Discover** nếu danh sách trống).
3. Chọn định dạng, nén, và tuỳ chọn giới hạn số dòng.
4. **Run** và theo dõi ở panel tiến trình; xong sẽ có link sang artifact.

## Bằng CLI

```bash
udmt export --conn local-src --resource users --format jsonl --compression gzip
udmt export --conn local-src --resource users --format csv --limit 1000
udmt export --conn local-src --resource users --columns id,email
```

Kết quả in ra artifact id, số dòng, kích thước và SHA-256 đã kiểm tra.

## Manifest

Mỗi artifact có `<file>.manifest.json` đi kèm: danh sách cột, kiểu dữ liệu, số dòng, checksum,
provider và cảnh báo. Nhờ vậy file có thể import ở máy khác mà không cần catalog.

## Quy tắc an toàn

- Đường dẫn xuất phải nằm trong storage root; xuất ra thư mục ngoài được ghi nhận
  `output_mode: external` và log cảnh báo.
- Run có thể huỷ giữa chừng; trạng thái cuối là `cancelled`, artifact dở dang không được đánh dấu hoàn tất.
- Provider không hỗ trợ đọc sẽ trả `CAPABILITY_UNSUPPORTED` thay vì tạo file rỗng.
