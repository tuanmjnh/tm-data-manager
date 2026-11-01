---
title: Xử lý sự cố
description: Các lỗi thường gặp và cách khắc phục nhanh
section: operations
order: 8
updated: 2026-11-01
tags: lỗi, troubleshooting, port, sqlite
---

# Xử lý sự cố

## `unable to open database file` / `SQLite database file not found`

Đường dẫn của connection không còn đúng (file bị di chuyển hoặc xoá). Đường dẫn được resolve **một
lần** lúc lưu connection, nên `./data/x.db` là tương đối với thư mục làm việc tại thời điểm đó.

```bash
udmt connection show local          # xem config.path đã lưu
udmt connection update local --path ./data/fixtures/source.db
udmt connection test local
```

## `EADDRINUSE: address already in use 127.0.0.1:4004`

GUI đã chạy sẵn. `udmt gui` sẽ báo URL của instance đang chạy và thư mục dữ liệu nó dùng; dùng cửa sổ
đó, hoặc mở instance thứ hai bằng `--port 4005`.

## “Connection trên CLI khác với trên GUI”

Metadata nằm ở một thư mục dữ liệu duy nhất. Hai tiến trình dùng hai `--data-dir` khác nhau là hai cài
đặt độc lập. `udmt gui` in ra `Data:` để bạn đối chiếu.

## Artifact báo checksum sai

```bash
udmt artifact verify <artifact-id>
```

Nếu verify thất bại, file đã bị sửa/hỏng sau khi export. Export lại từ nguồn thay vì import file đó.

## `CONFIRMATION_REQUIRED`

Thao tác ghi phá huỷ (`truncate_and_load`) hoặc ghi vào connection `production` cần xác nhận tường
minh: `--confirm <connection-name>` trong CLI, hoặc gõ tên connection trong hộp thoại GUI.

## `VALIDATION_FAILED` khi import

Một số dòng sai kiểu so với schema đích. Xem danh sách cảnh báo theo cột trong kết quả run, sửa dữ
liệu nguồn hoặc chọn đúng kiểu cột đích.

## Run ở trạng thái `interrupted`

Worker bị dừng đột ngột. Run đó không hoàn tất; chạy lại job hoặc export lại. Lần khởi động worker kế
tiếp sẽ dọn trạng thái mồ côi.

## Kiểm tra tổng thể

```bash
udmt doctor     # phiên bản, đường dẫn, tính toàn vẹn DB, secret backend, worker
```

Trang **System** hiển thị cùng thông tin này kèm log gần nhất và capability của từng provider.

## Build desktop báo `cargo metadata ... program not found`

`cargo` không nằm trên `PATH` của tiến trình build (thường gặp khi chạy từ IDE hoặc task runner, vì
`~/.cargo/bin` chỉ được thêm bởi profile shell). `pnpm run desktop` hiện tự thêm đường dẫn này. Nếu vẫn
lỗi thì Rust chưa được cài: cài bằng [rustup.rs](https://rustup.rs), trên Windows thêm workload
**Desktop development with C++** của Visual Studio Build Tools rồi mở lại terminal.

## Có `udmt-desktop.exe` nhưng không thấy file setup

`pnpm run desktop` tạo cả hai. Bản chạy trực tiếp là `src-tauri/target/release/udmt-desktop.exe`, còn
installer nằm trong `src-tauri/target/release/bundle/`. Nếu chỉ có file `.exe`, bước đóng gói đã bị bỏ
qua — chạy lại đúng `pnpm run desktop` (đừng dùng `--skip-frontend` kèm `cargo build` thủ công).
