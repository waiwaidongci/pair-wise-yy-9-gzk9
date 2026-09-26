// 扫描单记录保存：JSON 文件读写与初始样例。业务规则见 scan-rules.js。
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "scan-orders.json");

const seed = {
  "orders": [
    {
      "id": "SC-001",
      "filmCode": "CN-001",
      "device": "扫描仪A-01",
      "calibrationDate": "2027-01-15",
      "resolution": 2400,
      "scanner": "林岚",
      "status": "扫描中",
      "createdAt": "2026-09-20T09:00:00.000Z",
      "logs": [
        { "at": "2026-09-20T09:00:00.000Z", "step": "登记", "note": "登记扫描单，进入扫描中" }
      ]
    },
    {
      "id": "SC-002",
      "filmCode": "CN-002",
      "device": "扫描仪B-02",
      "calibrationDate": "2026-06-30",
      "resolution": 800,
      "scanner": "赵启",
      "status": "待复扫",
      "createdAt": "2026-09-21T08:30:00.000Z",
      "logs": [
        { "at": "2026-09-21T08:30:00.000Z", "step": "登记", "note": "登记扫描单：设备校准过期、目标分辨率低于1200，留在待复扫" }
      ]
    },
    {
      "id": "SC-003",
      "filmCode": "CN-003",
      "device": "扫描仪A-01",
      "calibrationDate": "2026-11-30",
      "resolution": 1600,
      "scanner": "林岚",
      "status": "已交付",
      "fileCount": 36,
      "checksum": "SHA256-9F2C71",
      "reviewer": "沈禾",
      "createdAt": "2026-09-19T10:00:00.000Z",
      "completedAt": "2026-09-21T02:40:00.000Z",
      "logs": [
        { "at": "2026-09-19T10:00:00.000Z", "step": "登记", "note": "登记扫描单，进入扫描中" },
        { "at": "2026-09-21T02:40:00.000Z", "step": "交付", "note": "交付 36 个文件，校验码 SHA256-9F2C71，复核人 沈禾" }
      ]
    }
  ]
};

export async function loadScanOrders() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await saveScanOrders(seed.orders);
    return JSON.parse(JSON.stringify(seed.orders));
  }
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  return db.orders || [];
}

export async function saveScanOrders(orders) {
  await writeFile(dbPath, JSON.stringify({ orders }, null, 2));
}
