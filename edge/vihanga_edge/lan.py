"""Authenticated, read-only LAN WebSocket fan-out for a single Pi UART.

This service never owns a serial port and never forwards client messages to
the flight controller. It must run behind TLS with an independently provisioned
viewer token. Cloud uplink and LAN viewers consume the *same* verified frames.
"""
from __future__ import annotations

import asyncio
import hmac
import ssl
import time
from collections import Counter
from pathlib import Path

from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

MAX_LAN_VIEWERS = 4
MAX_VIEWER_QUEUE = 48
MAX_FRAME_AGE_SECONDS = 1.5
SEND_TIMEOUT_SECONDS = 2.0


class LanFanout:
    def __init__(self, vehicle_id: str, token: str):
        if len(token) < 32 or any(char.isspace() for char in token):
            raise ValueError("Separate LAN viewer token of >=32 characters is required")
        self.vehicle_id = vehicle_id
        self._token = token
        self.queues: dict[object, asyncio.Queue] = {}
        self.sent_frames = 0
        self.dropped_frames = 0
        self.denied_sessions = 0
        self.source_epoch = 0
        self.counters: Counter[str] = Counter()

    def publish(self, packet: bytes) -> None:
        """Nonblocking distribution; slow viewers cannot delay the FC reader."""
        if not isinstance(packet, bytes) or not 8 <= len(packet) <= 300:
            raise ValueError("Expected one validated MAVLink frame")
        now = time.monotonic()
        for queue in tuple(self.queues.values()):
            if queue.full():
                try:
                    queue.get_nowait()
                    self.dropped_frames += 1
                except asyncio.QueueEmpty:
                    pass
            queue.put_nowait((self.source_epoch, now, packet))

    async def invalidate(self) -> None:
        """Serial failure starts a new epoch; disconnect every stale viewer."""
        self.source_epoch += 1
        for websocket, queue in tuple(self.queues.items()):
            # Revoke the subscription synchronously before waiting on network
            # shutdown; no stale UART epoch can publish into this queue.
            self.queues.pop(websocket, None)
            self.dropped_frames += queue.qsize()
            while not queue.empty():
                queue.get_nowait()
            try:
                await asyncio.wait_for(websocket.close(code=1012), timeout=1)
            except (OSError, RuntimeError, asyncio.TimeoutError):
                pass

    async def viewer(self, websocket) -> None:
        path = websocket.request.path
        token_header = websocket.request.headers.get("authorization", "")
        if path != "/ws/v1/view/" + self.vehicle_id or not (
            token_header.startswith("Bearer ") and
            hmac.compare_digest(token_header[7:], self._token)
        ):
            self.denied_sessions += 1
            await websocket.close(code=4401)
            return
        if len(self.queues) >= MAX_LAN_VIEWERS:
            self.denied_sessions += 1
            await websocket.close(code=1013)
            return
        queue: asyncio.Queue = asyncio.Queue(maxsize=MAX_VIEWER_QUEUE)
        epoch = self.source_epoch
        self.queues[websocket] = queue
        try:
            while True:
                read_task = asyncio.create_task(websocket.recv())
                send_task = asyncio.create_task(queue.get())
                try:
                    done, _ = await asyncio.wait(
                        {read_task, send_task}, timeout=1,
                        return_when=asyncio.FIRST_COMPLETED
                    )
                finally:
                    for task in (read_task, send_task):
                        if not task.done():
                            task.cancel()
                    await asyncio.gather(read_task, send_task, return_exceptions=True)
                if read_task in done:
                    try:
                        read_task.result()
                    except ConnectionClosed:
                        break
                    # Viewer-originated MAVLink frames or application messages
                    # must never become a flight command or UART write.
                    self.counters["viewer_payload_rejected"] += 1
                    await websocket.close(code=1008)
                    break
                if send_task in done:
                    frame_epoch, t0, packet = send_task.result()
                    if frame_epoch != self.source_epoch or frame_epoch != epoch:
                        self.dropped_frames += 1
                        break
                    if time.monotonic() - t0 > MAX_FRAME_AGE_SECONDS:
                        self.dropped_frames += 1
                        continue
                    try:
                        await asyncio.wait_for(websocket.send(packet), SEND_TIMEOUT_SECONDS)
                        self.sent_frames += 1
                    except asyncio.TimeoutError:
                        self.counters["viewer_send_timeout"] += 1
                        await websocket.close(code=1013)
                        break
        except (ConnectionClosed, OSError, RuntimeError):
            pass
        finally:
            self.queues.pop(websocket, None)
            self.dropped_frames += queue.qsize()

    @staticmethod
    def tls_context(cert_path: str, key_path: str) -> ssl.SSLContext:
        for value in (cert_path, key_path):
            if not Path(value).is_absolute() or not Path(value).is_file():
                raise ValueError("LAN TLS certificate and key must be absolute existing files")
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(cert_path, key_path)
        return context

    def server(self, bind_host: str, bind_port: int, context: ssl.SSLContext):
        return serve(
            self.viewer, bind_host, bind_port, ssl=context,
            max_size=1024, max_queue=8, ping_interval=15, ping_timeout=15,
            close_timeout=3, compression=None
        )
