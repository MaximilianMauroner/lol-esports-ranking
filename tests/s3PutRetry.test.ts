import assert from 'node:assert/strict'
import test from 'node:test'
import { isRetryableS3Error, sendPutWithRetry } from '../scripts/s3-put-retry.mjs'

test('streaming S3 puts create a fresh body after SlowDown', async () => {
  const bodies: object[] = []
  const commands: object[] = []
  const delays: number[] = []
  const client = {
    send: async (command: object) => {
      commands.push(command)
      if (commands.length === 1) throw Object.assign(new Error('busy'), { name: 'SlowDown' })
      return { ETag: 'ok' }
    },
  }

  const result = await sendPutWithRetry({
    client,
    body: () => {
      const value = {}
      bodies.push(value)
      return value
    },
    command: (body) => ({ body }),
    sleep: async (delayMs) => { delays.push(delayMs) },
    random: () => 0,
  })

  assert.deepEqual(result, { ETag: 'ok' })
  assert.equal(commands.length, 2)
  assert.equal(bodies.length, 2)
  assert.notEqual(bodies[0], bodies[1])
  assert.deepEqual(delays, [375])
})

test('S3 put retry rejects hard client errors without sleeping', async () => {
  let attempts = 0
  let slept = false
  const failure = Object.assign(new Error('forbidden'), {
    name: 'AccessDenied',
    $metadata: { httpStatusCode: 403 },
  })

  await assert.rejects(sendPutWithRetry({
    client: { send: async () => { attempts += 1; throw failure } },
    body: () => Buffer.from('body'),
    command: (body) => ({ body }),
    sleep: async () => { slept = true },
  }), failure)

  assert.equal(attempts, 1)
  assert.equal(slept, false)
})

test('S3 retry classification covers throttling and server errors', () => {
  assert.equal(isRetryableS3Error({ name: 'SlowDown' }), true)
  assert.equal(isRetryableS3Error({ $metadata: { httpStatusCode: 503 } }), true)
  assert.equal(isRetryableS3Error({ $metadata: { httpStatusCode: 429 } }), true)
  assert.equal(isRetryableS3Error({ name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } }), false)
})
