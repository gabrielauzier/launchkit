import { z } from 'zod'

/** UserRead of the Python API. */
export const userReadSchema = z.object({
  id: z.string(),
  email: z.string(),
  is_active: z.boolean(),
  is_superuser: z.boolean(),
  is_verified: z.boolean(),
  preferences: z.record(z.string(), z.unknown()).nullable(),
  is_2fa_enabled: z.boolean(),
})

/** WorkspaceRead of the Python API. */
export const workspaceReadSchema = z.object({
  id: z.string(),
  name: z.string(),
  is_archived: z.boolean(),
  locale: z.string().nullable(),
  timezone: z.string().nullable(),
  icon: z.string().nullable(),
  color: z.string().nullable(),
  created_at: z.string(),
  created_by_user_id: z.string().nullable(),
  managed_by_user_id: z.string().nullable(),
  role: z.string().nullable(),
})
