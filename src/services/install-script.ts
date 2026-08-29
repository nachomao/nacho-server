import type { InstallProfile } from "./install-profiles"

export function stripScriptBom(value: string): string {
  return value.replace(/^\uFEFF/, "")
}

function psString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function psNullableString(value: string | null): string {
  return value === null ? "$null" : psString(value)
}

function psStringArray(values: string[]): string {
  return `@(${values.map(psString).join(", ")})`
}

export function renderInstallScript(
  template: string,
  input: {
    artifactBaseUrl: string
    installScriptUrl: string
    openEnrollment: boolean
    profile: InstallProfile
  },
): string {
  const agentServerUrl = input.profile.agentServerUrl || input.artifactBaseUrl
  const replacements: Record<string, string> = {
    __NACHO_ARTIFACT_BASE_URL__: psString(input.artifactBaseUrl),
    __NACHO_AGENT_SERVER_URL__: psString(agentServerUrl),
    __NACHO_INSTALL_SCRIPT_URL__: psString(input.installScriptUrl),
    __NACHO_OPEN_ENROLLMENT__: input.openEnrollment ? "$true" : "$false",
    __NACHO_PROFILE_ID__: psString(input.profile.id),
    __NACHO_PROFILE_REVISION__: String(input.profile.activeRevision),
    __NACHO_PROFILE_RUN_MODE__: psString(input.profile.runMode),
    __NACHO_PROFILE_HEARTBEAT_SECONDS__: String(input.profile.heartbeatSeconds),
    __NACHO_PROFILE_POLL_SECONDS__: String(input.profile.pollSeconds),
    __NACHO_PROFILE_CLIENT_NAME__: psNullableString(input.profile.clientName),
    __NACHO_PROFILE_GROUP__: psString(input.profile.group),
    __NACHO_PROFILE_TAGS__: psStringArray(input.profile.tags),
    __NACHO_PROFILE_OVERWRITE_EXISTING__: input.profile.overwriteExisting ? "$true" : "$false",
    __NACHO_PROFILE_REENROLL__: input.profile.reEnrollOnServerChange ? "$true" : "$false",
  }
  let output = template
  for (const [placeholder, value] of Object.entries(replacements)) output = output.replaceAll(placeholder, value)
  const unresolved = output.match(/__NACHO_[A-Z0-9_]+__/g)
  if (unresolved) throw new Error(`安装脚本存在未替换占位符：${[...new Set(unresolved)].join(", ")}`)
  return output
}
