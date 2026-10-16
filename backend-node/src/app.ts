import cors from '@fastify/cors'
import formbody from '@fastify/formbody'
import swagger from '@fastify/swagger'
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify'
import { jsonSchemaTransform, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import type { AppContext } from './context.ts'
import { decorateRequest } from './plugins/auth.ts'
import { registerErrorHandling } from './plugins/errors.ts'
import { authRoutes } from './routes/auth.ts'
import { healthRoutes } from './routes/health.ts'
import { setupRoutes } from './routes/setup.ts'
import { userRoutes } from './routes/users.ts'
import { workspaceRoutes } from './routes/workspaces.ts'

/** The one place the application is assembled: `server.ts` and the tests both call it. */
export async function buildApp(ctx: AppContext, options: FastifyServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ ...options })
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)

  await app.register(swagger, {
    openapi: { info: { title: ctx.config.appName, version: '0.1.0' } },
    transform: jsonSchemaTransform,
  })
  await app.register(formbody)
  await app.register(cors, {
    origin: [ctx.config.frontendUrl],
    credentials: true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  })

  decorateRequest(app)
  registerErrorHandling(app)

  await app.register(healthRoutes)
  await app.register(authRoutes(ctx))
  await app.register(userRoutes(ctx))
  await app.register(setupRoutes(ctx))
  await app.register(workspaceRoutes(ctx))

  app.get('/api/openapi.json', { schema: { hide: true } }, async () => app.swagger())

  await app.ready()
  return app
}
