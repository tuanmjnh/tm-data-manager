---
title: Nhập dữ liệu
description: Chế độ ghi, khoá upsert, tạo bảng và xác nhận thao tác phá huỷ
section: data
order: 4
updated: 2026-11-01
tags: import, upsert, truncate, mapping
---

# Nhập dữ liệu

Import lấy dữ liệu từ một artifact hoặc file có sẵn và ghi vào bảng/collection đích. Dữ liệu được
validate theo schema đích trước khi ghi.

## Chế độ ghi

| Chế độ | Hành vi | Ghi chú |
|---|---|---|
| `append` | Thêm dòng mới | Mặc định, an toàn nhất |
| `upsert` | Cập nhật nếu trùng khoá, thêm nếu chưa có | Cần `--key-columns` |
| `truncate_and_load` | Xoá sạch bảng đích rồi ghi | Bắt buộc xác nhận |

```bash
udmt import --conn target --resource users --artifact <artifact-id> --mode append
udmt import --conn target --resource users --artifact <artifact-id> --mode upsert --key-columns id
udmt import --conn target --resource users --artifact <artifact-id> \
  --mode truncate_and_load --confirm target
```

## Trên giao diện

1. **Import** → chọn connection đích và bảng.
2. Chọn artifact (hoặc tải file CSV/JSON/JSONL lên).
3. Chọn chế độ; với `upsert` chọn cột khoá.
4. Nếu là `truncate_and_load` hoặc ghi vào connection `production`, hộp xác nhận yêu cầu gõ đúng tên
   connection.
5. **Run** → xem số dòng đọc/ghi/cảnh báo ở panel kết quả.

## Tạo bảng tự động

Nếu bật **Create table if missing**, UDMT tạo bảng theo schema của file nguồn (kiểu chuẩn hoá sang
kiểu của provider đích). Bảng đã tồn tại thì chỉ các cột khớp tên mới được ghi; cột thiếu sẽ hiện
trong danh sách cảnh báo thay vì bị bỏ qua âm thầm.

## Lỗi thường gặp

- **`NOT_FOUND`**: bảng đích không tồn tại và chưa bật tạo bảng.
- **`VALIDATION_FAILED`**: file có dòng sai kiểu — xem cảnh báo theo cột trong kết quả run.
- **`CONFIRMATION_REQUIRED`**: chạy lại với `--confirm <connection>` (CLI) hoặc xác nhận trong GUI.
- **Checksum sai**: artifact đã bị sửa; chạy `udmt artifact verify <id>` trước khi import lại.
