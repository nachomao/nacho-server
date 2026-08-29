import { z } from "zod"

const printable = (maximum: number) => z.string().min(1).max(maximum).refine(
  (value) => ![...value].some((character) => {
    const code = character.codePointAt(0) ?? 0
    return code === 0 || (code < 32 && character !== "\r" && character !== "\n" && character !== "\t")
  }),
  "contains unsupported control characters",
)

export const runShellPayloadSchema = z.object({
  shell: z.enum(["cmd", "powershell"]),
  script: printable(32_768).refine((value) => value.trim().length > 0, "script must not be blank"),
  timeoutSeconds: z.number().int().min(1).max(900),
}).strict()

const runProgramPayloadSchema = z.object({
  program: z.string().min(1),
  args: z.string().optional(),
  timeoutSeconds: z.number().int().min(1).max(900).optional(),
}).strict()

const serviceName = z.string().trim().min(1).max(256)
const serviceTimeout = z.number().int().min(1).max(120).optional()
const serviceListPayloadSchema = z.object({ action: z.literal("list") }).strict()
const serviceQueryPayloadSchema = z.object({ serviceName, action: z.literal("query"), timeoutSeconds: serviceTimeout }).strict()
const serviceStartPayloadSchema = z.object({ serviceName, action: z.literal("start"), timeoutSeconds: serviceTimeout }).strict()
const serviceStopPayloadSchema = z.object({ serviceName, action: z.literal("stop"), timeoutSeconds: serviceTimeout }).strict()
const serviceRestartPayloadSchema = z.object({ serviceName, action: z.literal("restart"), timeoutSeconds: serviceTimeout }).strict()
export const manageServiceControlPayloadSchema = z.discriminatedUnion("action", [
  serviceQueryPayloadSchema,
  serviceStartPayloadSchema,
  serviceStopPayloadSchema,
  serviceRestartPayloadSchema,
])
export const manageServicePayloadSchema = z.discriminatedUnion("action", [
  serviceListPayloadSchema,
  serviceQueryPayloadSchema,
  serviceStartPayloadSchema,
  serviceStopPayloadSchema,
  serviceRestartPayloadSchema,
])

const serviceStatusSchema = z.enum([
  "stopped",
  "start-pending",
  "stop-pending",
  "running",
  "continue-pending",
  "pause-pending",
  "paused",
  "unknown",
])
const serviceResourceSchema = z.object({
  cpuPercent: z.number().min(0).max(100).nullable(),
  workingSetBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  privateMemoryBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict()
const serviceListItemSchema = z.object({
  serviceName,
  displayName: z.string().max(256),
  status: serviceStatusSchema,
  processId: z.number().int().positive().nullable(),
  canControl: z.boolean(),
  controlRestriction: z.enum(["not-allowlisted", "agent-self"]).nullable(),
  sharedProcess: z.boolean(),
  sharedServiceCount: z.number().int().min(0),
  resources: serviceResourceSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.canControl !== (value.controlRestriction === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["controlRestriction"], message: "control restriction does not match canControl" })
  }
  if (value.sharedProcess !== (value.sharedServiceCount > 1)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["sharedProcess"], message: "shared process count is inconsistent" })
  }
  if (value.processId === null && (value.sharedServiceCount !== 0 || value.resources !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["processId"], message: "stopped service cannot include process resources" })
  }
  if (value.processId !== null && value.sharedServiceCount < 1) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["sharedServiceCount"], message: "running service must include its host count" })
  }
})
const serviceListResultSchema = z.object({
  action: z.literal("list"),
  capturedAtUtc: z.string().datetime({ offset: true }),
  sampleDurationMs: z.number().int().min(0),
  total: z.number().int().min(0),
  returned: z.number().int().min(0),
  truncated: z.boolean(),
  services: z.array(serviceListItemSchema),
  error: z.string().min(1).max(512).nullable(),
}).strict().superRefine((value, context) => {
  if (value.returned !== value.services.length || value.returned > value.total) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["returned"], message: "returned count is inconsistent" })
  }
  if (value.truncated !== (value.returned < value.total)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["truncated"], message: "truncated flag is inconsistent" })
  }
})
const serviceControlResultSchema = z.object({
  serviceName,
  action: z.enum(["query", "start", "stop", "restart"]),
  initialStatus: serviceStatusSchema,
  finalStatus: serviceStatusSchema,
  durationMs: z.number().int().min(0),
  timedOut: z.boolean(),
  error: z.string().min(1).max(512).nullable(),
}).strict()
export const manageServiceResultSchema = z.union([serviceListResultSchema, serviceControlResultSchema])

