"""Exercise actual Chromium pointer events and WebGL vertex rendering over two surveys."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from shutil import which
from threading import Thread

from PIL import Image
from playwright.sync_api import expect, sync_playwright


pending_saves = []


def api(route):
    path = route.request.url.split("/api/v1/")[-1]
    if path == "health":
        data = {"service": "vihanga-standalone", "status": "ok"}
    elif path == "station/session":
        data = {"required": False, "username": None, "role": None}
    elif path == "vehicles":
        data = [{"vehicle_id": "BENCH-1", "label": "Bench", "autopilot": "ARDUPILOT", "interface": "UART",
                 "created_at": "2026-01-01T00:00:00Z", "link_state": "OFFLINE", "control_authorized": False}]
    elif path == "missions" and route.request.method == "POST":
        pending_saves.append(route)
        return
    elif path.endswith("/preview"):
        polygon = route.request.post_data_json["polygon"]
        data = {"polygon": polygon, "waypoints": [dict(p, altitude_m=35) for p in polygon],
                "pattern": "PARALLEL", "area_m2": 100, "route_distance_m": 50,
                "estimated_duration_s": 10, "lane_count": 2, "status": "PREVIEW_ONLY"}
    elif path.startswith("flight-tracks/"):
        data = {"points": [], "count": 0}
    elif path == "fleet/telemetry":
        data = {}
    elif path == "missions":
        data = []
    else:
        route.fulfill(status=404, json={"detail": "Unavailable"})
        return
    route.fulfill(json=data)


def check(page):
    page.route("**/api/v1/**", api)
    page.add_init_script("localStorage.setItem('vihanga.station.basemap', 'grid')")
    page.goto(f"http://127.0.0.1:{server.server_port}")
    page.get_by_role("button", name="PLAN", exact=True).click()
    page.get_by_role("button", name="Survey", exact=True).click()
    canvas = page.locator(".maplibregl-canvas")
    expect(canvas).to_be_visible()
    box = canvas.bounding_box()
    count = page.get_by_text("Boundary vertices", exact=True).locator("..").locator("strong")
    for cycle in range(2):
        for index, (x, y) in enumerate([(0.56, 0.44), (0.72, 0.68), (0.82, 0.38)], 1):
            px, py = int(box["x"] + box["width"] * x), int(box["y"] + box["height"] * y)
            page.mouse.click(px, py)
            expect(count).to_have_text(str(index))
            if index == 1:
                # Check the actual cream boundary handle at the cursor on the offline base.
                for attempt in range(20):
                    image = Image.open(BytesIO(page.screenshot(clip={"x":px-4,"y":py-4,"width":9,"height":9}))).convert("RGB")
                    if any(abs(r-247)+abs(g-233)+abs(b-205)<36 for r,g,b in image.getdata()):
                        break
                    page.wait_for_timeout(100)
                else:
                    raise AssertionError(f"Boundary vertex accepted but invisible in survey {cycle+1}")
        page.get_by_role("button", name="Generate coverage route").click()
        expect(page.get_by_role("button", name="Clear waypoints")).to_be_enabled()
        if cycle == 1:
            page.get_by_label("Mission name").fill("First survey draft")
            with page.expect_request(lambda req: req.method == "POST" and req.url.endswith("/missions")):
                page.get_by_role("button", name="Save mission draft").click()
        page.get_by_role("button", name="Reset", exact=True).click()
        expect(count).to_have_text("0")
        if cycle == 1:
            page.mouse.click(px, py)
            expect(count).to_have_text("1")
            request = pending_saves.pop()
            request.fulfill(json={**request.request.post_data_json, "mission_id":"test", "revision_sha256":"abc123",
                                  "created_at":"2026-01-01T00:00:00Z", "distance_m":10, "status":"DRAFT_ONLY"})
            page.mouse.click(px - 80, py + 80)
            expect(count).to_have_text("2")


with ThreadingHTTPServer(("127.0.0.1", 0), partial(SimpleHTTPRequestHandler, directory="console/dist")) as server:
    Thread(target=server.serve_forever, daemon=True).start()
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=which("google-chrome"), args=[
            "--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        check(browser.new_page(viewport={"width": 1600, "height": 1000}, reduced_motion="reduce"))
        browser.close()
