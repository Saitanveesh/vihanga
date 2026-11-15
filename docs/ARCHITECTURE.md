# Vihanga architecture and qualification boundary

**Baseline:** independent Vihanga v0.11, 15 November 2026. The current executable ground station is built from React/TypeScript and a local Python API. It has no runtime dependency on Mission Planner, and this repository does not contain a physical flight-control writer.

## Implemented read-only telemetry path

~~~text
Flight controller --MAVLink2 serial--> Raspberry Pi edge
           (UART owner, validation, local serial lock)
                                      |
                                      | outbound authenticated WSS
                                      v
                     Vihanga cloud telemetry broker
                    (per-aircraft and per-role tokens,
                     CRC/SYSID checks, bounded queues)
                                      |
                                      | authenticated viewer WSS
                                      v
                      Local Vihanga Python operations API
                     (freshness, attitude/GPS projection,
                      per-vehicle sessions, observed tracks)
                                      |
                                      | REST + live WebSocket
                                      v
                       React/TypeScript GCS (MapLibre)
~~~

The cloud broker does not support commands. Every edge agent is strictly receive-only on serial; the cloud WebSocket viewer cannot send a MAVLink message back to the Pi. The GCS also supports local UDP SITL and receive-only serial/TCP links, plus a separate connector to the earlier Oracle private relay.

## Separate protocol components (not connected to the above)

- **Supervised SITL authority:** one pilot lease per vehicle, command sequence validation, bounded expiry, MAVLink command serialization, FC COMMAND_ACK processing and independently observed post-ACK effects. The last observation must be fresh and newer than the ACK; an ACK alone never proves execution.
- **Mission protocol state machine:** deterministic waypoint revision, MISSION_ITEM_INT transfer, bounded retry count, rejection on wrong FC identity and verified item-by-item readback. Readback is not evidence of mission execution.

These components are libraries used by tests. They do not create an API command endpoint, broker downlink or edge serial writer. The README capability matrix is the source of truth for operator-facing features.

## Identity and trust boundaries

1. Each aircraft has an explicit ID, verified expected MAVLink SYSID, organization and independent device/viewer credentials. Reused token digests across roles or aircraft fail configuration.
2. MAVLink CRC and SYSID/component checks provide corruption and basic message provenance checks, **not** cryptographic authenticity. TLS, device token custody, a private gateway and an independently hardened operator identity provider are required.
3. The local GCS API is a development service with no application login. Never expose its loopback ports to an untrusted network.
4. A receiver connection is not equivalent to fresh aircraft telemetry. LIVE needs fresh FC HEARTBEAT and ATTITUDE; coordinates are never published from a position received without a valid GPS fix.
5. Transport reconnection starts a new viewer state. Data are not replayed as fresh across device or local GCS connection epochs.
6. Camera access is separate from FC telemetry; neither path implies command authority.

## CI evidence versus release acceptance

| Gate | Current evidence | Unverified requirement |
| --- | --- | --- |
| Per-aircraft device/viewer boundaries | Cloud ACL + credential uniqueness tests | Production OIDC/MFA, credential rotation, revocation and audit |
| Frame integrity and freshness | Edge gate, broker CRC, local projector and cross-service integration CI | Real Pi UART, TLS gateway and authenticated backend network soak |
| Operator interface | TypeScript bundle and API tests | Real on-screen QA, accessibility and performance |
| Mission draft and protocol | Unit tests including exact FC readback | Field mission planner safety review, HIL, geofence/terrain clearance |
| Simulated command lifecycle | Lease, timeout, anti-replay, FC ACK + effect tests | True SITL command transport, fault injection, operator controls |
| Physical flight control | None | Independent safety assessment and staged HIL/bench/field acceptance |
| Fleet scale | 12 provisioned identities tested | 12 *simultaneous live* vehicles under representative loads |
| Staging | Docker Compose validated in GitHub Actions | Dedicated private VM deployment, TLS and monitoring |

Protocol integration tests use encoded MAVLink2 bytes with real FastAPI WebSocket sessions, but the GCS projector is attached in-process. This is not a substitute for an independent e2e test over actual network endpoints.

## Qualification sequence

1. Local protocol regression, failure injection and executable UI smoke tests.
2. Real simulator (ArduPilot SITL) with controlled duplex transport, lease expiry, ACK and effect assertions.
3. Private staging broker, Pi physical UART read-only acceptance and measured 24-hour endurance.
4. Physically separated HIL and propeller-free authorization testing, with RC/manual override precedence and deterministic link-loss behavior.
5. Site-approved range trial, explicit checklists, audit records and controlled release.

Do not put cloud round-trip latency into flight stabilization, attitude control, emergency response or collision avoidance loops. In particular, a successful command ACK must not be treated as verified state transition.
