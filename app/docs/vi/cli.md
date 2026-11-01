---
title: Tham chiếu CLI
description: Nhóm lệnh, cờ toàn cục, mã thoát và chế độ JSON
section: reference
order: 10
updated: 2026-11-01
tags: cli, reference, json, exit-code
---

# Tham chiếu CLI

Chạy qua `pnpm run udmt -- <lệnh>` hoặc trực tiếp `node dist/cli/bin.js <lệnh>`.

## Cờ toàn cục

| Cờ | Tác dụng |
|---|---|
| `--json` | In kết quả dạng JSON cho máy đọc |
| `--quiet` | Ẩn thanh tiến trình |
| `--verbose` | In log của run ra stderr |
| `--data-dir <path>` | Dùng thư mục dữ liệu khác |
| `--non-interactive` | Không bao giờ hỏi; lỗi nếu cần xác nhận |

## Nhóm lệnh

```bash
# Connection
udmt connection list | show <name> | test <name> | discover <name> | schema <name> <resource>
udmt connection add --name <name> --provider <id> ...
udmt connection update <name> [--path ...|--host ...|--password-stdin]
udmt connection remove <name>

# Export / Import
udmt export --conn <name> --resource <table> --format jsonl|csv|json [--compression gzip] [--limit N]
udmt import --conn <name> --resource <table> --artifact <id> --mode append|upsert|truncate_and_load

# Artifact
udmt artifact list | verify <id> | prune --older-than-days N --keep-last M [--dry-run]

# Operation
udmt operation list [--limit N] | show <run-id> | logs <run-id> | cancel <run-id>

# Worker / job
udmt job add-export --name <job> ... --schedule daily --hour 2 --timezone Asia/Ho_Chi_Minh
udmt worker run | once | status

# Khác
udmt provider list
udmt doctor
udmt gui [--port 4004]      # API + GUI tĩnh, cùng một tiến trình
udmt serve [--port 4004]    # chỉ API, dùng cho `pnpm run dev:gui`
```

## Mã thoát

| Mã | Ý nghĩa |
|---|---|
| `0` | Thành công |
| `2` | Tham số/đầu vào không hợp lệ |
| `3` | Lỗi kết nối/xác thực |
| `4` | Lỗi khi thực hiện thao tác |
| `5` | Đã huỷ |

## Ví dụ kết hợp

```bash
# Export rồi import sang Postgres, dừng ngay nếu lỗi
ARTIFACT=$(udmt export --conn local-src --resource users --format jsonl --json \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).artifact_id))")
udmt import --conn staging-pg --resource public.users --artifact "$ARTIFACT" --mode upsert --key-columns id
udmt operation list --limit 5
```

> Mọi lệnh đều trả lỗi có mã (`NOT_FOUND`, `AUTH_FAILED`, `CONFIRMATION_REQUIRED`…) để script có thể
> rẽ nhánh thay vì đọc chuỗi thông báo.