export const listProcessesPayloadSchema = z.object({}).strict()
const processResourceSchema = z.object({
  cpuPercent: z.number().min(0).max(100).nullable(),
  workingSetBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  privateMemoryBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict()
const processTerminationRestrictionSchema = z.enum([
  "system",
  "agent-self",
  "path-unavailable",
  "not-allowlisted",
])
const processActionRestrictionSchema = z.enum([
  "system",
  "agent-self",
  "path-unavailable",
  "not-allowlisted",
  "start-time-unavailable",
  "session-unavailable",
  "non-interactive-session",
  "command-line-unavailable",
  "access-denied",
])
const processListItemSchema = z.object({
  processId: z.number().int().positive(),
  processName: z.string().min(1).max(1024),
  executablePath: z.string().min(1).max(32_767).nullable(),
  startedAtUtc: z.string().datetime({ offset: true }).nullable(),
  sessionId: z.number().int().min(0).nullable(),
  canTerminate: z.boolean(),
  terminationRestriction: processTerminationRestrictionSchema.nullable(),
  canRestart: z.boolean(),
  restartRestriction: processActionRestrictionSchema.nullable(),
  efficiencyMode: z.boolean().nullable(),
  canSetEfficiency: z.boolean(),
  efficiencyRestriction: processActionRestrictionSchema.nullable(),
  resources: processResourceSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.canTerminate !== (value.terminationRestriction === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["terminationRestriction"], message: "termination restriction does not match canTerminate" })
  }
  if (value.canTerminate && value.executablePath === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["executablePath"], message: "terminable process must include executablePath" })
  }
  if (value.terminationRestriction === "path-unavailable" && value.executablePath !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["executablePath"], message: "path-unavailable process must not include executablePath" })
  }
  if (value.terminationRestriction === "not-allowlisted" && value.executablePath === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["executablePath"], message: "not-allowlisted process must include executablePath" })
  }
  if (value.terminationRestriction === "system" && value.processId !== 4) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["processId"], message: "system restriction is reserved for PID 4" })
  }
  if (value.canRestart !== (value.restartRestriction === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["restartRestriction"], message: "restart restriction does not match canRestart" })
  }
  if (value.canRestart && (value.executablePath === null || value.startedAtUtc === null || value.sessionId === null || value.sessionId === 0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["canRestart"], message: "restart-capable process identity is incomplete" })
  }
  if (value.canSetEfficiency !== (value.efficiencyRestriction === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["efficiencyRestriction"], message: "efficiency restriction does not match canSetEfficiency" })
  }
  if (value.canSetEfficiency && (value.executablePath === null || value.startedAtUtc === null || value.efficiencyMode === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["canSetEfficiency"], message: "efficiency-capable process identity is incomplete" })
  }
})
export const listProcessesResultSchema = z.object({
  capturedAtUtc: z.string().datetime({ offset: true }),
  sampleDurationMs: z.number().int().min(0),
  total: z.number().int().min(0),
  returned: z.number().int().min(0),
  truncated: z.boolean(),
  processes: z.array(processListItemSchema),
  error: z.string().min(1).max(512).nullable(),
}).strict().superRefine((value, context) => {
  if (value.returned !== value.processes.length || value.returned > value.total) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["returned"], message: "returned count is inconsistent" })
  }
  if (value.truncated !== (value.returned < value.total)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["truncated"], message: "truncated flag is inconsistent" })
  }
})

