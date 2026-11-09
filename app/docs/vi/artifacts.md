---
title: Quản lý artifact
description: Kiểm tra toàn vẹn, ghim file quan trọng và dọn dẹp theo chính sách lưu trữ
section: automation
order: 6
updated: 2026-11-01
tags: artifact, checksum, retention, cleanup
---

# Quản lý artifact

Artifact là file kết quả của một lần export, kèm manifest và checksum. Trang **Artifacts** là nơi
xem, kiểm tra và dọn dẹp chúng.

## Kiểm tra toàn vẹn

```bash
udmt artifact list
udmt artifact verify <artifact-id>
```

Verify tính lại SHA-256 của file và so với giá trị đã ghi lúc export. Nếu khác, run tương ứng bị đánh
dấu `failed` với mã lỗi checksum — đây là cách phát hiện file bị sửa hoặc hỏng.

## Ghim (pin)

File đã ghim **không bao giờ** bị xoá bởi retention. Dùng cho bản backup mốc, dữ liệu đối soát hoặc
file còn phải bàn giao. Bật/tắt bằng nút ghim trên giao diện.

## Dọn dẹp

```bash
udmt artifact prune --older-than-days 30 --keep-last 5 --dry-run
udmt artifact prune --older-than-days 30 --keep-last 5
```

Quy tắc an toàn khi prune:

- Luôn có `--dry-run` để xem trước file nào sẽ bị xoá.
- File đang ghim bị bỏ qua.
- File nằm ngoài storage root bị bỏ qua và ghi cảnh báo.
- Xoá kèm manifest tương ứng, không để lại file mồ côi.

## Cấu trúc một artifact

```
<storage-root>/<artifact-id>/<conn>-<resource>-<thời-gian>.jsonl.gz
<storage-root>/<artifact-id>/<file>.manifest.json
```

Manifest gồm: cột và kiểu, số dòng, checksum, provider, tham số run và cảnh báo. Nhờ manifest mà file
có thể được import ở nơi khác ngay cả khi catalog không còn.

## Kho lưu trữ từ xa (S3, R2, MinIO, B2)

Artifact có thể nằm trong kho tương thích S3 thay vì thư mục dữ liệu cục bộ. Thêm kho ở trang
**Storage** (hoặc bằng CLI):

```bash
udmt storage add --name r2-backups --type s3 --endpoint https://<account>.r2.cloudflarestorage.com \
  --bucket udmt-artifacts --prefix udmt --access-key-id <key> --secret-access-key-stdin
udmt storage test r2-backups
udmt storage default r2-backups
```

- Thông tin xác thực chỉ ghi một chiều: lưu trong vault mã hoá, không bao giờ vào catalog, nhật ký hay
  file export.
- Export vẫn ghi file tạm cục bộ trước, sau đó tải dữ liệu và manifest lên. Catalog ghi địa chỉ
  `s3://bucket/key`.
- Import tải object về thư mục tạm trước khi chạy luồng import streaming, rồi xoá file tạm.
- Không thể xoá kho khi kho còn artifact hoặc đang là kho mặc định.
