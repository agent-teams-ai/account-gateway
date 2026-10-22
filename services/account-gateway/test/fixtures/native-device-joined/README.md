# Controlled native device enrollment E2E

This fixture joins the production public management SDK, Gateway HTTP facade,
management service and PostgreSQL repositories with the production Go native
admin HTTP routes, connect/device service, SQL repositories, encrypted credential
custody, refresh service and qualified descriptor. Native live owner checks call
the real Node `NativeAuthority` callback. A local TLS provider returns a generated
RSA-signed ID token and controlled device authorization responses.

It proves fresh handoff, pending polling, provider authorization, exactly one
code exchange, verified native descriptor, active Gateway account, duplicate
handoff suppression and foreign owner denial. Final SQL checks verify no
plaintext credentials, retained device material, transient Gateway credentials
or inference requests. It does not claim native launcher isolation, inference
qualification or real OpenAI account authorization.

Use only a dedicated fresh PostgreSQL 17.10 fixture container and random loopback
ports. The harness refuses port5432 and existing Gateway/native schemas. It never
resets populated databases. On failure, preserve that attempt and allocate fresh
purpose-named databases in the same disposable container.

1. Copy `main.go` to `<native-checkout>/backend/tmp/native-device-joined/main.go`.
   From `<native-checkout>/backend`, build it using the existing project Go
   toolchain: `go build -o tmp/native-device-joined/native-device-joined ./tmp/native-device-joined`.
   The native checkout must be clean. The harness records Go's embedded native
   commit and refuses `vcs.modified=true`.
2. Start a dedicated cached `postgres:17.10-alpine` container with trust auth and
   an ephemeral host mapping: `-p 127.0.0.1::5432`. Create two new empty databases
   named `native_device_joined_<run>` and `ag_kernel_test_device_joined_<run>`.
3. From the Gateway repository, run `node services/account-gateway/test/native-device-joined.ts`
   with these environment variables:

   - `AG_NATIVE_DEVICE_JOINED_ALLOW=disposable_pg17_10`
   - `AG_NATIVE_DEVICE_JOINED_NATIVE_DSN=postgres://postgres@127.0.0.1:<port>/native_device_joined_<run>?sslmode=disable`
   - `AG_NATIVE_DEVICE_JOINED_KERNEL_DSN=postgres://postgres@127.0.0.1:<port>/ag_kernel_test_device_joined_<run>?sslmode=disable`
   - `AG_NATIVE_DEVICE_JOINED_BINARY=<native-checkout>/backend/tmp/native-device-joined/native-device-joined`
   - Optional `AG_NATIVE_DEVICE_JOINED_GO` selects the Go executable for reading embedded build metadata.

A successful run emits one safe receipt and writes its JSON under the Gateway
repository's ignored `tmp/native-device-joined-*` directory. The receipt records
exact native/Gateway commits, binary and harness hashes, observed provider counts,
credential cleanup and authorization assertions. Generated credentials remain in
a private mode0600 configuration file in that ignored directory; they authorize
only the terminated disposable native fixture. Remove only your own container
and scratch outputs after retaining the receipt.
