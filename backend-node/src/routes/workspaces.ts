import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import type { AppContext } from '../context.ts'
import { authGuards } from '../plugins/auth.ts'
import { listWorkspacesFor } from '../services/workspaces.ts'
import { workspaceReadSchema } from './schemas.ts'

export function workspaceRoutes(ctx: AppContext) {
  return async (app: FastifyInstance): Promise<void> => {
    const typed = app.withTypeProvider<ZodTypeProvider>()
    const { requireUser } = authGuards(ctx)

    typed.get(
      '/api/workspaces',
      { schema: { response: { 200: z.array(workspaceReadSchema) } }, preValidation: [requireUser] },
      async (request) => {
        const items = await listWorkspacesFor(ctx.db, request.user.id)
        return items.map(({ workspace, role }) => ({
          id: workspace.id,
          name: workspace.name,
          is_archived: workspace.isArchived,
          locale: workspace.locale,
          timezone: workspace.timezone,
          icon: workspace.icon,
          color: workspace.color,
          created_at: workspace.createdAt.toISOString(),
          created_by_user_id: workspace.createdByUserId,
          managed_by_user_id: workspace.managedByUserId,
          role,
        }))
      },
    )
  }
}
