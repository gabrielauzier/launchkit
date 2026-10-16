import { describe, expect, it, vi } from 'vitest'
import { trustedHandle, type IpcLike } from './ipc'

function fakeIpc() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const ipc: IpcLike = { handle: (channel, listener) => void handlers.set(channel, listener as never) }
  return { ipc, call: (channel: string, event: unknown, ...args: unknown[]) => handlers.get(channel)!(event, ...args) }
}

describe('trusted ipc handlers', () => {
  it('rejects calls from untrusted frames without running the handler', async () => {
    const { ipc, call } = fakeIpc()
    const handler = vi.fn(() => 'secret')
    trustedHandle(ipc, 'server:get-url', handler)
    const untrusted = [
      { senderFrame: { url: 'https://evil.example/' } },
      { senderFrame: { url: 'file:///etc/passwd' } },
      { senderFrame: { url: 'app://launchkit.evil.example/' } },
      { senderFrame: { url: 'app://other/' } },
      { senderFrame: null },
      {},
    ]
    for (const event of untrusted) {
      await expect(Promise.resolve().then(() => call('server:get-url', event)), JSON.stringify(event)).rejects.toThrow(/untrusted/i)
    }
    expect(handler).not.toHaveBeenCalled()
  })

  it('runs the handler for frames served from app://launchkit/', async () => {
    const { ipc, call } = fakeIpc()
    const handler = vi.fn((_event: unknown, url: string) => `got ${url}`)
    trustedHandle(ipc, 'server:set-url', handler)
    const event = { senderFrame: { url: 'app://launchkit/connect' } }
    await expect(Promise.resolve(call('server:set-url', event, 'https://srv.example.com'))).resolves.toBe('got https://srv.example.com')
    expect(handler).toHaveBeenCalledTimes(1)
  })
})
