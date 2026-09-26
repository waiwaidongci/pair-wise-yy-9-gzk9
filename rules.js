// 数字化交付业务规则：校准与分辨率判定、工位占用、唯一性、交付与退回
export const MIN_RESOLUTION = 1200;
export const CALIBRATION_VALID_DAYS = 365;
export const STATUS = {
  SCANNING: "进行中",
  RESCAN: "待复扫",
  DELIVERED: "已交付",
  RETURNED: "已退回",
};

const DAY_MS = 24 * 60 * 60 * 1000;

export class RuleError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function isCalibrationExpired(calibrationDate, now = new Date()) {
  if (!calibrationDate) return true;
  const calibrated = new Date(`${calibrationDate}T00:00:00`);
  if (Number.isNaN(calibrated.getTime())) return true;
  return now.getTime() - calibrated.getTime() > CALIBRATION_VALID_DAYS * DAY_MS;
}

// 未完成 = 尚未交付（进行中 / 待复扫 / 已退回）
export function isOpen(scan) {
  return scan.status !== STATUS.DELIVERED;
}

// 只有进行中的扫描单占工位，待复扫与退回不占
export function holdsStation(scan) {
  return scan.status === STATUS.SCANNING;
}

export function evaluateStatus(scan, now = new Date()) {
  const problems = [];
  if (isCalibrationExpired(scan.calibrationDate, now)) problems.push("设备校准过期");
  if (!(Number(scan.resolution) >= MIN_RESOLUTION)) problems.push(`目标分辨率低于${MIN_RESOLUTION}`);
  return { status: problems.length ? STATUS.RESCAN : STATUS.SCANNING, problems };
}

const REQUIRED = [
  ["negativeCode", "底片编号"],
  ["device", "扫描设备"],
  ["station", "工位"],
  ["calibrationDate", "设备校准日期"],
  ["resolution", "目标分辨率"],
  ["scanner", "扫描人"],
];

function assertRegistration(input) {
  for (const [key, label] of REQUIRED) {
    if (input[key] === undefined || String(input[key]).trim() === "") {
      throw new RuleError("missing_field", `缺少必填项：${label}`);
    }
  }
  if (!(Number(input.resolution) > 0)) throw new RuleError("bad_resolution", "目标分辨率必须为正数");
}

// 同一底片只允许一张未完成单；同一工位只允许一张占工位的单
export function assertUnique(scans, candidate, excludeId = null) {
  for (const other of scans) {
    if (other.id === excludeId || !isOpen(other)) continue;
    if (other.negativeCode === candidate.negativeCode) {
      throw new RuleError("negative_busy", `底片 ${candidate.negativeCode} 已有一张未完成扫描单（${other.id}）`);
    }
  }
  if (candidate.status !== STATUS.SCANNING) return;
  for (const other of scans) {
    if (other.id === excludeId || !holdsStation(other)) continue;
    if (other.station === candidate.station) {
      throw new RuleError("station_busy", `工位 ${candidate.station} 已被扫描单 ${other.id} 占用`);
    }
  }
}

export function createScan(scans, input, id, now = new Date()) {
  assertRegistration(input);
  const scan = {
    id,
    negativeCode: String(input.negativeCode).trim(),
    device: String(input.device).trim(),
    station: String(input.station).trim(),
    calibrationDate: input.calibrationDate,
    resolution: Number(input.resolution),
    scanner: String(input.scanner).trim(),
    status: STATUS.SCANNING,
    fileCount: null,
    checksum: null,
    reviewer: null,
    createdAt: now.toISOString(),
    completedAt: null,
    history: [],
  };
  const { status, problems } = evaluateStatus(scan, now);
  scan.status = status;
  assertUnique(scans, scan);
  scan.history.push({
    at: now.toISOString(),
    step: "登记",
    note: problems.length ? `登记后留在待复扫：${problems.join("、")}，不占工位` : "登记成功，开始扫描",
  });
  return scan;
}

export function completeScan(scan, input, now = new Date()) {
  if (scan.status === STATUS.DELIVERED) throw new RuleError("already_delivered", "该扫描单已交付");
  if (scan.status === STATUS.RESCAN) throw new RuleError("in_rescan", "扫描单在待复扫中，请先处理校准或分辨率问题");
  const fileCount = Number(input.fileCount);
  const checksum = String(input.checksum || "").trim();
  const reviewer = String(input.reviewer || "").trim();
  if (!Number.isInteger(fileCount) || fileCount <= 0) throw new RuleError("bad_file_count", "文件数必须为正整数");
  if (!checksum) throw new RuleError("bad_checksum", "校验码不能为空");
  if (!reviewer) throw new RuleError("bad_reviewer", "复核人不能为空");
  if (reviewer === scan.scanner) {
    scan.status = STATUS.RETURNED;
    scan.history.push({ at: now.toISOString(), step: "退回", note: `复核人 ${reviewer} 与扫描人相同，交付被退回` });
    return { scan, returned: true };
  }
  scan.status = STATUS.DELIVERED;
  scan.fileCount = fileCount;
  scan.checksum = checksum;
  scan.reviewer = reviewer;
  scan.completedAt = now.toISOString();
  scan.history.push({ at: now.toISOString(), step: "交付", note: `交付 ${fileCount} 个文件，校验码 ${checksum}，复核人 ${reviewer}` });
  return { scan, returned: false };
}

export function editScan(scans, scan, patch, now = new Date()) {
  const next = { ...scan };
  for (const key of ["negativeCode", "device", "station", "calibrationDate", "scanner"]) {
    if (patch[key] !== undefined && String(patch[key]).trim() !== "") next[key] = String(patch[key]).trim();
  }
  if (patch.resolution !== undefined && Number(patch.resolution) > 0) next.resolution = Number(patch.resolution);
  const identityChanged = next.negativeCode !== scan.negativeCode || next.device !== scan.device;
  const invalidated = identityChanged && scan.status === STATUS.DELIVERED;
  if (invalidated) {
    next.fileCount = null;
    next.checksum = null;
    next.reviewer = null;
    next.completedAt = null;
  }
  if (next.status !== STATUS.DELIVERED || invalidated) {
    next.status = evaluateStatus(next, now).status;
  }
  assertUnique(scans, next, scan.id);
  Object.assign(scan, next);
  if (invalidated) {
    scan.history.push({ at: now.toISOString(), step: "交付失效", note: "底片编号或设备更换，原交付失效，需重新扫描" });
  }
  scan.history.push({ at: now.toISOString(), step: "修改", note: "更新扫描单信息" });
  return { scan, invalidated };
}