const terminateProcessPayloadSchema = z.object({
  processId: z.number().int().positive(),
  expectedPath: z.string().min(1).max(32_767),
  expectedStartedAtUtc: z.string().datetime({ offset: true }).optional(),
  timeoutSeconds: z.number().int().min(1).max(120).optional(),
  killProcessTree: z.boolean().optional(),
}).strict()

const processIdentityPayload = {
  processId: z.number().int().positive(),
  expectedPath: z.string().min(1).max(32_767),
  expectedStartedAtUtc: z.string().datetime({ offset: true }),
}
const restartProcessPayloadSchema = z.object({
  ...processIdentityPayload,
  timeoutSeconds: z.number().int().min(1).max(120),
}).strict()
const setProcessEfficiencyPayloadSchema = z.object({
  ...processIdentityPayload,
  enabled: z.boolean(),
}).strict()
const processActionError = z.string().min(1).max(512).nullable()
export const restartProcessResultSchema = z.object({
  originalProcessId: z.number().int().positive(),
  newProcessId: z.number().int().positive().nullable(),
  expectedPath: z.string().min(1).max(32_767),
  expectedStartedAtUtc: z.string().datetime({ offset: true }),
  sessionId: z.number().int().positive().nullable(),
  phase: z.enum(["prepared", "stopped", "launched", "verified", "failed"]),
  stopped: z.boolean(),
  started: z.boolean(),
  durationMs: z.number().int().min(0),
  error: processActionError,
}).strict().superRefine((value, context) => {
  if (value.started !== (value.newProcessId !== null)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["newProcessId"], message: "new PID does not match started" })
  if (value.phase === "verified" && (!value.stopped || !value.started || value.error !== null)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["phase"], message: "verified restart is inconsistent" })
  if (value.phase === "failed" && value.error === null) context.addIssue({ code: z.ZodIssueCode.custom, path: ["error"], message: "failed restart requires error" })
})
const processPrioritySchema = z.enum(["idle", "below-normal", "normal", "above-normal", "high", "real-time"])
export const setProcessEfficiencyResultSchema = z.object({
  processId: z.number().int().positive(),
  expectedPath: z.string().min(1).max(32_767),
  expectedStartedAtUtc: z.string().datetime({ offset: true }),
  requestedEnabled: z.boolean(),
  initialEnabled: z.boolean().nullable(),
  finalEnabled: z.boolean().nullable(),
  originalPriority: processPrioritySchema.nullable(),
  finalPriority: processPrioritySchema.nullable(),
  priorityRestored: z.boolean(),
  durationMs: z.number().int().min(0),
  error: processActionError,
}).strict().superRefine((value, context) => {
  if (value.error === null && value.finalEnabled !== value.requestedEnabled) context.addIssue({ code: z.ZodIssueCode.custom, path: ["finalEnabled"], message: "final efficiency state does not match request" })
  if (value.priorityRestored && (value.requestedEnabled || value.originalPriority === null || value.finalPriority !== value.originalPriority)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["priorityRestored"], message: "priority restoration is inconsistent" })
})

const restartSystemPayloadSchema = z.object({
  delaySeconds: z.number().int().min(0).max(300),
  reason: printable(256).optional(),
}).strict()

const collectLogsPayloadSchema = z.object({
  sources: z.array(z.enum(["agent", "system", "application"])).min(1).max(3),
  sinceUtc: z.string().datetime({ offset: true }),
  untilUtc: z.string().datetime({ offset: true }),
  maxEntries: z.number().int().min(1).max(1000),
}).strict()

