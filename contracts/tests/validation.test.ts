import { beforeAll, describe, expect, it } from 'vitest'
import { resetData } from './support/db'
import { type Api, type Reply, bootstrapAdmin, registerUser, subject } from './support/http'

interface Operation {
  name: string
  slice: string
  call: (api: Api, tokens: { admin: string; user: string; userId: string }) => Promise<Reply>
}

// Every operation of the contract that takes a request body, with a body that cannot be valid.
// The table grows with the slices: the operations of a slice are added in the batch that builds it.
const OPERATIONS: Operation[] = [
  { name: 'POST /api/auth/forgot-password', slice: 'S2', call: (a) => a.post('/api/auth/forgot-password', { json: {} }) },
  { name: 'POST /api/auth/login', slice: 'S2', call: (a) => a.post('/api/auth/login', { form: {} }) },
  { name: 'POST /api/auth/register', slice: 'S2', call: (a) => a.post('/api/auth/register', { json: { email: 'bad' } }) },
  { name: 'POST /api/auth/reset-password', slice: 'S2', call: (a) => a.post('/api/auth/reset-password', { json: {} }) },
  { name: 'POST /api/setup/create-admin', slice: 'S2', call: (a) => a.post('/api/setup/create-admin', { json: { email: 'bad' } }) },
  { name: 'PATCH /api/users/me', slice: 'S2', call: (a, t) => a.patch('/api/users/me', { token: t.user, json: { email: 12 } }) },
  {
    name: 'PATCH /api/users/{id}',
    slice: 'S2',
    call: (a, t) => a.patch(`/api/users/${t.userId}`, { token: t.admin, json: { is_active: 'nope' } }),
  },
]

describe('request validation', () => {
  let tokens: { admin: string; user: string; userId: string }

  beforeAll(async () => {
    await resetData()
    const api = subject()
    const admin = await bootstrapAdmin(api)
    const user = await registerUser(api)
    tokens = { admin: admin.token, user: user.token, userId: user.id }
  })

  it.each(OPERATIONS)('C16 invalid body is 422 in FastAPI shape: $name', async ({ call }) => {
    const reply = await call(subject(), tokens)
    expect(reply.status).toBe(422)
    expect(Array.isArray(reply.json.detail)).toBe(true)
    expect(reply.json.detail.length).toBeGreaterThan(0)
    for (const item of reply.json.detail) {
      expect(item.loc[0]).toBe('body')
      expect(typeof item.msg).toBe('string')
      expect(typeof item.type).toBe('string')
    }
  })
})
