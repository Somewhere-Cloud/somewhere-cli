/** Fixed platform text for completion telemetry that deliberately stores codes only. */
export const ROLE_CHANGE_METHOD_MESSAGE = 'Role changes require POST, PUT, PATCH or DELETE when signed in by cookie; move setRoles/grantRole/revokeRole to a POST setup handler.';
export function runtimeRefusalMessage(code: string | null | undefined): string | undefined {
  return code === 'ROLE_CHANGE_METHOD_NOT_ALLOWED' ? ROLE_CHANGE_METHOD_MESSAGE : undefined;
}