export const installPackagePayloadSchema = z.object({
  artifactId: z.string().regex(/^artifact-[a-f0-9]{12}$/),
  fileName: z.string().min(1).max(255),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().positive().max(1024 * 1024 * 1024),
  installerType: z.enum(["msi", "exe"]),
  arguments: z.array(z.string().max(4096)).max(64),
  successExitCodes: z.array(z.number().int().min(0).max(65_535)).min(1).max(32),
  timeoutSeconds: z.number().int().min(60).max(7200),
}).strict().superRefine((value, context) => {
  if (!value.fileName.toLowerCase().endsWith(`.${value.installerType}`)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["fileName"], message: "fileName extension must match installerType" })
  }
  if (new Set(value.successExitCodes).size !== value.successExitCodes.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["successExitCodes"], message: "successExitCodes must be unique" })
  }
})

const windowsDestinationPath = z.string().min(3).max(32_767).refine(
  (value) => /^[A-Za-z]:\\[^\0-\x1f\x7f]*$/.test(value),
  "destinationPath must be an absolute local Windows path",
)

export const deployFilePayloadSchema = z.object({
  artifactId: z.string().regex(/^artifact-[a-f0-9]{12}$/),
  fileName: z.string().min(1).max(255).refine((value) => !/[\\/\0-\x1f\x7f]/.test(value), "fileName is unsafe"),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().positive().max(512 * 1024 * 1024),
  destinationPath: windowsDestinationPath,
  conflictPolicy: z.enum(["fail", "replace"]),
  createDirectories: z.boolean(),
}).strict()

export const rollbackFileDeployPayloadSchema = z.object({
  originalCommandId: z.string().regex(/^cmd-[a-f0-9]{12}$/),
}).strict()

const localAccountName = z.string().min(1).max(20).refine(
  (value) => value === value.trim() && value !== "." && value !== ".." &&
    !/[\0-\x1f\x7f"/\\[\]:;|=,+*?<>@]/.test(value) && !value.endsWith("."),
  "invalid local account name",
)

const localGroupName = z.string().min(1).max(256).refine(
  (value) => value === value.trim() && value !== "." && value !== ".." &&
    !/[\0-\x1f\x7f"/\\[\]:;|=,+*?<>@]/.test(value) && !value.endsWith("."),
  "invalid local group name",
)

const localUserListPayloadSchema = z.object({
  action: z.literal("list"),
  userName: z.null(),
  groupName: z.null(),
}).strict()

const localUserAccountPayloadSchema = z.object({
  action: z.enum(["enable", "disable", "delete"]),
  userName: localAccountName,
  groupName: z.null(),
}).strict()

const localUserGroupPayloadSchema = z.object({
  action: z.enum(["add-to-group", "remove-from-group"]),
  userName: localAccountName,
  groupName: localGroupName,
}).strict()

export const manageLocalUserPayloadSchema = z.discriminatedUnion("action", [
  localUserListPayloadSchema,
  localUserAccountPayloadSchema,
  localUserGroupPayloadSchema,
])

const localUserViewSchema = z.object({
  userName: localAccountName,
  sid: z.string().regex(/^S-1-(?:\d+-)+\d+$/).max(184),
  enabled: z.boolean(),
  builtIn: z.boolean(),
  groups: z.array(localGroupName).max(1024),
}).strict()

const localUserErrorSchema = z.object({
  code: z.string().min(1).max(64).regex(/^[A-Z0-9_]+$/),
  message: z.string().min(1).max(512).refine((value) => !/[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)),
}).strict()

export const manageLocalUserResultSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("list"),
    changed: z.literal(false),
    accounts: z.array(localUserViewSchema).max(4096),
    error: localUserErrorSchema.nullable(),
  }).strict(),
  z.object({
    action: z.enum(["enable", "disable", "delete", "add-to-group", "remove-from-group"]),
    changed: z.boolean(),
    target: localUserViewSchema.nullable(),
    error: localUserErrorSchema.nullable(),
  }).strict(),
])

