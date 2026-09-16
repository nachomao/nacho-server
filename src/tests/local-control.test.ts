import assert from "node:assert/strict"
import { test } from "node:test"
import { authorizeLocalControl, isLoopbackAddress } from "../lib/local-control"

test("loopback detection accepts local Node socket formats only", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true)
  assert.equal(isLoopbackAddress("127.25.10.2"), true)
  assert.equal(isLoopbackAddress("::1"), true)
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true)
  assert.equal(isLoopbackAddress("192.168.1.10"), false)
  assert.equal(isLoopbackAddress("::ffff:192.168.1.10"), false)
  assert.equal(isLoopbackAddress(undefined), false)
})

test("local control authorization requires loopback and an exact token", () => {
  const configuredToken = "a-random-local-control-token"
  assert.equal(
    authorizeLocalControl({ configuredToken, providedToken: configuredToken, remoteAddress: "::1" }),
    true,
  )
  assert.equal(
    authorizeLocalControl({ configuredToken, providedToken: "wrong", remoteAddress: "::1" }),
    false,
  )
  assert.equal(
    authorizeLocalControl({ configuredToken, providedToken: configuredToken, remoteAddress: "10.0.0.2" }),
    false,
  )
  assert.equal(
    authorizeLocalControl({ configuredToken: "", providedToken: configuredToken, remoteAddress: "127.0.0.1" }),
    false,
  )
})
