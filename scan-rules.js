// 数字化交付业务规则：待复扫判定、底片/工位唯一性、交付退回与交付失效。
// 只做判断和状态变更，不碰文件系统；记录保存见 scan-store.js，页面见 scan-page.js。

export const MIN_RESOLUTION = 1200;
export const STATUS_SCANNING = "扫描中";
export const STATUS_RESCAN = "待复扫";
export const STATUS_DELIVERED = "已交付";
export const STATUS_INVALID = "已失效";
export const SCAN_STATUSES = [STATUS_SCANNING, STATUS_RESCAN, STATUS_DELIVERED, STATUS_INVALID];

export class RuleError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.status = status;
  }
}

export function todayString(now = new Date()) {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

// 设备校准过期或目标分辨率低于 1200：留在待复扫
export function rescanReasons(order, today = todayString()) {
  const reasons = [];
  if (!order.calibrationDate || order.calibrationDate < today) reasons.push("设备校准过期");
  if (!(Number(order.resolution) >= MIN_RESOLUTION)) reasons.push("目标分辨率低于" + MIN_RESOLUTION);
  return reasons;
}

// 已交付、已失效是终态；未完成单按校准日期和分辨率实时判定
export function effectiveStatus(order, today = todayString()) {
  if (order.status === STATUS_DELIVERED || order.status === STATUS_INVALID) return order.status;
  return rescanReasons(order, today).length ? STATUS_RESCAN : STATUS_SCANNING;
}

export function isUnfinished(order, today = todayString()) {
  const status = effectiveStatus(order, today);
  return status === STATUS_SCANNING || status === STATUS_RESCAN;
}

// 只有扫描中的单子占工位，待复扫不占工位
export function occupiesWorkstation(order, today = todayString()) {
  return effectiveStatus(order, today) === STATUS_SCANNING;
}

export function decorateOrder(order, today = todayString()) {
  const status = effectiveStatus(order, today);
  return {
    ...order,
    status,
    rescanReasons: status === STATUS_RESCAN ? rescanReasons(order, today) : [],
    logCount: (order.logs || []).length,
  };
}

const FIELD_LABELS = { filmCode: "底片编号", device: "设备（工位）", calibrationDate: "校准日期", resolution: "目标分辨率", scanner: "扫描人" };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function pickFields(source) {
  return {
    filmCode: String(source.filmCode ?? "").trim(),
    device: String(source.device ?? "").trim(),
    calibrationDate: String(source.calibrationDate ?? "").trim(),
    resolution: Number(source.resolution),
    scanner: String(source.scanner ?? "").trim(),
  };
}

function validateFields(fields) {
  if (!fields.filmCode) throw new RuleError("底片编号不能为空", 400);
  if (!fields.device) throw new RuleError("设备（工位）不能为空", 400);
  if (!DATE_RE.test(fields.calibrationDate)) throw new RuleError("校准日期格式应为 YYYY-MM-DD", 400);
  if (!Number.isInteger(fields.resolution) || fields.resolution <= 0) throw new RuleError("目标分辨率应为正整数", 400);
  if (!fields.scanner) throw new RuleError("扫描人不能为空", 400);
}

function pushLog(order, step, note) {
  order.logs ||= [];
  order.logs.push({ at: new Date().toISOString(), step, note });
}

// 同一底片只能有一张未完成单（待复扫也算未完成）
function assertFilmFree(orders, filmCode, selfId, today) {
  const clash = orders.find(o => o.id !== selfId && o.filmCode === filmCode && isUnfinished(o, today));
  if (clash) throw new RuleError(`底片 ${filmCode} 已有未完成扫描单 ${clash.id}`);
}

// 同一工位（设备）只能有一张占工位的未完成单，待复扫不占工位
function assertWorkstationFree(orders, device, selfId, today) {
  const clash = orders.find(o => o.id !== selfId && o.device === device && occupiesWorkstation(o, today));
  if (clash) throw new RuleError(`工位 ${device} 已被扫描单 ${clash.id} 占用`);
}

export function registerOrder(input, orders, today = todayString()) {
  const fields = pickFields(input);
  validateFields(fields);
  assertFilmFree(orders, fields.filmCode, null, today);
  const reasons = rescanReasons(fields, today);
  const status = reasons.length ? STATUS_RESCAN : STATUS_SCANNING;
  if (status === STATUS_SCANNING) assertWorkstationFree(orders, fields.device, null, today);
  const order = { id: "SC-" + Date.now(), ...fields, status, createdAt: new Date().toISOString(), logs: [] };
  pushLog(order, "登记", reasons.length ? `登记扫描单：${reasons.join("、")}，留在待复扫` : "登记扫描单，进入扫描中");
  return order;
}

export function updateOrder(order, input, orders, today = todayString()) {
  if (effectiveStatus(order, today) === STATUS_INVALID) throw new RuleError("扫描单已失效，不能修改，请重新登记");
  const next = {};
  const changed = [];
  for (const key of Object.keys(FIELD_LABELS)) {
    if (input[key] === undefined) continue;
    next[key] = key === "resolution" ? Number(input[key]) : String(input[key]).trim();
    if (String(next[key]) !== String(order[key] ?? "")) changed.push(key);
  }
  if (!changed.length) return { changed, invalidated: false };
  validateFields(pickFields({ ...order, ...next }));
  const names = changed.map(key => FIELD_LABELS[key]).join("、");
  if (effectiveStatus(order, today) === STATUS_DELIVERED) {
    Object.assign(order, next);
    // 底片编号或设备更换后，原交付失效
    const deliveryVoid = changed.filter(key => key === "filmCode" || key === "device");
    if (deliveryVoid.length) {
      order.status = STATUS_INVALID;
      order.invalidatedAt = new Date().toISOString();
      pushLog(order, "失效", `更换${deliveryVoid.map(key => FIELD_LABELS[key]).join("、")}，原交付失效`);
      return { changed, invalidated: true };
    }
    pushLog(order, "更正", `更新${names}`);
    return { changed, invalidated: false };
  }
  const merged = { ...order, ...next };
  assertFilmFree(orders, merged.filmCode, order.id, today);
  const reasons = rescanReasons(merged, today);
  const status = reasons.length ? STATUS_RESCAN : STATUS_SCANNING;
  if (status === STATUS_SCANNING) assertWorkstationFree(orders, merged.device, order.id, today);
  Object.assign(order, next);
  order.status = status;
  pushLog(order, "更正", `更新${names}` + (reasons.length ? `：${reasons.join("、")}，留在待复扫` : "，进入扫描中"));
  return { changed, invalidated: false };
}

export function completeOrder(order, input, today = todayString()) {
  const status = effectiveStatus(order, today);
  if (status === STATUS_DELIVERED) throw new RuleError("扫描单已交付，不能重复交付");
  if (status === STATUS_INVALID) throw new RuleError("扫描单已失效，不能交付");
  if (status === STATUS_RESCAN) throw new RuleError("扫描单在待复扫中，请先更新校准日期或目标分辨率");
  const fileCount = Number(input.fileCount);
  const checksum = String(input.checksum ?? "").trim();
  const reviewer = String(input.reviewer ?? "").trim();
  if (!Number.isInteger(fileCount) || fileCount <= 0) throw new RuleError("文件数应为正整数", 400);
  if (!checksum) throw new RuleError("校验码不能为空", 400);
  if (!reviewer) throw new RuleError("复核人不能为空", 400);
  // 复核人与扫描人相同：交付退回，单子保持未完成
  if (reviewer === order.scanner) {
    pushLog(order, "退回", `复核人 ${reviewer} 与扫描人相同，交付退回`);
    return "returned";
  }
  order.fileCount = fileCount;
  order.checksum = checksum;
  order.reviewer = reviewer;
  order.completedAt = new Date().toISOString();
  order.status = STATUS_DELIVERED;
  pushLog(order, "交付", `交付 ${fileCount} 个文件，校验码 ${checksum}，复核人 ${reviewer}`);
  return "delivered";
}