const registryHive = z.enum(["HKLM", "HKU"])
const registryView = z.enum(["registry32", "registry64"])
const registryValueKind = z.enum(["string", "expandString", "dword", "qword", "multiString", "binary"])
const registrySubKey = z.string().min(1).max(2048).refine(
  (value) => value === value.trim() && !/[\0-\x1f\x7f]/.test(value) &&
    !value.startsWith("\\") && !value.endsWith("\\") && !value.includes("\\\\") &&
    !value.split("\\").some((part) => part === "." || part === ".." || part.length === 0),
  "invalid registry subKey",
)
const registryValueName = z.string().max(255).refine(
  (value) => !/[\0-\x1f\x7f]/.test(value),
  "invalid registry valueName",
)
const registryString = z.string().max(65_536).refine((value) => !/[\0-\x1f\x7f]/.test(value), "invalid registry string")
const registryDword = z.number().int().min(0).max(4_294_967_295)
const registryQword = z.union([
  z.string().regex(/^\d+$/).max(19),
  z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
]).refine((value) => {
  try { return BigInt(value) <= BigInt("9223372036854775807") } catch { return false }
}, "qword is outside the signed 64-bit range")
const registryMultiString = z.array(registryString).max(4096)
const registryBinary = z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/).max(87_384).refine(
  (value) => Buffer.byteLength(Buffer.from(value, "base64")) <= 65_536 && Buffer.from(value, "base64").toString("base64") === value,
  "binary must be canonical base64 and no larger than 64 KiB",
)

const registryListPayloadSchema = z.object({
  action: z.literal("list"), hive: registryHive, view: registryView, subKey: registrySubKey,
  valueName: z.null(), valueKind: z.null(), value: z.null(),
}).strict()
const registryGetDeletePayloadSchema = z.object({
  action: z.enum(["get", "delete"]), hive: registryHive, view: registryView, subKey: registrySubKey,
  valueName: registryValueName, valueKind: z.null(), value: z.null(),
}).strict()
const registrySetPayloadSchema = z.discriminatedUnion("valueKind", [
  z.object({ action: z.literal("set"), hive: registryHive, view: registryView, subKey: registrySubKey, valueName: registryValueName, valueKind: z.literal("string"), value: registryString }).strict(),
  z.object({ action: z.literal("set"), hive: registryHive, view: registryView, subKey: registrySubKey, valueName: registryValueName, valueKind: z.literal("expandString"), value: registryString }).strict(),
  z.object({ action: z.literal("set"), hive: registryHive, view: registryView, subKey: registrySubKey, valueName: registryValueName, valueKind: z.literal("dword"), value: registryDword }).strict(),
  z.object({ action: z.literal("set"), hive: registryHive, view: registryView, subKey: registrySubKey, valueName: registryValueName, valueKind: z.literal("qword"), value: registryQword }).strict(),
  z.object({ action: z.literal("set"), hive: registryHive, view: registryView, subKey: registrySubKey, valueName: registryValueName, valueKind: z.literal("multiString"), value: registryMultiString }).strict(),
  z.object({ action: z.literal("set"), hive: registryHive, view: registryView, subKey: registrySubKey, valueName: registryValueName, valueKind: z.literal("binary"), value: registryBinary }).strict(),
])
export const manageRegistryPayloadSchema = z.union([
  registryListPayloadSchema,
  registryGetDeletePayloadSchema,
  registrySetPayloadSchema,
]).superRefine((value, context) => {
  if (value.action === "set" && Buffer.byteLength(JSON.stringify(value.value), "utf8") > 65_536) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "serialized registry value exceeds 64 KiB" })
  }
})

const registrySize = z.number().int().min(0).max(65_536)
const registryValueSchema = z.discriminatedUnion("valueKind", [
  z.object({ valueName: registryValueName, valueKind: z.literal("string"), value: registryString, sizeBytes: registrySize }).strict(),
  z.object({ valueName: registryValueName, valueKind: z.literal("expandString"), value: registryString, sizeBytes: registrySize }).strict(),
  z.object({ valueName: registryValueName, valueKind: z.literal("dword"), value: registryDword, sizeBytes: z.literal(4) }).strict(),
  z.object({ valueName: registryValueName, valueKind: z.literal("qword"), value: registryQword, sizeBytes: z.literal(8) }).strict(),
  z.object({ valueName: registryValueName, valueKind: z.literal("multiString"), value: registryMultiString, sizeBytes: registrySize }).strict(),
  z.object({ valueName: registryValueName, valueKind: z.literal("binary"), value: registryBinary, sizeBytes: registrySize }).strict(),
]).superRefine((value, context) => {
  if (Buffer.byteLength(JSON.stringify(value.value), "utf8") > 65_536) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["value"], message: "serialized registry value exceeds 64 KiB" })
  }
})
const registryErrorSchema = z.object({
  code: z.string().min(1).max(64).regex(/^[A-Z0-9_]+$/),
  message: z.string().min(1).max(512).refine((value) => !/[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)),
}).strict()
const registryResultBase = {
  hive: registryHive, view: registryView, subKey: registrySubKey,
  changed: z.boolean(), error: registryErrorSchema.nullable(),
}
export const manageRegistryResultSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list"), ...registryResultBase, values: z.array(registryValueSchema).max(4096), previous: z.null(), current: z.null() }).strict(),
  z.object({ action: z.literal("get"), ...registryResultBase, values: z.null(), previous: z.null(), current: registryValueSchema.nullable() }).strict(),
  z.object({ action: z.enum(["set", "delete"]), ...registryResultBase, values: z.null(), previous: registryValueSchema.nullable(), current: registryValueSchema.nullable() }).strict(),
])

const hasUnpairedSurrogate = (value: string) => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
    } else if (code >= 0xdc00 && code <= 0xdfff) return true
  }
  return false
}
const messageText = (maximumScalars: number, multiline: boolean) => z.string().refine(
  (value) => [...value].length >= 1 && [...value].length <= maximumScalars && !hasUnpairedSurrogate(value) &&
    ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0
      return code === 0 || code === 127 || (code < 32 && !(multiline && ["\r", "\n", "\t"].includes(character)))
    }),
  `must contain 1..${maximumScalars} supported Unicode scalars`,
)
export const showMessageRequestPayloadSchema = z.object({
  title: messageText(128, false),
  message: messageText(2000, true),
  severity: z.enum(["info", "warning", "error"]),
  timeoutSeconds: z.number().int().min(5).max(300),
}).strict()
export const showMessageAgentPayloadSchema = showMessageRequestPayloadSchema.extend({
  expiresAt: z.string().datetime({ offset: true }),
}).strict()
const showMessageErrorSchema = z.object({
  code: z.string().min(1).max(64).regex(/^[A-Z0-9_]+$/),
  message: z.string().min(1).max(512).refine((value) => !/[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)),
}).strict()
export const showMessageResultSchema = z.object({
  sessionId: z.number().int().positive().nullable(),
  deliveryStatus: z.enum(["confirmed", "canceled", "timed-out", "expired", "failed"]),
  responseCode: z.number().int().min(0).max(0xffff_ffff).nullable(),
  timedOut: z.boolean(),
  durationMs: z.number().int().min(0),
  error: showMessageErrorSchema.nullable(),
}).strict()

const absoluteHttpUrl = z.string().min(1).max(2048).refine(
  (value) => !/[\u0000-\u001f\u007f]/.test(value),
  "URL must not contain control characters",
).superRefine((value, context) => {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "URL protocol must be http or https" })
    }
    if (parsed.username || parsed.password) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "URL userinfo is not allowed" })
    }
    if (!parsed.hostname) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "URL host is required" })
    }
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "URL must be absolute" })
  }
})

export const openUrlRequestPayloadSchema = z.object({
  url: absoluteHttpUrl,
}).strict()

export const openUrlAgentPayloadSchema = openUrlRequestPayloadSchema.extend({
  expiresAt: z.string().datetime({ offset: true }),
}).strict()

const openUrlErrorSchema = z.object({
  code: z.string().min(1).max(64).regex(/^[A-Z0-9_]+$/),
  message: z.string().min(1).max(512).refine((value) => !/[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)),
}).strict()

export const openUrlResultSchema = z.object({
  sessionId: z.number().int().positive().nullable(),
  processStarted: z.boolean(),
  pid: z.number().int().positive().nullable(),
  durationMs: z.number().int().min(0),
  expired: z.boolean(),
  error: openUrlErrorSchema.nullable(),
}).strict()

export const panelCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("run-shell"), payload: runShellPayloadSchema }).strict(),
  z.object({ type: z.literal("run-program"), payload: runProgramPayloadSchema }).strict(),
  z.object({ type: z.literal("manage-service"), payload: manageServicePayloadSchema }).strict(),
  z.object({ type: z.literal("list-processes"), payload: listProcessesPayloadSchema }).strict(),
  z.object({ type: z.literal("terminate-process"), payload: terminateProcessPayloadSchema }).strict(),
  z.object({ type: z.literal("restart-process"), payload: restartProcessPayloadSchema }).strict(),
  z.object({ type: z.literal("set-process-efficiency"), payload: setProcessEfficiencyPayloadSchema }).strict(),
  z.object({ type: z.literal("restart-system"), payload: restartSystemPayloadSchema }).strict(),
  z.object({ type: z.literal("collect-logs"), payload: collectLogsPayloadSchema }).strict(),
  z.object({ type: z.literal("install-package"), payload: installPackagePayloadSchema }).strict(),
  z.object({ type: z.literal("deploy-file"), payload: deployFilePayloadSchema }).strict(),
  z.object({ type: z.literal("rollback-file-deploy"), payload: rollbackFileDeployPayloadSchema }).strict(),
  z.object({ type: z.literal("manage-local-user"), payload: manageLocalUserPayloadSchema }).strict(),
  z.object({ type: z.literal("manage-registry"), payload: manageRegistryPayloadSchema }).strict(),
  z.object({ type: z.literal("show-message"), payload: showMessageRequestPayloadSchema }).strict(),
  z.object({ type: z.literal("open-url"), payload: openUrlRequestPayloadSchema }).strict(),
])

const clientIds = z.array(z.string().min(1)).min(1).max(100)

export const batchCommandSchema = z.discriminatedUnion("type", [
  z.object({ clientIds, type: z.literal("run-shell"), payload: runShellPayloadSchema }).strict(),
  z.object({ clientIds, type: z.literal("run-program"), payload: runProgramPayloadSchema }).strict(),
  z.object({ clientIds, type: z.literal("manage-service"), payload: manageServiceControlPayloadSchema }).strict(),
  z.object({ clientIds, type: z.literal("terminate-process"), payload: terminateProcessPayloadSchema }).strict(),
  z.object({ clientIds, type: z.literal("restart-system"), payload: restartSystemPayloadSchema }).strict(),
  z.object({ clientIds, type: z.literal("collect-logs"), payload: collectLogsPayloadSchema }).strict(),
  z.object({ clientIds, type: z.literal("show-message"), payload: showMessageRequestPayloadSchema }).strict(),
  z.object({ clientIds, type: z.literal("open-url"), payload: openUrlRequestPayloadSchema }).strict(),
]).superRefine((value, context) => {
  if (new Set(value.clientIds).size !== value.clientIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["clientIds"], message: "clientIds must not contain duplicates" })
  }
})

export type PanelCommandInput = z.infer<typeof panelCommandSchema>

export function commandSupportsClient(type: string, os: string): boolean {
  return !["manage-local-user", "manage-registry", "show-message", "open-url", "list-processes", "restart-process", "set-process-efficiency"].includes(type) || os === "Windows"
}

export function addServerCommandFields(type: string, payload: Record<string, unknown>, now = Date.now()): Record<string, unknown> {
  return type === "show-message" || type === "open-url"
    ? { ...payload, expiresAt: new Date(now + 5 * 60_000).toISOString() }
    : payload
}
